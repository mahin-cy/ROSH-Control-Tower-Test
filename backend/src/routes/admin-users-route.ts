import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { updateUserRoleRequestSchema, type AdminUserSummary } from '@roshai/shared';
import { prisma } from '../lib/prisma-client.js';
import { requireAdmin } from '../lib/auth-guard.js';
import { recordRoleChangeAudit } from '../lib/audit-log.js';
import { logger } from '../lib/logger.js';

const userIdParamsSchema = z.object({ id: z.string().uuid() });

export async function adminUsersRoute(app: FastifyInstance) {
  app.get('/api/v1/admin/users', { preHandler: requireAdmin }, async (_request, reply) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, email: true, name: true, role: true, createdAt: true }
    });

    const data: AdminUserSummary[] = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt.toISOString()
    }));

    return reply.send({ data, error: null });
  });

  app.patch(
    '/api/v1/admin/users/:id/role',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const paramsResult = userIdParamsSchema.safeParse(request.params);
      const bodyResult = updateUserRoleRequestSchema.safeParse(request.body);
      if (!paramsResult.success || !bodyResult.success) {
        return reply.code(400).send({ data: null, error: { message: 'invalid request' } });
      }
      const { id } = paramsResult.data;
      const { role } = bodyResult.data;

      const target = await prisma.user.findUnique({ where: { id } });
      if (!target) {
        return reply.code(404).send({ data: null, error: { message: 'user not found' } });
      }

      if (target.role === 'ADMIN' && role !== 'ADMIN') {
        const adminCount = await prisma.user.count({ where: { role: 'ADMIN' } });
        if (adminCount <= 1) {
          return reply
            .code(409)
            .send({ data: null, error: { message: 'cannot demote the last remaining admin' } });
        }
      }

      const updated = await prisma.user.update({ where: { id }, data: { role } });

      const issuedBy = request.user!.email;
      recordRoleChangeAudit(updated.email, role, issuedBy).catch((err: unknown) =>
        logger.error({ err, targetUserId: id }, 'audit log write failed')
      );

      logger.info({ targetUserId: id, role, issuedBy }, 'user role changed');
      return reply.send({
        data: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          role: updated.role,
          createdAt: updated.createdAt.toISOString()
        } satisfies AdminUserSummary,
        error: null
      });
    }
  );
}
