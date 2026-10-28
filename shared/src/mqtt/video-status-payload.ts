import { z } from 'zod';

export const videoStateSchema = z.enum(['starting', 'streaming', 'stopped', 'error']);

// Wired to real protobuf (like command/heartbeat/telemetry payloads), not
// JSON — camelCase fields match ts-proto's generated VideoStatus
// interface directly. Bot -> backend only, fixed/shared, published on
// robot/video/status (see topics.ts's MQTT_TOPICS_INBOUND.videoStatus) —
// the backend demuxes by this payload's own vin_number, same reasoning as
// telemetry. Proposed, not yet bot-team-confirmed — same status as
// heartbeat/telemetry/command.
export const videoStatusSchema = z.object({
  vinNumber: z.string().min(1),
  sessionId: z.string().min(1),
  // Echoes the triggering VideoControlCommand.commandId.
  commandId: z.string().min(1),
  state: videoStateSchema,
  currentBitrateKbps: z.number().int().nonnegative().optional(),
  currentWidth: z.number().int().nonnegative().optional(),
  currentHeight: z.number().int().nonnegative().optional(),
  // Populated only when state === 'error'.
  errorMessage: z.string().optional(),
  reportedAtMs: z.number().int().nonnegative()
});

export type VideoStatus = z.infer<typeof videoStatusSchema>;
