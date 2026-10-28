// Multi-vehicle topic scheme (superseded the single fixed robot/AUTO/...
// convention — see git history / CLAUDE.md for that era's reasoning).
// Three backend->bot TARGETED messages (a command/ack meant for one
// specific vehicle) are now per-vin topics: the broker only ever delivers
// them to the bot subscribed to its own vin's topic, so an e-stop meant
// for one vehicle cannot reach another once multiple bots are connected.
// The other five were never really vehicle-specific (either genuinely
// fleet-wide, like heartbeat, or bot->backend messages the backend
// demuxes by payload vin_number regardless of publisher count) — they
// keep a single fixed topic, just with the now-meaningless `AUTO` segment
// dropped.

// Backend -> bot, targeted: reaches only the bot subscribed to its own
// vin. `vin` must already be validated via vinTopicSegmentSchema (see
// ./vin.ts) before being interpolated here — never pass an unvalidated,
// bot-payload-originated vin straight into a topic string.
export function commandTopic(vin: string): string {
  return `robot/${vin}/command`;
}
export function videoControlTopic(vin: string): string {
  return `robot/${vin}/video/control`;
}
export function handshakeResponseTopic(vin: string): string {
  return `robot/${vin}/handshake/response`;
}

// Backend -> all bots, fleet-wide broadcast. No vin: the message carries
// no vehicle-specific content (just a liveness tick), and MQTT already
// fans a published message out to every subscriber independently, so
// each bot's own connectivity loss is detected correctly regardless of
// topic sharing. See backend/src/lib/heartbeat-service.ts.
export const HEARTBEAT_TOPIC = 'robot/heartbeat';

// Bot -> backend: fixed/shared, vin travels in the payload
// (`vin_number`). The backend already demuxes every inbound message by
// that payload vin, not by topic or publish ordering, so many bots
// publishing to the same topic causes no message-level misattribution.
export const MQTT_TOPICS_INBOUND = {
  handshakeRequest: 'robot/handshake/request',
  telemetry: 'robot/telemetry',
  stopEvent: 'robot/stop-event',
  videoStatus: 'robot/video/status'
} as const;

// bot -> backend: handshake request, telemetry, stop-event, video-status
// — the fixed topics the backend subscribes to (each handled by its own
// dedicated decode function in mqtt-client.ts).
export type BotTopicKind = 'telemetry' | 'session' | 'stop-event' | 'video-status';
