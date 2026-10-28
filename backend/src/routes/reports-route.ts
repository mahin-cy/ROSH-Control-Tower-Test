import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  reportUploadFieldsSchema,
  MAX_REPORT_SIZE_BYTES,
  reportFileName,
  vinTopicSegmentSchema
} from '@roshai/shared';
import { requireAuth } from '../lib/auth-guard.js';
import {
  attachReportToSession,
  getSessionReport,
  findSessionForVinAndSessionId
} from '../lib/vehicle-registry.js';
import { attachReportToHistory, getHistoricalReport } from '../lib/session-history.js';
import { broadcastReportReady, broadcastVehicleUpdate } from '../lib/socket-server.js';
import { uploadObject, getObject } from '../lib/storage.js';
import { logger } from '../lib/logger.js';

const REPORTS_BUCKET = 'reports';

// Same shared schema vehicles-route.ts and every per-vin MQTT topic
// builder use — kept for consistency even though this is an HTTP route,
// not an MQTT one.
const vinParamsSchema = z.object({
  vin: vinTopicSegmentSchema
});

const reportParamsSchema = vinParamsSchema.extend({
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'invalid sessionId')
});

export async function reportsRoute(app: FastifyInstance) {
  // No preHandler auth — bot no-auth model, same as MQTT (see CLAUDE.md's
  // "Bot identity & the no-auth decision"): the bot is identified only by
  // the vin in the URL. Rate-limited and size-capped (the multipart
  // plugin's registered limits in index.ts, plus the manual running-total
  // check below as defense in depth against a client that lies about
  // Content-Length).
  app.post(
    '/api/v1/vehicles/:vin/reports',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const paramsResult = vinParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({ data: null, error: { message: 'invalid vin' } });
      }
      const { vin } = paramsResult.data;

      // Idle-timeout on the incoming request body, not a hard deadline —
      // resets on any activity, so a slow-but-progressing ≤5MB transfer
      // isn't punished. Without this a client that never properly
      // terminates its multipart body (e.g. missing the closing boundary)
      // leaves the handler awaiting forever with no response ever sent —
      // confirmed live: several real upload attempts hung exactly this
      // way with no error and no success logged. destroy() with no error
      // argument (not destroy(err)) deliberately, to avoid an unhandled
      // 'error' event on request.raw if nothing else is listening for one.
      request.raw.setTimeout(30_000, () => request.raw.destroy());

      let sessionId: string | undefined;
      let checksum: string | undefined;
      let fileBuffer: Buffer | undefined;

      try {
        for await (const part of request.parts()) {
          if (part.type === 'file') {
            if (part.fieldname !== 'file') {
              part.file.resume(); // drain and ignore any unexpected file part
              continue;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            for await (const chunk of part.file) {
              total += (chunk as Buffer).length;
              if (total > MAX_REPORT_SIZE_BYTES) {
                part.file.destroy();
                return reply.code(413).send({ data: null, error: { message: 'file too large' } });
              }
              chunks.push(chunk as Buffer);
            }
            fileBuffer = Buffer.concat(chunks);
          } else if (part.fieldname === 'sessionId') {
            sessionId = String(part.value);
          } else if (part.fieldname === 'checksum') {
            checksum = String(part.value);
          }
        }
      } catch (err) {
        // @fastify/multipart throws this (statusCode 413 built in) when the
        // plugin-level limits.fileSize is exceeded — surfaced distinctly so
        // it matches the documented contract's 413, not a generic 400.
        if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ data: null, error: { message: 'file too large' } });
        }
        logger.warn({ err, vin }, 'report upload multipart parse failed');
        return reply.code(400).send({ data: null, error: { message: 'invalid upload' } });
      }

      const fieldsResult = reportUploadFieldsSchema.safeParse({ sessionId, checksum });
      if (!fieldsResult.success || !fileBuffer) {
        // The only rejection path that used to log nothing at all — every
        // other 400/413/502 below has a paired log line, this one didn't,
        // which made a real live failure invisible (confirmed: a genuine
        // bot-team upload attempt hit exactly this branch with zero trace
        // of why). hasFile/hasSessionId/hasChecksum pinpoint which of the
        // three multipart parts was missing without needing the raw body.
        logger.warn(
          {
            vin,
            hasFile: fileBuffer !== undefined,
            hasSessionId: sessionId !== undefined,
            hasChecksum: checksum !== undefined,
            fieldErrors: fieldsResult.success
              ? undefined
              : fieldsResult.error.issues.map(
                  (issue) => `${issue.path.join('.')}: ${issue.message}`
                )
          },
          'report upload rejected: missing or invalid fields'
        );
        return reply
          .code(400)
          .send({ data: null, error: { message: 'missing or invalid fields' } });
      }

      // Content check by magic bytes, not the client-supplied filename or
      // mimetype — both are trivially spoofable.
      if (fileBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
        logger.warn(
          { vin, sessionId: fieldsResult.data.sessionId },
          'report upload rejected: not a PDF'
        );
        return reply.code(400).send({ data: null, error: { message: 'file is not a valid PDF' } });
      }

      const actualChecksum = createHash('sha256').update(fileBuffer).digest('hex');
      if (actualChecksum !== fieldsResult.data.checksum.toLowerCase()) {
        // Always error-level, per CLAUDE.md's existing "upload checksum
        // mismatches" logging convention (Security baseline / Logging).
        logger.error(
          { vin, sessionId: fieldsResult.data.sessionId },
          'report upload checksum mismatch'
        );
        return reply.code(400).send({ data: null, error: { message: 'checksum mismatch' } });
      }

      // Server picks the storage key/filename — never the client-supplied
      // one (path traversal + overwrite risk). Namespaced by macId as
      // well as vin+sessionId now — vin+sessionId alone can collide
      // across different bots fitted to the same vehicle over time (see
      // vehicle-registry.ts's module comment), which would otherwise let
      // one bot's report silently overwrite another's at the same key.
      //
      // rawMacId is the real, possibly-null resolved value — used as-is
      // for attachReportToHistory (below) so the DB never receives a fake
      // macId. 'unknown-bot' is a MinIO-storage-key-only fallback, not an
      // error: the upload itself should still succeed even if no matching
      // session/macId is found (matches the existing lenient behavior
      // below, where attachReportToSession failing doesn't fail the
      // upload either) — it must never leak past this one key-naming use.
      const rawMacId =
        findSessionForVinAndSessionId(vin, fieldsResult.data.sessionId)?.macId ?? null;
      const key = `${vin}/${rawMacId ?? 'unknown-bot'}/${fieldsResult.data.sessionId}/report.pdf`;
      try {
        await uploadObject(REPORTS_BUCKET, key, fileBuffer, 'application/pdf');
      } catch (err) {
        logger.error(
          { err, vin, sessionId: fieldsResult.data.sessionId },
          'report upload to storage failed'
        );
        return reply
          .code(502)
          .send({ data: null, error: { message: 'storage unavailable, try again shortly' } });
      }

      const uploadedAt = new Date().toISOString();
      const updated = attachReportToSession(vin, fieldsResult.data.sessionId, {
        sizeBytes: fileBuffer.length,
        uploadedAt
      });
      if (!updated) {
        // The bytes are safely in storage either way — this just means no
        // in-memory session record exists for this vin+sessionId (e.g. the
        // handshake was never seen). Surface it distinctly from a generic
        // failure so the caller knows the upload itself didn't fail.
        logger.warn(
          { vin, sessionId: fieldsResult.data.sessionId },
          'report uploaded but no matching session found to attach it to'
        );
        return reply.code(404).send({ data: null, error: { message: 'unknown session' } });
      }

      if (updated.report) broadcastReportReady(vin, updated.report);
      // Same global broadcast used for session start/end (index.ts) — the
      // "Connected vehicles" grid keeps its own copy of every session via
      // this event, so it needs telling too, not just the per-vehicle room
      // a viewer of LiveTelemetryPage happens to be subscribed to.
      broadcastVehicleUpdate(updated);
      // Fire-and-forget durable backfill — see session-history.ts for why
      // this and recordSessionHistory both upsert rather than
      // create/update: the report can legitimately arrive before or after
      // the session's own stop-event. Uses `updated.macId` (guaranteed a
      // real string — we're past the `!updated` check above, and
      // VehicleSession.macId is mandatory) rather than the earlier
      // `rawMacId` snapshot taken before the upload — this reflects the
      // actual session the report was just attached to, not a
      // pre-upload lookup that could theoretically have gone stale.
      attachReportToHistory(vin, fieldsResult.data.sessionId, updated.macId, {
        sizeBytes: fileBuffer.length,
        uploadedAt
      }).catch((err: unknown) =>
        logger.error(
          { err, vin, sessionId: fieldsResult.data.sessionId },
          'session history report backfill failed'
        )
      );

      logger.info(
        { vin, sessionId: fieldsResult.data.sessionId, sizeBytes: fileBuffer.length },
        'report uploaded'
      );
      return reply.code(201).send({ data: { status: 'ok' }, error: null });
    }
  );

  // Requires an authenticated operator/admin session — matches the
  // Socket.IO auth policy (socket-server.ts), unlike the POST route above:
  // this is a human downloading a file through the browser, not the bot.
  app.get(
    '/api/v1/vehicles/:vin/reports/:sessionId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = reportParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ data: null, error: { message: 'invalid request' } });
      }
      const { vin, sessionId } = parsed.data;

      // Fast path: the live in-memory registry. Falls back to the durable
      // history table once a session is cleared from the live grid or the
      // backend has restarted — without this fallback, a cleared session's
      // report becomes permanently undownloadable even though the PDF
      // bytes are still sitting in MinIO (see session-history.ts).
      let report = getSessionReport(vin, sessionId);
      if (!report) {
        try {
          report = (await getHistoricalReport(vin, sessionId)) ?? undefined;
        } catch (err) {
          logger.error({ err, vin, sessionId }, 'session history lookup failed');
          return reply.code(502).send({
            data: null,
            error: { message: 'history lookup unavailable, try again shortly' }
          });
        }
      }
      if (!report) {
        return reply.code(404).send({ data: null, error: { message: 'report not found' } });
      }

      // Uses the macId recorded on the report at upload time, not a fresh
      // registry lookup — guarantees the exact same key the file was
      // actually stored under, rather than potentially resolving a
      // different session if the registry's vin+sessionId match is
      // ambiguous by the time of this download.
      const key = `${vin}/${report.macId ?? 'unknown-bot'}/${sessionId}/report.pdf`;
      let object;
      try {
        object = await getObject(REPORTS_BUCKET, key);
      } catch (err) {
        logger.error({ err, vin, sessionId }, 'report download from storage failed');
        return reply
          .code(502)
          .send({ data: null, error: { message: 'storage unavailable, try again shortly' } });
      }
      if (!object) {
        logger.error({ vin, sessionId }, 'report metadata present but object missing from storage');
        return reply.code(404).send({ data: null, error: { message: 'report not found' } });
      }

      reply.header('Content-Type', 'application/pdf');
      reply.header(
        'Content-Disposition',
        `attachment; filename="${reportFileName(vin, sessionId)}"`
      );
      reply.header('Content-Length', object.sizeBytes);
      return reply.send(object.stream);
    }
  );
}
