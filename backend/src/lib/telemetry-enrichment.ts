import type { BotTopicKind, SessionPayload, TelemetryPayload } from '@roshai/shared';

// MAC only arrives on `session` events (session-start), never on
// `telemetry` events — this remembers the last-known MAC per VIN so the
// live telemetry view can display it anyway. Deliberately in-memory, not
// Redis: this is a display convenience, not data that needs to survive a
// restart, and avoids a Redis round-trip on every (potentially
// high-frequency) telemetry message.
const lastKnownMacByVin = new Map<string, string>();

export type EnrichedTelemetryPayload = TelemetryPayload & { mac?: string };

export function enrichBeforeBroadcast(vin: string, kind: BotTopicKind, payload: unknown): unknown {
  if (kind === 'session') {
    const mac = (payload as SessionPayload).macId;
    if (mac) lastKnownMacByVin.set(vin, mac);
    return payload;
  }

  if (kind === 'telemetry') {
    const mac = lastKnownMacByVin.get(vin);
    if (!mac) return payload;
    const enriched: EnrichedTelemetryPayload = { ...(payload as TelemetryPayload), mac };
    return enriched;
  }

  return payload;
}
