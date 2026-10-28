import type { FastifyInstance } from 'fastify';
import { loginRequestSchema } from '@roshai/shared';
import { prisma } from '../lib/prisma-client.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createSession, destroySession } from '../lib/session-store.js';
import { SESSION_COOKIE_NAME, requireAuth } from '../lib/auth-guard.js';
import { logger } from '../lib/logger.js';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

// A real argon2 hash of an unguessable value, verified against when no
// matching user exists — keeps the login response time roughly constant
// whether the account exists or not. The generic error message alone
// isn't enough: argon2's deliberate cost makes "no such user" measurably
// faster than "wrong password" unless this path also pays that cost.
const DUMMY_HASH = await hashPassword('dummy-timing-equalizer-value-not-a-real-account');

export async function authRoute(app: FastifyInstance) {
  app.post(
    '/api/v1/auth/login',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ data: null, error: { message: 'invalid request' } });
      }
      const { email, password } = parsed.data;

      const user = await prisma.user.findUnique({ where: { email } });

      if (!user || !user.passwordHash) {
        // Same timing-equalizer path whether the account doesn't exist or
        // exists but is OIDC-only (no passwordHash) — neither case should
        // be distinguishable from "wrong password" in the response.
        await verifyPassword(DUMMY_HASH, password);
        return reply
          .code(401)
          .send({ data: null, error: { message: 'invalid email or password' } });
      }

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        return reply.code(423).send({
          data: null,
          error: { message: 'account temporarily locked, try again later' }
        });
      }

      const valid = await verifyPassword(user.passwordHash, password);
      if (!valid) {
        const attempts = user.failedLoginAttempts + 1;
        const lockedUntil =
          attempts >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_DURATION_MS) : null;
        await prisma.user.update({
          where: { id: user.id },
          data: { failedLoginAttempts: attempts, lockedUntil }
        });
        logger.warn({ userId: user.id, attempts }, 'login failed');
        return reply
          .code(401)
          .send({ data: null, error: { message: 'invalid email or password' } });
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null }
      });

      const sessionId = await createSession({
        userId: user.id,
        email: user.email,
        role: user.role
      });

      // secure: only over HTTPS — gated on NODE_ENV rather than always
      // true because the stack's TLS/:443 entrypoint isn't configured yet
      // (a separate, still-open item — see CLAUDE.md's "server TLS
      // certificate source"). MUST become unconditional once that lands;
      // flagged here rather than silently relaxed.
      reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS
      });

      logger.info({ userId: user.id }, 'login succeeded');
      return reply.send({ data: { email: user.email, role: user.role }, error: null });
    }
  );

  app.post('/api/v1/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (sessionId) await destroySession(sessionId);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return reply.send({ data: { status: 'ok' }, error: null });
  });

  // Lets the frontend check "am I logged in" on page load — nothing else
  // exposes session state to the client beyond the opaque cookie.
  app.get('/api/v1/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    return reply.send({
      data: { email: request.user!.email, role: request.user!.role },
      error: null
    });
  });
}
