import { useEffect } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

import type { TelemetryGpsStatus } from '@roshai/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

// Vite doesn't resolve Leaflet's default marker image paths from CSS —
// point the default icon at the bundled assets explicitly (one-time fix).
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow
});

function Recenter({ latitude, longitude }: { latitude: number; longitude: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([latitude, longitude]);
  }, [map, latitude, longitude]);
  return null;
}

export function VehicleMap({
  latitude,
  longitude,
  gpsStatus,
  lastFixAt
}: {
  latitude: number | undefined;
  longitude: number | undefined;
  gpsStatus: TelemetryGpsStatus | undefined;
  lastFixAt: string | null;
}) {
  const hasPosition = latitude !== undefined && longitude !== undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Location</CardTitle>
      </CardHeader>
      <CardContent>
        {/* No-fix is a distinct state from "no reading yet": the bot is
            connected and sending telemetry, it just can't locate itself
            (e.g. indoors). The map returns on the next valid position. */}
        {gpsStatus === 'no-fix' ? (
          <div className="flex flex-col gap-1">
            <p className="font-medium">No GPS signal — position unavailable</p>
            <p className="text-muted-foreground text-sm">
              The map will appear when the vehicle reports a valid position again.
              {lastFixAt && ` Last fix at ${new Date(lastFixAt).toLocaleTimeString()}.`}
            </p>
          </div>
        ) : !hasPosition ? (
          <p className="text-muted-foreground">Waiting for position…</p>
        ) : (
          <div className="h-80 overflow-hidden rounded-md">
            <MapContainer
              center={[latitude, longitude]}
              zoom={17}
              scrollWheelZoom={false}
              className="h-full w-full"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <Marker position={[latitude, longitude]} />
              <Recenter latitude={latitude} longitude={longitude} />
            </MapContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
