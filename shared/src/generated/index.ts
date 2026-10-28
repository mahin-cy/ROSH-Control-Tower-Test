// Generated protobuf types (see shared/proto/, regenerate via
// `npm run proto:gen --workspace=shared`).
//
// All bot/video messages (session/handshake, heartbeat, telemetry,
// command, stop_event, video control/status) are wired to a real runtime
// encode/decode path — bot team confirmed session/handshake Aug 2026; the
// rest follow the same convention but aren't yet independently
// bot-team-confirmed (see shared/src/mqtt/session-payload.ts,
// heartbeat-payload.ts, telemetry-payload.ts, command-payload.ts,
// stop-event-payload.ts, video-control-payload.ts,
// video-status-payload.ts). There are no remaining JSON+Zod placeholder
// bot messages.
//
// Named (not `export *`) for two reasons: every generated file
// independently declares the same helper names (DeepPartial, MessageFns,
// isSet, ...) so `export *` across all of them would collide; and each
// message is renamed with a `Proto` prefix so it doesn't collide with the
// same-named Zod type exported from ../mqtt/index.ts.
export { TelemetryPayload as ProtoTelemetryPayload, GpsStatus } from './telemetry.js';
export {
  SessionPayload as ProtoSessionPayload,
  SessionAckPayload as ProtoSessionAckPayload,
  SessionEventType
} from './session.js';
export { StopEventPayload as ProtoStopEventPayload, StopEventCause } from './stop_event.js';
export { CommandPayload as ProtoCommandPayload, CommandAction } from './command.js';
export { HeartbeatPayload as ProtoHeartbeatPayload } from './heartbeat.js';
export {
  VideoControlCommand as ProtoVideoControlCommand,
  VideoStatus as ProtoVideoStatus,
  VideoAction,
  VideoState
} from './video.js';
