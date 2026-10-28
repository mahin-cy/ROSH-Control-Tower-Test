import { useEffect } from 'react';
import { io } from 'socket.io-client';
import type {
  ReportReadyEvent,
  SessionPayload,
  StopEventPayload,
  VideoStatus
} from '@roshai/shared';
import { useTelemetryStore, type LiveTelemetryReading } from '@/store/telemetry-store';

// Connects for exactly one VIN at a time, scoped to whichever component
// calls this (currently just LiveTelemetryPage) — not a global singleton,
// matching the server's opt-in `subscribe-vehicle` room design. Reconnects
// automatically (socket.io-client's default) if the connection drops.
export function useVehicleSocket(vin: string | null): void {
  const setVin = useTelemetryStore((s) => s.setVin);
  const setConnected = useTelemetryStore((s) => s.setConnected);
  const setReading = useTelemetryStore((s) => s.setReading);
  const setLastSession = useTelemetryStore((s) => s.setLastSession);
  const setReportReady = useTelemetryStore((s) => s.setReportReady);
  const setStopEvent = useTelemetryStore((s) => s.setStopEvent);
  const setVideoStatus = useTelemetryStore((s) => s.setVideoStatus);

  useEffect(() => {
    if (!vin) return;

    setVin(vin);

    const socket = io({
      path: '/socket.io',
      withCredentials: true
    });

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('subscribe-vehicle', vin);
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('telemetry', (payload: LiveTelemetryReading) => {
      setReading(payload);
    });

    socket.on('session', (payload: SessionPayload) => {
      setLastSession(payload);
    });

    socket.on('report-ready', (payload: ReportReadyEvent) => {
      setReportReady(payload);
    });

    socket.on('stop-event', (payload: StopEventPayload) => {
      setStopEvent(payload);
    });

    // Bot's reported video pipeline state (see backend's
    // video-control-service.ts / mqtt-client.ts handleVideoStatus) — not
    // used to drive the WHEP connection itself (see use-vehicle-video.ts,
    // which connects/retries independently), just surfaced for a more
    // informative "waiting for video" state than "connecting" alone.
    socket.on('video-status', (payload: VideoStatus) => {
      setVideoStatus(payload);
    });

    return () => {
      socket.emit('unsubscribe-vehicle', vin);
      socket.disconnect();
    };
  }, [
    vin,
    setVin,
    setConnected,
    setReading,
    setLastSession,
    setReportReady,
    setStopEvent,
    setVideoStatus
  ]);
}
