import type { MqttClient } from 'mqtt';
import { HEARTBEAT_TOPIC, ProtoHeartbeatPayload } from '@roshai/shared';
import { logger } from './logger.js';

const HEARTBEAT_INTERVAL_MS = 500;

// Deliberately one shared loop, not per-vehicle: the message carries no
// vehicle-specific content, and MQTT already fans a published message out
// to every subscriber independently, so each bot's own connectivity loss
// is detected correctly off this same shared tick regardless of topic
// sharing. Per-vehicle timer state was considered and reverted — it would
// mean one publish per connected bot per tick for no safety benefit, and
// isn't needed for fault isolation either: this backend is already one
// process serving the whole fleet over one broker, so an unhandled
// exception anywhere already drops every vehicle's connectivity, not just
// heartbeat's (see the try/catch below for the actual mitigation, which
// is ordinary defensive coding, not per-vehicle isolation).
let timer: ReturnType<typeof setInterval> | undefined;
let sequence = 0;

// Deadman-switch signal for the bot's "3 consecutive missed = stop"
// requirement (see shared/proto/heartbeat.proto). Started once,
// unconditionally, right after the backend connects to MQTT (see
// index.ts) — deliberately NOT tied to any individual vehicle's session
// lifecycle. It used to be started on handshake and stopped on every
// stop-event, which worked fine for the single-vehicle pilot but was a
// real bug once multiple vehicles could be connected at once: this timer
// is one shared, fleet-wide broadcast (see the module comment above), so
// vehicle A's stop-event stopping it would silently cut heartbeat for
// every other still-active vehicle B, C, ... too — each of which would
// then see 3 consecutive missed heartbeats and incorrectly self-stop
// with cause=network-loss, even though nothing was wrong with their own
// connection. A heartbeat with zero subscribers costs essentially
// nothing (one tiny publish, twice a second, to a topic nobody's
// listening to), so there's no real cost to just running it for the
// lifetime of the backend process instead of chasing session-lifecycle
// correctness for something that was never actually session-scoped.
export function startHeartbeat(client: MqttClient): void {
  if (timer) return;
  sequence = 0;
  timer = setInterval(() => {
    try {
      sequence += 1;
      const bytes = ProtoHeartbeatPayload.encode(
        ProtoHeartbeatPayload.fromPartial({
          timestampMs: Date.now(),
          sequence
        })
      ).finish();
      client.publish(HEARTBEAT_TOPIC, Buffer.from(bytes), { qos: 0, retain: false }, (err) => {
        if (err) logger.error({ err }, 'heartbeat publish failed');
      });
    } catch (err) {
      // A single bad tick must not silently kill the interval (and with
      // it, every connected vehicle's deadman-switch signal) — log and
      // let the next tick proceed normally.
      logger.error({ err }, 'heartbeat tick failed');
    }
  }, HEARTBEAT_INTERVAL_MS);
  logger.info({ intervalMs: HEARTBEAT_INTERVAL_MS }, 'heartbeat started');
}

export function stopHeartbeat(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
  logger.info('heartbeat stopped');
}
