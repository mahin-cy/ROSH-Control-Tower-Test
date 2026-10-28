import { z } from 'zod';

// Excludes '/', '+', '#' — the MQTT topic separator and wildcard
// characters. Shared between backend/src/routes/vehicles-route.ts (an
// operator-supplied vin, already validated at that boundary) and every
// per-vin MQTT topic builder (commandTopic/videoControlTopic/
// handshakeResponseTopic in ./topics.ts), which now also interpolate vin
// values that originate from bot-published payloads — those are
// unauthenticated and unvalidated for topic-safety until they pass
// through this schema. Never publish to a per-vin topic built from a vin
// that hasn't been validated here first.
export const vinTopicSegmentSchema = z
  .string()
  .min(1)
  .regex(/^[^/+#]+$/, 'invalid vin');
