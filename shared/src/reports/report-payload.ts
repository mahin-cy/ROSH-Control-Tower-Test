import { z } from 'zod';

// Matches the vin route param's existing charset restriction
// (backend/src/routes/vehicles-route.ts) but sessionId also becomes part
// of the object storage key (`{vin}/{sessionId}/report.pdf`), so it gets
// its own stricter allowlist rather than reusing the vin pattern verbatim.
export const reportUploadFieldsSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'invalid sessionId'),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, 'checksum must be a 64-character hex SHA-256 digest')
});

export type ReportUploadFields = z.infer<typeof reportUploadFieldsSchema>;

// "Up to 5MB" per spec — 5 MiB, not an arbitrary buffer above it.
export const MAX_REPORT_SIZE_BYTES = 5 * 1024 * 1024;

// Socket.IO payload for the 'report-ready' event (backend/src/lib/
// socket-server.ts -> frontend/src/lib/socket-client.ts). Deliberately not
// a BotTopicKind (see topics.ts) — this isn't an MQTT-bridged message.
export interface ReportReadyEvent {
  sessionId: string;
  sizeBytes: number;
  uploadedAt: string;
}
