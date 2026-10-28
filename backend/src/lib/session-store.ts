import { randomBytes } from 'node:crypto';
import type { Role } from '@prisma/client';
import { redis } from './redis-client.js';

const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8 hours
const SESSION_KEY_PREFIX = 'session:';

export interface SessionData {
  userId: string;
  email: string;
  role: Role;
}

// Opaque, server-side session (not a JWT) — logout is a real, immediate
// revocation (delete the Redis key) rather than waiting for a token to
// expire. See the plan's "Session storage: Redis, not a JWT" rationale.
export async function createSession(data: SessionData): Promise<string> {
  const sessionId = randomBytes(32).toString('hex');
  await redis.set(SESSION_KEY_PREFIX + sessionId, JSON.stringify(data), 'EX', SESSION_TTL_SECONDS);
  return sessionId;
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
  const raw = await redis.get(SESSION_KEY_PREFIX + sessionId);
  if (!raw) return null;
  return JSON.parse(raw) as SessionData;
}

export async function destroySession(sessionId: string): Promise<void> {
  await redis.del(SESSION_KEY_PREFIX + sessionId);
}
