import type { VehicleSession } from '@roshai/shared';
import { prisma } from './prisma-client.js';
import { logger } from './logger.js';

// Durable counterpart to vehicle-registry.ts's in-memory Map — kept in a
// separate file rather than folded into that module, which is explicitly
// documented as "deliberately in-memory" with synchronous functions.
//
// recordSessionHistory (fires on session-end) and attachReportToHistory
// (fires on report upload) are independent async writers for the *same*
// logical row that can arrive in either order — a bot can upload its
// report before or after sending stop-event. Both use upsert() keyed on
// the composite (vin, macId, sessionId) unique constraint rather than
// create()/updateMany(): Postgres/Prisma compile upsert to a single
// atomic `INSERT ... ON CONFLICT (vin, "macId", "sessionId") DO UPDATE`,
// so whichever writer arrives first creates the row and the second one
// merges its own fields in — correct regardless of ordering, with no
// manual locking needed. sessionId alone was the original (buggy) key —
// not globally unique, since a bot's own session counter can repeat
// across different vehicles it's fitted to, and different bots fitted to
// the same vehicle can each report "session 1" (see
// vehicle-registry.ts's matching in-memory fix). A naive
// create()+updateMany() design has
// a real data-loss window here: if the report attaches in-memory between
// recordSessionHistory reading the session and its write committing,
// attachReportToHistory's updateMany (racing concurrently) would find no
// row yet, no-op, and silently drop the report from history forever.
// This is why AdminActionAudit's simple prisma.create() precedent doesn't
// apply directly — that table never has a second writer touching the
// same row.

// Called once, right after a session transitions to 'ended' (see the
// three endActiveSession call sites in index.ts). Snapshots whatever the
// in-memory session looked like at that instant, including .report if a
// report already attached before the session ended. Fire-and-forget from
// the caller's perspective, matching recordAdminAction's pattern — a DB
// hiccup here must never affect the live grid or block a broadcast.
export async function recordSessionHistory(session: VehicleSession): Promise<void> {
  try {
    await prisma.vehicleSessionHistory.upsert({
      where: {
        vin_macId_sessionId: {
          vin: session.vin,
          macId: session.macId,
          sessionId: session.sessionId
        }
      },
      create: {
        vin: session.vin,
        macId: session.macId,
        sessionId: session.sessionId,
        startedAt: new Date(session.startedAt),
        endedAt: new Date(),
        stopCause: session.stopCause ?? null,
        reportSizeBytes: session.report?.sizeBytes ?? null,
        reportUploadedAt: session.report ? new Date(session.report.uploadedAt) : null
      },
      update: {
        vin: session.vin,
        macId: session.macId,
        startedAt: new Date(session.startedAt),
        endedAt: new Date(),
        stopCause: session.stopCause ?? null,
        // Only included when known — omitting these keys (rather than
        // writing null) preserves report data an earlier
        // attachReportToHistory call may have already backfilled.
        ...(session.report
          ? {
              reportSizeBytes: session.report.sizeBytes,
              reportUploadedAt: new Date(session.report.uploadedAt)
            }
          : {})
      }
    });
  } catch (err) {
    logger.error(
      { err, vin: session.vin, sessionId: session.sessionId },
      'failed to write session history record'
    );
  }
}

// Called from the report-upload handler after attachReportToSession
// succeeds — covers the race where the report attaches *after* the
// session already ended (history row already exists, needs its report
// fields backfilled) as well as before (creates a partial row that
// recordSessionHistory later fills in). Also fire-and-forget.
//
// macId must be the raw value resolved from the in-memory registry (see
// reports-route.ts's rawMacId) — never the 'unknown-bot' MinIO-storage-
// key fallback string, which is a key-naming concern only and must not
// leak into this table as a fake macId.
//
// Deliberately requires a real macId (not `string | null`), even though
// the VehicleSessionHistory.macId *column* stays nullable for the rare
// detached-report case (no matching in-memory session found at all —
// see the schema's own comment). That's not a contradiction: Prisma's
// generated compound-unique `where` input type for a multi-field
// `@@unique` doesn't accept `null` for one of its fields even though the
// column itself is nullable, so a null macId here can't go through
// upsert's `where: { vin_macId_sessionId: {...} } }` shorthand at all.
// Rather than hand-rolling a separate findFirst+create/update path for
// that one rare edge case, the caller (reports-route.ts) simply skips
// this durable-history backfill when no macId could be resolved — the
// PDF bytes are still safely uploaded either way, just not tracked in
// this queryable table for that specific edge case.
export async function attachReportToHistory(
  vin: string,
  sessionId: string,
  macId: string,
  report: { sizeBytes: number; uploadedAt: string }
): Promise<void> {
  try {
    await prisma.vehicleSessionHistory.upsert({
      where: { vin_macId_sessionId: { vin, macId, sessionId } },
      create: {
        vin,
        macId,
        sessionId,
        reportSizeBytes: report.sizeBytes,
        reportUploadedAt: new Date(report.uploadedAt)
      },
      update: {
        reportSizeBytes: report.sizeBytes,
        reportUploadedAt: new Date(report.uploadedAt)
      }
    });
  } catch (err) {
    logger.error(
      { err, vin, sessionId, macId },
      'failed to backfill report metadata onto session history'
    );
  }
}

// Used by the report download route's fallback path once the in-memory
// registry no longer has the session (cleared, or backend restarted).
// Return shape matches SessionReport exactly (incl. sessionId) so callers
// can assign this directly into the same variable getSessionReport()
// populates. Returns null unless a report was actually recorded, not
// just that a history row exists for this session.
export async function getHistoricalReport(
  vin: string,
  sessionId: string
): Promise<{
  sessionId: string;
  macId: string | null;
  sizeBytes: number;
  uploadedAt: string;
} | null> {
  // findMany, not findFirst — vin+sessionId alone is ambiguous whenever
  // the same vehicle has been fitted with more than one bot over time
  // (see vehicle-registry.ts's matching findSessionForVinAndSessionId,
  // which this mirrors). findFirst can't tell us whether it silently
  // picked among duplicates; findMany lets us log when that happens.
  // Postgres sorts NULL last in DESC, so a partial row with no startedAt
  // yet (report arrived before recordSessionHistory ran) correctly sorts
  // after any row that actually has a start time.
  const rows = await prisma.vehicleSessionHistory.findMany({
    where: { vin, sessionId, reportSizeBytes: { not: null }, reportUploadedAt: { not: null } },
    orderBy: { startedAt: 'desc' }
  });
  if (rows.length > 1) {
    logger.warn(
      { vin, sessionId, matchCount: rows.length },
      'ambiguous vin+sessionId match for historical report lookup — using most recently started'
    );
  }
  const row = rows[0];
  if (!row || row.reportSizeBytes == null || !row.reportUploadedAt) return null;
  return {
    sessionId: row.sessionId,
    macId: row.macId,
    sizeBytes: row.reportSizeBytes,
    uploadedAt: row.reportUploadedAt.toISOString()
  };
}

export interface SessionHistoryRecord {
  id: string;
  vin: string;
  macId: string | null;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  stopCause: string | null;
  report: { sizeBytes: number; uploadedAt: string } | null;
}

// Plain offset/limit pagination — no cursor, not warranted at this
// project's current single-vehicle/small-fleet scale. Always filters to
// endedAt IS NOT NULL so a report-arrived-first transient partial row
// (see module comment above) never surfaces in the user-facing list
// before its session has actually ended. findMany + count run inside one
// transaction so `total` can't drift from `items` if a write lands
// between the two queries.
export async function listSessionHistory(params: {
  limit: number;
  offset: number;
  vin?: string;
}): Promise<{ items: SessionHistoryRecord[]; total: number }> {
  const where = { endedAt: { not: null }, ...(params.vin ? { vin: params.vin } : {}) };
  const [rows, total] = await prisma.$transaction([
    prisma.vehicleSessionHistory.findMany({
      where,
      orderBy: { endedAt: 'desc' },
      skip: params.offset,
      take: params.limit
    }),
    prisma.vehicleSessionHistory.count({ where })
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      vin: r.vin,
      macId: r.macId,
      sessionId: r.sessionId,
      // Non-null assertions safe here: the endedAt-not-null filter above
      // guarantees both (recordSessionHistory always sets startedAt in
      // the same write that sets endedAt).
      startedAt: r.startedAt!.toISOString(),
      endedAt: r.endedAt!.toISOString(),
      stopCause: r.stopCause,
      report:
        r.reportSizeBytes != null && r.reportUploadedAt
          ? { sizeBytes: r.reportSizeBytes, uploadedAt: r.reportUploadedAt.toISOString() }
          : null
    })),
    total
  };
}
