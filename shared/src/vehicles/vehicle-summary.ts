import type { StopEventPayload } from '../mqtt/stop-event-payload.js';

// Sent over the socket, not validated with Zod on the receiving end —
// this is backend-originated data, matching how SessionPayload/
// TelemetryPayload are already consumed unvalidated on the frontend side
// (see frontend/src/lib/socket-client.ts's 'session' listener).
//
// One entry per handshake session, not per vehicle — the same VIN can
// have multiple entries over time (repeated test runs on the same
// bot/car), distinguished by sessionId. 'lost-contact' (added for
// multi-vehicle support) is deliberately distinct from 'ended': 'ended'
// means a confirmed stop-event was received — the vehicle told us it
// stopped. 'lost-contact' means the backend's stale-session watchdog gave
// up waiting for telemetry — the vehicle's actual state is unknown, it
// may still be fully operational. Never render these identically (see
// VehicleListPage.tsx) — conflating them risks an operator believing a
// still-moving vehicle has confirmed-stopped.
export type VehicleSessionStatus = 'active' | 'ended' | 'lost-contact';

// Attached after a successful post-run PDF report upload (see
// backend/src/routes/reports-route.ts) — absent until then, and absent
// forever for sessions that never get one.
export interface SessionReport {
  sessionId: string;
  sizeBytes: number;
  uploadedAt: string;
  // The macId of the session this report was actually attached to,
  // captured once at attach time so the download route reconstructs the
  // exact same storage key rather than re-deriving it (and potentially
  // resolving a different session, once macId/vin/sessionId are no longer
  // guaranteed to be a 1:1 match — see vehicle-registry.ts). Null when no
  // matching session had a known macId.
  macId: string | null;
}

export interface VehicleSession {
  // Opaque, stable identifier — backend-computed from (macId, vin,
  // sessionId) (see vehicle-registry.ts's sessionKey). `sessionId` alone
  // is NOT guaranteed unique: a bot's own session counter can repeat
  // across different vehicles it's fitted to, and two different bots
  // fitted to the same vehicle over time can each report "session 1".
  // Use this, not sessionId, for React list keys, selection state, and
  // the clear-ended-sessions request — sessionId remains for display and
  // for matching a bot's own self-reported session identity.
  compositeId: string;
  vin: string;
  // Mandatory — enforced at handshake time (mqtt-client.ts rejects a
  // session-start payload missing mac_id before a VehicleSession is ever
  // created). Not a new requirement on the bot: mac_id was already part
  // of the bot-team-confirmed handshake shape. This is what lets the
  // composite (vin, macId, sessionId) identity actually be collision-free
  // for every established session — see vehicle-registry.ts's sessionKey
  // and VehicleSessionHistory's composite unique constraint.
  macId: string;
  sessionId: string;
  startedAt: string;
  status: VehicleSessionStatus;
  report?: SessionReport;
  // Set only when this session ended via a stop-event (operator e-stop or
  // a bot self-stop) — see endActiveSession() in vehicle-registry.ts.
  // Absent while active, and absent forever for a session ended via the
  // plain session-end path instead, which carries no cause.
  stopCause?: StopEventPayload['cause'];
  // Updated on every telemetry receipt for this vin's active session (see
  // vehicle-registry.ts's touchSessionActivity) — the basis for the
  // stale-session watchdog's active -> lost-contact transition. Absent
  // until the first telemetry message arrives after handshake.
  lastTelemetryAt?: string;
}
