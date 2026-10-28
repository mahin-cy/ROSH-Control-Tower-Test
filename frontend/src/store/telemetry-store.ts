import { create } from 'zustand';
import type {
  ReportReadyEvent,
  SessionPayload,
  StopEventPayload,
  TelemetryPayload,
  VideoStatus
} from '@roshai/shared';

// What actually arrives over the socket: TelemetryPayload plus the
// backend's enrichment step merging in the last-known MAC (session id is
// deliberately not carried into the live view — skipped by design).
export type LiveTelemetryReading = TelemetryPayload & { mac?: string };

interface TelemetryState {
  vin: string | null;
  connected: boolean;
  latest: LiveTelemetryReading | null;
  // Timestamp of the most recent reading with a valid GPS fix — shown
  // alongside the "No GPS signal" message so the operator knows how stale
  // the last known position is. Only tracked for this page visit.
  lastFixAt: string | null;
  lastSession: SessionPayload | null;
  reportReady: ReportReadyEvent | null;
  stopEvent: StopEventPayload | null;
  videoStatus: VideoStatus | null;
  setVin: (vin: string) => void;
  setConnected: (connected: boolean) => void;
  setReading: (reading: LiveTelemetryReading) => void;
  setLastSession: (session: SessionPayload) => void;
  setReportReady: (report: ReportReadyEvent) => void;
  setStopEvent: (event: StopEventPayload) => void;
  setVideoStatus: (status: VideoStatus) => void;
}

export const useTelemetryStore = create<TelemetryState>((set) => ({
  vin: null,
  connected: false,
  latest: null,
  lastFixAt: null,
  lastSession: null,
  reportReady: null,
  stopEvent: null,
  videoStatus: null,
  // Reset on vehicle switch — a stale report (or stopped state) from a
  // different vehicle's previous session shouldn't carry over to the
  // newly-selected one.
  setVin: (vin) =>
    set({
      vin,
      latest: null,
      lastFixAt: null,
      lastSession: null,
      reportReady: null,
      stopEvent: null,
      videoStatus: null
    }),
  setConnected: (connected) => set({ connected }),
  setReading: (reading) =>
    set((state) => ({
      latest: reading,
      lastFixAt: reading.gpsStatus === 'fix' ? reading.timestamp : state.lastFixAt
    })),
  setLastSession: (session) => set({ lastSession: session }),
  setReportReady: (report) => set({ reportReady: report }),
  setStopEvent: (event) => set({ stopEvent: event }),
  setVideoStatus: (status) => set({ videoStatus: status })
}));
