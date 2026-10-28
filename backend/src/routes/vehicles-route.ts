import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { vinTopicSegmentSchema } from '@roshai/shared';
import { requireAdmin } from '../lib/auth-guard.js';
import { getMqttClient } from '../lib/mqtt-state.js';
import { publishCommand } from '../lib/mqtt-client.js';
import { recordAdminAction } from '../lib/audit-log.js';
import { clearSessions } from '../lib/vehicle-registry.js';
import { broadcastVehicleListSnapshot } from '../lib/socket-server.js';
import { logger } from '../lib/logger.js';

// Shared with every per-vin MQTT topic builder (shared/src/mqtt/topics.ts)
// — vin is now interpolated into the command topic itself
// (robot/{vin}/command), not just the payload, so this route's validation
// and the topic-builder's validation must agree on the same rule rather
// than maintaining two independent regexes.
const stopParamsSchema = z.object({
  vin: vinTopicSegmentSchema
});

const clearSessionsBodySchema = z.object({
  sessionIds: z.array(z.string().min(1)).min(1)
});

export async function vehiclesRoute(app: FastifyInstance) {
  // Admin-only per CLAUDE.md's Security Baseline ("RBAC enforced
  // server-side on every action — especially the e-stop control") —
  // reuses the same requireAdmin guard as the /admin page route rather
  // than a one-off role check here.
  app.post('/api/v1/vehicles/:vin/stop', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = stopParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ data: null, error: { message: 'invalid vin' } });
    }
    const { vin } = parsed.data;

    const client = getMqttClient();
    if (!client) {
      return reply
        .code(503)
        .send({ data: null, error: { message: 'broker unavailable, try again shortly' } });
    }

    const issuedBy = request.user!.email;
    const issuedAt = new Date().toISOString();

    try {
      await publishCommand(client, { vinNumber: vin, action: 'e-stop', issuedAt, issuedBy });
    } catch (err) {
      logger.error({ err, vin }, 'e-stop delivery failed');
      return reply
        .code(502)
        .send({ data: null, error: { message: 'failed to deliver stop command' } });
    }

    // Best-effort: the safety-critical action (above) must not be blocked
    // or rolled back by an audit-write hiccup — log and move on if it fails.
    recordAdminAction(vin, 'e-stop', issuedBy).catch((err: unknown) =>
      logger.error({ err, vin }, 'audit log write failed')
    );

    logger.info({ vin, issuedBy }, 'e-stop issued');
    return reply.send({ data: { status: 'ok' }, error: null });
  });

  // Admin-only — this is a bulk action that mutates the shared session
  // grid every connected operator sees, not just the clicking user's own
  // view (unlike e.g. downloading a report, which is scoped to the
  // caller). Not audit-logged: the session registry itself is explicitly
  // in-memory/non-durable (see CLAUDE.md open items), so clearing it is
  // treated as a UI/display action rather than a compliance-worthy one.
  // Only ever clears the specific ids requested (the frontend sends the
  // checked rows) — clearSessions() itself re-checks each is 'ended'
  // before deleting, so a forged/stale id for an active session is a
  // silent no-op, not an error.
  app.post(
    '/api/v1/vehicles/clear-ended-sessions',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const parsed = clearSessionsBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ data: null, error: { message: 'invalid session ids' } });
      }

      const clearedCount = clearSessions(parsed.data.sessionIds);

      if (clearedCount > 0) {
        broadcastVehicleListSnapshot();
      }

      logger.info({ clearedCount, issuedBy: request.user!.email }, 'ended sessions cleared');
      return reply.send({ data: { clearedCount }, error: null });
    }
  );
}
