import { z } from 'zod';

// Mirrors shared/proto/telemetry.proto. Wired to real protobuf (like
// session-payload.ts and heartbeat-payload.ts), not JSON — camelCase
// field names match ts-proto's generated TelemetryPayload interface
// directly, since backend/src/lib/mqtt-client.ts validates the decoded
// object, not raw wire bytes or JSON. No longer extends
// mqttEnvelopeSchema — vin_number replaces vin, same rename session got.
//
// gpsStatus is the app-level form of the proto's GpsStatus enum (mapped in
// mqtt-client.ts — UNSPECIFIED is treated as 'fix' for older firmware).
// Position fields are only present, and only range-checked, on 'fix': on
// 'no-fix' the backend strips them before validation so the bot's
// placeholder 0,0 never reaches the browser as a real-looking position.
export const gpsStatusSchema = z.enum(['fix', 'no-fix']);
// Named TelemetryGpsStatus, not GpsStatus, to avoid colliding with the
// generated proto enum of that name (re-exported from ../generated).
export type TelemetryGpsStatus = z.infer<typeof gpsStatusSchema>;

export const telemetryPayloadSchema = z
  .object({
    vinNumber: z.string().min(1),
    timestamp: z.string().datetime({ offset: true }),
    speedMps: z.number().finite(),
    headingDeg: z.number().min(0).max(360),
    gpsStatus: gpsStatusSchema,
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    altitude: z.number().finite().optional()
  })
  .superRefine((value, ctx) => {
    if (value.gpsStatus !== 'fix') return;
    for (const field of ['latitude', 'longitude', 'altitude'] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required when gpsStatus is 'fix'`
        });
      }
    }
  });

export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;
