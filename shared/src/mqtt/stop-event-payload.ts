import { z } from 'zod';

// `cause` distinguishes an operator-triggered stop from a network-loss-
// triggered stop — CLAUDE.md's explicit requirement (heartbeat must be
// able to tell these apart). 'unknown' covers a bot that can't classify
// its own stop rather than forcing a guess. 'error' and 'manual-shutdown'
// added Sep 2026 — bot-team-confirmed StopEventCause values alongside a
// non-additive renumbering of the proto enum (see shared/proto/
// stop_event.proto and shared/src/generated/stop_event.ts).
export const stopEventCauseSchema = z.enum([
  'operator',
  'network-loss',
  'error',
  'manual-shutdown',
  'unknown'
]);

// Wired to real protobuf (like the other four bot payloads), not JSON —
// camelCase fields match ts-proto's generated StopEventPayload interface
// directly. No longer extends mqttEnvelopeSchema (that shared module was
// deleted — every message now inlines vinNumber/timestamp itself, same
// pattern session/telemetry/command already settled into). timestampMs
// is epoch milliseconds (int64 on the wire, plain number in TS — same
// safe-integer conversion as heartbeat's timestamp_ms), not an ISO-8601
// string — kept consistent with the bot-team-confirmed HeartbeatPayload
// shape rather than mixing formats across our own messages.
export const stopEventPayloadSchema = z.object({
  vinNumber: z.string().min(1),
  timestampMs: z.number().int().nonnegative(),
  cause: stopEventCauseSchema,
  reason: z.string().max(500).optional()
});

export type StopEventPayload = z.infer<typeof stopEventPayloadSchema>;
