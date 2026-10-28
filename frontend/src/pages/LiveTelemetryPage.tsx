import { useNavigate, useParams } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';

import { useVehicleSocket } from '@/lib/socket-client';
import { useTelemetryStore } from '@/store/telemetry-store';
import { useAuthStore } from '@/store/auth-store';
import { apiRequest } from '@/lib/api-client';
import { downloadReport } from '@/lib/download-report';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { VehicleMap } from '@/components/vehicle-map';
import { VehicleVideo } from '@/components/vehicle-video';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs tracking-wide uppercase">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function formatNumber(value: number | undefined, unit = ''): string {
  return value === undefined ? '—' : `${value}${unit}`;
}

const STOP_EVENT_CAUSE_LABELS: Record<string, string> = {
  operator: 'Operator',
  'network-loss': 'Network Loss',
  error: 'Error',
  'manual-shutdown': 'Manual Shutdown',
  unknown: 'Unknown'
};

export default function LiveTelemetryPage() {
  const navigate = useNavigate();
  const { vin } = useParams<{ vin: string }>();
  useVehicleSocket(vin ?? null);
  const connected = useTelemetryStore((s) => s.connected);
  const latest = useTelemetryStore((s) => s.latest);
  const lastFixAt = useTelemetryStore((s) => s.lastFixAt);
  const reportReady = useTelemetryStore((s) => s.reportReady);
  const stopEvent = useTelemetryStore((s) => s.stopEvent);
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');

  // Immediate-access stop control for an operator actively watching this
  // vehicle's telemetry — same endpoint as the grid's per-row Stop
  // button, just reachable without navigating back.
  const stopMutation = useMutation({
    mutationFn: (targetVin: string) =>
      apiRequest(`/api/v1/vehicles/${encodeURIComponent(targetVin)}/stop`, { method: 'POST' })
  });

  const downloadMutation = useMutation({
    mutationFn: () => {
      if (!vin || !reportReady) throw new Error('no report available');
      return downloadReport(vin, reportReady.sessionId);
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => navigate('/vehicles')}>
          <ChevronLeft />
          Back
        </Button>
        <h1 className="text-2xl font-semibold">Live telemetry — {vin}</h1>
        <Badge variant={connected ? 'default' : 'secondary'}>
          {connected ? 'Live' : 'Disconnected'}
        </Badge>
        {latest?.gpsStatus === 'no-fix' && <Badge variant="outline">No GPS</Badge>}
        {stopEvent && (
          <Badge variant="secondary">
            Stopped ({STOP_EVENT_CAUSE_LABELS[stopEvent.cause] ?? stopEvent.cause})
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          {reportReady ? (
            <Button
              size="sm"
              variant="outline"
              disabled={downloadMutation.isPending}
              onClick={() => downloadMutation.mutate()}
            >
              Download Report
            </Button>
          ) : (
            stopEvent && <span className="text-muted-foreground text-xs">Report not available</span>
          )}
          {isAdmin && vin && (
            <Button
              size="sm"
              variant="destructive"
              disabled={stopEvent !== null || stopMutation.isPending}
              onClick={() => {
                stopMutation.mutate(vin);
              }}
            >
              Stop
            </Button>
          )}
        </div>
      </div>

      {stopMutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          Failed to send stop signal: {stopMutation.error.message}
        </p>
      )}

      {downloadMutation.isError && (
        <p className="text-destructive text-sm" role="alert">
          Failed to download report: {downloadMutation.error.message}
        </p>
      )}

      {!latest ? (
        <p className="text-muted-foreground">Waiting for telemetry…</p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Latest reading</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Field label="Bot ID (MAC)" value={latest.mac ?? '—'} />
            <Field label="Vehicle VIN" value={latest.vinNumber} />
            <Field label="Latitude" value={formatNumber(latest.latitude)} />
            <Field label="Longitude" value={formatNumber(latest.longitude)} />
            <Field label="Altitude" value={formatNumber(latest.altitude, ' m')} />
            <Field label="Speed" value={formatNumber(latest.speedMps, ' m/s')} />
            <Field label="Heading" value={formatNumber(latest.headingDeg, '°')} />
            <Field label="Recorded at" value={new Date(latest.timestamp).toLocaleString()} />
          </CardContent>
        </Card>
      )}

      {/* Side by side on wide viewports, stacked on narrow ones — an
          operator watching this page wants position and camera feed
          visible at once. Video isn't gated on `latest` (unlike the map)
          since it becomes available independently of the first telemetry
          reading arriving — both start from the same subscribe-vehicle
          call, but there's no reason for one to wait on the other. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <VehicleMap
          latitude={latest?.latitude}
          longitude={latest?.longitude}
          gpsStatus={latest?.gpsStatus}
          lastFixAt={lastFixAt}
        />
        {vin && <VehicleVideo vin={vin} />}
      </div>
    </div>
  );
}
