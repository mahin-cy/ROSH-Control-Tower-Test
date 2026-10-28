import { z } from 'zod';

export const sessionEventTypeSchema = z.enum(['session-start', 'session-end']);

// Wire format for this message is real protobuf, not JSON — the bot team
// confirmed (Aug 2026) it's sent as binary-encoded HandshakeRequest on the
// robot/handshake/request topic (see shared/proto/session.proto,
// shared/src/generated/session.ts, MQTT_TOPICS_INBOUND.handshakeRequest in
// ./topics.ts). Every bot message is wired to real protobuf now — there
// are no remaining JSON+Zod placeholders (see CLAUDE.md).
//
// Field names here are camelCase to match ts-proto's generated
// SessionPayload interface directly: backend/src/lib/mqtt-client.ts
// constructs this shape immediately after ProtoSessionPayload.decode()
// (converting the numeric SessionEventType enum to this string union), so
// this schema validates the decoded object, not raw wire bytes or JSON.
//
// 'session-start' *is* the bot's handshake message — the first
// application-level PUBLISH after the MQTT CONNECT handshake (transport-
// level, no payload). Don't reintroduce a separate handshake schema.
//
// `timestamp` and `eventType` aren't in the bot's HandshakeRequest, so
// both are optional here: `eventType` defaults to 'session-start' so the
// bot's bare 3-field handshake still parses as one, and the backend
// stamps its own receive time when `timestamp` is omitted.
export const sessionPayloadSchema = z.object({
  vinNumber: z.string().min(1),
  macId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }).optional(),
  eventType: sessionEventTypeSchema.default('session-start')
});

export type SessionPayload = z.infer<typeof sessionPayloadSchema>;

// Mirrors the bot team's HandshakeResponse exactly. Published by the
// backend as binary protobuf on the per-vehicle robot/{vin}/handshake/
// response topic in response to a handshake attempt (see
// mqtt-client.ts's publishSessionAck, which takes vin as a separate
// parameter — this payload carries no vin_number of its own) — the first
// backend-to-bot channel other than the ACL-locked command topic.
export const sessionAckPayloadSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  sessionId: z.string()
});

export type SessionAckPayload = z.infer<typeof sessionAckPayloadSchema>;
