import { redis } from './redis-client.js';

const FLOW_TTL_SECONDS = 5 * 60; // long enough to complete a login, short enough to limit replay
const FLOW_KEY_PREFIX = 'oidc-flow:';

export interface OidcFlowData {
  codeVerifier: string;
  nonce: string;
}

// Keyed by the OIDC `state` value, which round-trips through the browser
// via the authorization redirect — this correlates GET /oidc/login with
// the later GET /oidc/callback (two separate requests) and doubles as
// CSRF/replay protection: a state absent from Redis (unknown, expired, or
// already consumed) is rejected. Deleted on read so each state is usable
// exactly once, same spirit as session-store.ts's single-purpose keys.
export async function storeOidcFlow(state: string, data: OidcFlowData): Promise<void> {
  await redis.set(FLOW_KEY_PREFIX + state, JSON.stringify(data), 'EX', FLOW_TTL_SECONDS);
}

export async function consumeOidcFlow(state: string): Promise<OidcFlowData | null> {
  const key = FLOW_KEY_PREFIX + state;
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  return JSON.parse(raw) as OidcFlowData;
}
