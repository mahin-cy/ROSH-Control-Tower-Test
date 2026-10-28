import { z } from 'zod';

export const videoActionSchema = z.enum(['start', 'stop', 'set-bitrate']);

// Wired to real protobuf (like command/heartbeat/telemetry payloads), not
// JSON — camelCase fields match ts-proto's generated VideoControlCommand
// interface directly. Backend -> bot only, per-vehicle, published on
// robot/{vin}/video/control (see topics.ts's videoControlTopic) — same
// broker-enforced per-vehicle delivery guarantee as the command topic.
// Proposed, not yet bot-team-confirmed — same status as
// heartbeat/telemetry/command.
//
// target*/ingestUrl are only meaningful for 'start'/'set-bitrate' — the
// backend omits them when publishing 'stop'.
export const videoControlCommandSchema = z.object({
  vinNumber: z.string().min(1),
  sessionId: z.string().min(1),
  commandId: z.string().min(1),
  action: videoActionSchema,
  targetBitrateKbps: z.number().int().positive().optional(),
  targetWidth: z.number().int().positive().optional(),
  targetHeight: z.number().int().positive().optional(),
  targetFps: z.number().int().positive().optional(),
  ingestUrl: z.string().min(1).optional(),
  issuedAtMs: z.number().int().nonnegative()
});

export type VideoControlCommand = z.infer<typeof videoControlCommandSchema>;
