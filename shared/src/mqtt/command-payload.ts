import { z } from 'zod';

export const commandActionSchema = z.enum(['e-stop', 'resume']);

// Wired to real protobuf (like session/heartbeat/telemetry payloads), not
// JSON — camelCase fields match ts-proto's generated CommandPayload
// interface directly. vinNumber is populated by the backend as a
// self-contained convenience even though the topic (robot/{vin}/command,
// see ../mqtt/topics.ts's commandTopic) already carries it too — kept as
// defense-in-depth / a cross-check target on the bot side, same pattern
// as HandshakeRequest.
export const commandPayloadSchema = z.object({
  vinNumber: z.string().min(1),
  action: commandActionSchema,
  issuedAt: z.string().datetime({ offset: true }),
  issuedBy: z.string().min(1)
});

export type CommandPayload = z.infer<typeof commandPayloadSchema>;
