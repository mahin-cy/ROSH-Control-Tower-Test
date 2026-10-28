import Fastify, { type FastifyError } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyMultipart from '@fastify/multipart';
import { logger } from './lib/logger.js';
import { healthRoute } from './routes/health-route.js';
import { authRoute } from './routes/auth-route.js';
import { authOidcRoute } from './routes/auth-oidc-route.js';
import { adminUsersRoute } from './routes/admin-users-route.js';
import { vehiclesRoute } from './routes/vehicles-route.js';
import { reportsRoute } from './routes/reports-route.js';
import { sessionHistoryRoute } from './routes/session-history-route.js';
import { initOidcClient } from './lib/oidc-client.js';
import {
  SHARED_PACKAGE_VERSION,
  MAX_REPORT_SIZE_BYTES,
  type SessionPayload,
  type StopEventPayload
} from '@roshai/shared';
import { connectMqtt, closeMqtt } from './lib/mqtt-client.js';
import { startHeartbeat, stopHeartbeat } from './lib/heartbeat-service.js';
import {
  createSocketServer,
  broadcastToVehicle,
  broadcastVehicleUpdate
} from './lib/socket-server.js';
import { setMqttClient } from './lib/mqtt-state.js';
import { enrichBeforeBroadcast } from './lib/telemetry-enrichment.js';
import {
  registerVehicleSession,
  endActiveSession,
  touchSessionActivity,
  sweepStaleSessions
} from './lib/vehicle-registry.js';
import { recordSessionHistory } from './lib/session-history.js';
import { ensureBucket } from './lib/storage.js';

// trustProxy: requests always arrive via Traefik in every real deployment
// (see docker-compose.yml's backend routing labels), so without this,
// request.ip resolves to Traefik's own container address for everyone —
// making IP-keyed logic (the login route's rate limit, most notably)
// shared across every user instead of per-client. The host-published
// port (local tooling only, e.g. tools/bot-simulator.ts) means this does
// trust a self-reported X-Forwarded-For on that path too — accepted,
// consistent with this app's existing private-network/no-bot-auth trust
// model (see CLAUDE.md's "Bot identity & the no-auth decision").
const app = Fastify({ loggerInstance: logger, trustProxy: true });

await app.register(fastifyCookie);
// global: false — rate limiting is applied per-route (login, report
// upload) via each route's own `config.rateLimit`, not every route.
await app.register(fastifyRateLimit, { global: false });
// One file field, plus the sessionId/checksum fields — limits enforced
// here are the first line of defense; reports-route.ts also tracks the
// running byte count itself in case a client lies about part sizes.
await app.register(fastifyMultipart, {
  limits: { fileSize: MAX_REPORT_SIZE_BYTES, files: 1, fields: 2 }
});

// Catches errors thrown before a route handler's own explicit
// reply.code(...).send(...) even runs — e.g. a malformed multipart body
// (bad/missing boundary) rejected by @fastify/multipart's content-type
// parser. Without this, that whole class of failure was invisible: the
// access log showed "request completed" with a statusCode and nothing
// else, no way to tell what was actually wrong. 5xx messages are kept
// generic (may carry internal detail); 4xx messages are framework-level
// validation strings, safe to relay as-is, matching how every route's own
// explicit 400s already work.
app.setErrorHandler((error: FastifyError, request, reply) => {
  const statusCode = error.statusCode ?? 500;
  logger.error(
    {
      err: error,
      reqId: request.id,
      method: request.method,
      url: request.raw.url,
      contentType: request.headers['content-type']
    },
    'unhandled request error'
  );
  reply.code(statusCode).send({
    data: null,
    error: { message: statusCode < 500 ? error.message : 'internal server error' }
  });
});

await app.register(healthRoute);
await app.register(authRoute);
await app.register(authOidcRoute);
await app.register(adminUsersRoute);
await app.register(vehiclesRoute);
await app.register(reportsRoute);
await app.register(sessionHistoryRoute);

// Non-critical-path dependency: object storage being unreachable at boot
// must not block MQTT/telemetry/e-stop from coming up. Logged loudly and
// degraded (report upload/download will 502 until MinIO is reachable)
// rather than crashing the whole backend over it.
try {
  await ensureBucket('reports');
} catch (err) {
  logger.error(
    { err },
    'failed to ensure reports bucket exists at startup — report uploads will fail until this is resolved'
  );
}

// Same non-critical-path philosophy: password login (and everything
// safety-critical — MQTT/e-stop/telemetry) must keep working even if
// Entra discovery fails or OIDC_* env vars are misconfigured. The OIDC
// routes themselves return 503 while config is unset — see oidc-client.ts.
try {
  await initOidcClient();
} catch (err) {
  logger.error(
    { err },
    'failed to initialize OIDC client at startup — Microsoft sign-in will be unavailable until this is resolved'
  );
}

createSocketServer(app.server);

const mqttClient = connectMqtt((vin, kind, payload) => {
  if (kind === 'session') {
    const session = payload as SessionPayload;
    if (session.eventType === 'session-start') {
      if (!session.macId) {
        // Should be unreachable — mqtt-client.ts's handleHandshakeRequest
        // already rejects a session-start payload missing macId before
        // ever calling onMessage. Kept as a loud, explicit guard here too
        // (rather than trusting that invariant silently), and this
        // nested-if (not a sibling else-if) is what lets TypeScript
        // actually narrow session.macId to a plain `string` in the else
        // branch below — the onMessage callback's `payload: unknown` cast
        // means the type system has no guarantee from mqtt-client.ts's
        // own check, only from a narrowing check repeated at this exact
        // call site.
        logger.error({ vin }, 'session-start reached registration without macId — unreachable');
      } else {
        const macId = session.macId;
        // A vehicle can only be driving one session at a time (see
        // vehicle-registry.ts), but nothing enforced that invariant here —
        // if a prior run's stop-event/session-end was ever missed (bot
        // crash, lost message, or the bot team re-triggering start/stop in
        // quick succession), its session stayed 'active' forever. A later
        // stop-event would then end that STALE session (endActiveSession
        // returns whichever active session it finds first) instead of the
        // one actually running now, leaving the current row's Stop/Watch
        // buttons enabled indefinitely. Closing any leftover active session
        // for this vin the moment a new one starts keeps at most one truly
        // active session per vin, so a later stop-event unambiguously ends
        // the current run.
        const orphaned = endActiveSession(vin);
        if (orphaned) {
          broadcastVehicleUpdate(orphaned);
          recordSessionHistory(orphaned).catch((err: unknown) =>
            logger.error({ err, vin }, 'session history write failed')
          );
        }
        broadcastVehicleUpdate(registerVehicleSession(vin, macId, session.sessionId));
      }
    } else if (session.eventType === 'session-end') {
      const ended = endActiveSession(vin);
      if (ended) {
        broadcastVehicleUpdate(ended);
        recordSessionHistory(ended).catch((err: unknown) =>
          logger.error({ err, vin }, 'session history write failed')
        );
      }
    }
  }
  if (kind === 'stop-event') {
    const stopEvent = payload as StopEventPayload;
    const ended = endActiveSession(vin, stopEvent.cause);
    if (ended) {
      broadcastVehicleUpdate(ended);
      recordSessionHistory(ended).catch((err: unknown) =>
        logger.error({ err, vin }, 'session history write failed')
      );
    }
  }
  if (kind === 'telemetry') {
    // No-op if there's no active session for this vin (e.g. a stray
    // message, or one arriving for an already-ended/lost-contact
    // session) — see touchSessionActivity's own doc comment for why that
    // silent no-op is exactly the safety property wanted here. Telemetry
    // is still broadcast below regardless, matching existing behavior —
    // live viewing (LiveTelemetryPage) is intentionally decoupled from
    // registry/grid state (e.g. it keeps working across an ordinary
    // backend restart, before any new handshake re-registers the vin).
    touchSessionActivity(vin);
  }
  broadcastToVehicle(vin, kind, enrichBeforeBroadcast(vin, kind, payload));
});
setMqttClient(mqttClient);

// Unconditional, fleet-wide — not tied to any individual vehicle's
// session lifecycle. See heartbeat-service.ts's doc comment for why:
// starting/stopping this per-session used to work for the single-vehicle
// pilot but was a real bug once multiple vehicles could be connected at
// once (one vehicle's stop-event silently killed heartbeat for every
// other still-active vehicle too).
startHeartbeat(mqttClient);

// Backend-side stale-session watchdog: covers the case where a bot goes
// dark (hard crash, or sustained SIM/cellular loss) and never gets to
// send its own stop-event, which would otherwise leave that vin's session
// 'active' — and on the live grid — indefinitely. See
// vehicle-registry.ts's sweepStaleSessions for the full reasoning
// (deliberately transitions to 'lost-contact', not 'ended').
const STALE_SESSION_SWEEP_INTERVAL_MS = 5_000;
setInterval(() => {
  for (const session of sweepStaleSessions()) {
    logger.warn(
      { vin: session.vin, sessionId: session.sessionId },
      'vehicle session marked lost-contact: no telemetry received within threshold'
    );
    broadcastVehicleUpdate(session);
  }
}, STALE_SESSION_SWEEP_INTERVAL_MS);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
logger.info({ sharedVersion: SHARED_PACKAGE_VERSION }, `backend listening on ${port}`);

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  stopHeartbeat();
  try {
    await closeMqtt(mqttClient, 5_000);
  } catch (err) {
    logger.error({ err }, 'error closing mqtt client during shutdown');
  }
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
