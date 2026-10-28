import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../lib/auth-guard.js';
import { listSessionHistory } from '../lib/session-history.js';

// Query params arrive as strings over HTTP — z.coerce converts them to
// the numbers listSessionHistory() expects.
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  // Same charset restriction as vehicles-route.ts's/reports-route.ts's
  // vin params, kept for consistency even though this is a read-only
  // filter, not something that ever reaches an MQTT topic.
  vin: z
    .string()
    .min(1)
    .regex(/^[^/+#]+$/, 'invalid vin')
    .optional()
});

export async function sessionHistoryRoute(app: FastifyInstance) {
  // requireAuth, not requireAdmin — matches the existing "Download
  // Report" button on the live grid, which has no admin gating today.
  // Viewing/downloading past session data is the same class of action as
  // that button, so this keeps the permission model consistent rather
  // than introducing a new, inconsistent gate.
  app.get('/api/v1/vehicles/history', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ data: null, error: { message: 'invalid query' } });
    }
    const { limit, offset, vin } = parsed.data;
    const { items, total } = await listSessionHistory({ limit, offset, vin });
    return reply.send({ data: { items, total, limit, offset }, error: null });
  });
}
