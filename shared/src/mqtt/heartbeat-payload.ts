import { z } from 'zod';

// Mirrors shared/proto/heartbeat.proto. Wired to real protobuf (like
// session-payload.ts), not JSON — field names here are camelCase to match
// ts-proto's generated HeartbeatPayload interface directly, since
// backend/src/lib/heartbeat-service.ts and mqtt-client.ts work with the
// decoded object, not raw wire bytes or JSON.
//
// Field shape (sequence: uint64, timestampMs: epoch milliseconds as
// int64) confirmed directly by the bot team (Aug 2026) — supersedes our
// earlier int32-sequence/ISO-8601-string guess. Both still decode to
// plain TS `number` (ts-proto converts 64-bit wire values via a
// safe-integer check) — not a string/bigint despite the wire width.
export const heartbeatPayloadSchema = z.object({
  sequence: z.number().int().nonnegative(),
  timestampMs: z.number().int().nonnegative()
});

export type HeartbeatPayload = z.infer<typeof heartbeatPayloadSchema>;
