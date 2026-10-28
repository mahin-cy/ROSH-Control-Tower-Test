import { reportFileName } from '@roshai/shared';

// Shared by VehicleListPage (the grid's per-row Download button — the
// reachable path once a session has ended, since its Watch button disables
// at that point) and LiveTelemetryPage (for an operator already watching
// when the report lands). Not apiRequest — that helper always parses a
// { data, error } JSON envelope, but this route returns raw PDF bytes.
export async function downloadReport(vin: string, sessionId: string): Promise<void> {
  const res = await fetch(
    `/api/v1/vehicles/${encodeURIComponent(vin)}/reports/${encodeURIComponent(sessionId)}`,
    { credentials: 'include' }
  );
  if (!res.ok) throw new Error('failed to download report');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = reportFileName(vin, sessionId);
  link.click();
  URL.revokeObjectURL(url);
}
