import type { FastifyRequest, FastifyReply } from 'fastify';
import { getSession, type SessionData } from './session-store.js';
import { prisma } from './prisma-client.js';

export const SESSION_COOKIE_NAME = 'session_id';

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionData;
  }
}

// Fail closed: any missing/invalid/expired session is a 401, never a
// silent pass-through. Centralized here rather than left to each route to
// remember, per the security skill's "single authorization layer" rule.
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = request.cookies[SESSION_COOKIE_NAME];
  const session = sessionId ? await getSession(sessionId) : null;
  if (!session) {
    await reply.code(401).send({ data: null, error: { message: 'authentication required' } });
    return;
  }
  request.user = session;
}

// Re-checks role against Postgres rather than the cached session value:
// role can now change live via the Role Management UI
// (admin-users-route.ts), and this is the one route class where a
// just-demoted user retaining access until their 8h session expires would
// be a real problem, not just staleness. requireAuth's general "am I
// logged in" check is unaffected — that one still trusts the session.
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  const current = await prisma.user.findUnique({
    where: { id: request.user!.userId },
    select: { role: true }
  });

  if (current?.role !== 'ADMIN') {
    await reply.code(403).send({ data: null, error: { message: 'admin role required' } });
  }
}
