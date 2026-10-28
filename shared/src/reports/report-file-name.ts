// The filename a downloaded report is saved as — not its object storage key
// (that stays `{vin}/{macId}/{sessionId}/report.pdf`, see reports-route.ts).
// vin is only validated against MQTT topic characters (mqtt/vin.ts), so it
// can still contain quotes/spaces/etc.; sanitize so the result is safe both
// inside a Content-Disposition header and as a filesystem name.
export function reportFileName(vin: string, sessionId: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe(vin)}_${safe(sessionId)}.pdf`;
}
