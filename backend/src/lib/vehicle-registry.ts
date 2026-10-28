import type { StopEventPayload, VehicleSession } from '@roshai/shared';
import { logger } from './logger.js';

// Deliberately in-memory, not Postgres — display convenience for the
// vehicle discovery grid, same rationale as telemetry-enrichment.ts's
// lastKnownMacByVin. Resets on backend restart; session history is lost
// across restarts/redeploys. Revisit if that trade-off stops being
// acceptable (a real persisted test-run history would need a DB model).
//
// Keyed by a composite of (macId, vin, sessionId), not sessionId alone —
// sessionId is NOT guaranteed globally unique: a bot's own session
// counter can repeat across different vehicles it's fitted to over time,
// and two different bots fitted to the same vehicle can each report
// "session 1". Keying by sessionId alone (or (vin, sessionId) alone) can
// silently collide and overwrite a different real test run's record —
// this was always a latent bug, just never exposed while there was only
// ever one bot and one vehicle. See VehicleSession.compositeId (the same
// value used as the map key here, also sent over the wire).
const sessions = new Map<string, VehicleSession>();

function sessionKey(macId: string, vin: string, sessionId: string): string {
  // JSON.stringify of the tuple rather than a delimited string — avoids
  // having to pick a separator that can't collide with characters already
  // inside a macId (which is itself colon-separated) or vin.
  return JSON.stringify([macId, vin, sessionId]);
}

// macId is mandatory here (not `string | undefined`) — mqtt-client.ts's
// handleHandshakeRequest already rejects a session-start payload missing
// it before this is ever called, so there's no null/undefined case left
// to normalize.
export function registerVehicleSession(
  vin: string,
  macId: string,
  sessionId: string
): VehicleSession {
  const compositeId = sessionKey(macId, vin, sessionId);
  const session: VehicleSession = {
    compositeId,
    vin,
    macId,
    sessionId,
    startedAt: new Date().toISOString(),
    status: 'active'
  };
  sessions.set(compositeId, session);
  return session;
}

// A vehicle can only be driving one session at a time, so there's at most
// one active entry per vin — shared by endActiveSession below and by
// video-control-service.ts (a VideoControlCommand needs the active
// session's id; no active session means nothing to start video for).
export function getActiveSession(vin: string): VehicleSession | undefined {
  for (const session of sessions.values()) {
    if (session.vin === vin && session.status === 'active') return session;
  }
  return undefined;
}

// stop-event/session-end payloads don't carry a sessionId, so we end
// whichever session is currently active for that vin. `cause` is only
// ever supplied by the stop-event path (index.ts) — the plain
// session-end path has no cause to give, so it's left undefined there,
// matching VehicleSession['stopCause'] being optional.
export function endActiveSession(
  vin: string,
  cause?: StopEventPayload['cause']
): VehicleSession | undefined {
  const session = getActiveSession(vin);
  if (!session) return undefined;
  session.status = 'ended';
  if (cause) session.stopCause = cause;
  return session;
}

// Updated on every telemetry receipt for a vin's active session (see
// index.ts's onMessage) — the basis for the stale-session watchdog below.
// A no-op if there's no active session for this vin, which is also what
// keeps this safe against silently "resurrecting" a lost-contact session:
// getActiveSession only ever matches status === 'active', so telemetry
// arriving after a session has already transitioned to lost-contact (or
// ended) is correctly ignored here — recovery must go through a fresh
// handshake instead (see mqtt-client.ts / the bot-team contract's
// re-handshake-after-reconnect convention).
export function touchSessionActivity(vin: string): void {
  const session = getActiveSession(vin);
  if (!session) return;
  session.lastTelemetryAt = new Date().toISOString();
}

// Deliberately much longer than the bot's own missed-heartbeat self-stop
// tolerance (1.5s) — this must act as a pure backstop for "the bot's own
// stop-event genuinely never arrived" (hard crash, sustained SIM/cellular
// loss), not a second, faster-triggering mechanism that could disagree
// with the bot's own self-stop decision. 30s is a starting default, not a
// carefully-tuned value — real SIM connectivity behavior in the field
// should inform the final number; kept configurable for exactly that
// reason.
const STALE_SESSION_TIMEOUT_MS = Number(process.env.STALE_SESSION_TIMEOUT_MS ?? 30_000);

// Called periodically (see index.ts). Transitions any 'active' session
// that's gone quiet past the threshold to 'lost-contact' — deliberately
// NOT 'ended': 'ended' means a confirmed stop-event was received, the
// vehicle told us it stopped. 'lost-contact' means we gave up waiting —
// the vehicle's actual state is unknown, it may still be fully
// operational and moving. Callers must render these differently (see
// VehicleListPage.tsx) and must not treat a lost-contact transition as a
// safety-relevant action in itself — this is pure backend bookkeeping and
// never publishes an MQTT command, so it cannot itself stop or move a
// vehicle.
export function sweepStaleSessions(): VehicleSession[] {
  const now = Date.now();
  const staled: VehicleSession[] = [];
  for (const session of sessions.values()) {
    if (session.status !== 'active') continue;
    const referenceTime = session.lastTelemetryAt ?? session.startedAt;
    if (now - new Date(referenceTime).getTime() > STALE_SESSION_TIMEOUT_MS) {
      session.status = 'lost-contact';
      staled.push(session);
    }
  }
  return staled;
}

// Newest first, matching the grid's expected order.
export function listVehicleSessions(): VehicleSession[] {
  return [...sessions.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// sessionId alone can match more than one session (see the module-level
// comment above) — this can no longer do a direct map lookup by
// sessionId now that the map is composite-keyed. Falls back to the most
// recently started match when more than one exists, logging a warning
// since that's exactly the ambiguity the composite key exists to surface.
// This ambiguity is an accepted limitation specifically for report
// attach/download: the bot's real upload contract (POST
// /api/v1/vehicles/:vin/reports) only ever sends vin + sessionId, not
// macId — changing that would be a breaking change to an external,
// bot-team-facing API contract, out of scope for this internal fix.
//
// Exported (not just used internally by attachReportToSession/
// getSessionReport below) so reports-route.ts can resolve the macId to
// use in the storage key before the upload happens — attachReportToSession
// then records that same macId on the SessionReport itself, so the
// download route reconstructs the exact same key instead of independently
// re-resolving (and potentially resolving a different session).
export function findSessionForVinAndSessionId(
  vin: string,
  sessionId: string
): VehicleSession | undefined {
  const matches = [...sessions.values()].filter((s) => s.vin === vin && s.sessionId === sessionId);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    logger.warn(
      { vin, sessionId, matchCount: matches.length },
      'ambiguous vin+sessionId match for report lookup — using most recently started'
    );
  }
  return matches.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
}

// Both the vin-match check and the "session must already exist" check are
// deliberate: a report can only attach to a session this backend actually
// knows about, for the vin it actually belongs to — not an arbitrary
// sessionId supplied alongside a mismatched vin in the upload request.
export function attachReportToSession(
  vin: string,
  sessionId: string,
  report: { sizeBytes: number; uploadedAt: string }
): VehicleSession | undefined {
  const session = findSessionForVinAndSessionId(vin, sessionId);
  if (!session) return undefined;
  session.report = { sessionId, macId: session.macId, ...report };
  return session;
}

export function getSessionReport(vin: string, sessionId: string): VehicleSession['report'] {
  return findSessionForVinAndSessionId(vin, sessionId)?.report;
}

// Removes only the given sessions (identified by compositeId, not bare
// sessionId — see VehicleSession.compositeId), and only if each is
// currently 'ended' — an id for a missing or still-'active'/
// 'lost-contact' session is silently skipped, not an error, since this is
// the actual enforcement that active sessions can never be cleared (the
// frontend not rendering a checkbox for them is a courtesy, not the real
// boundary). Returns the count removed so the route layer can skip a
// pointless broadcast when nothing was actually cleared.
export function clearSessions(compositeIds: string[]): number {
  let cleared = 0;
  for (const compositeId of compositeIds) {
    const session = sessions.get(compositeId);
    if (session && session.status === 'ended') {
      sessions.delete(compositeId);
      cleared++;
    }
  }
  return cleared;
}
