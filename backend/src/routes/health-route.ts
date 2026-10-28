import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma-client.js';
import { redis } from '../lib/redis-client.js';
import { getMqttClient } from '../lib/mqtt-state.js';

export async function healthRoute(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      return reply.send({
        data: { status: 'ok', mqtt: getMqttClient()?.connected ? 'connected' : 'reconnecting' },
        error: null
      });
    } catch (err) {
      app.log.error({ err }, 'health check failed');
      return reply.code(503).send({
        data: null,
        error: { message: 'dependency unreachable' }
      });
    }
  });
}
