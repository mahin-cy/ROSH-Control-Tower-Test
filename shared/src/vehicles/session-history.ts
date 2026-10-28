// startedAt/endedAt are non-null here despite being nullable *columns* in
// the backend's VehicleSessionHistory table — safe because the backend's
// listSessionHistory() always filters to endedAt IS NOT NULL, and
// recordSessionHistory() (the only writer that ever sets endedAt) always
// sets startedAt in that same write, so endedAt non-null implies
// startedAt non-null too. The nullability is purely an internal
// write-ordering detail (see backend/src/lib/session-history.ts), never
// visible through this API.
export interface VehicleSessionHistoryRecord {
  id: string;
  vin: string;
  macId: string | null;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  stopCause: string | null;
  report: { sizeBytes: number; uploadedAt: string } | null;
}

export interface VehicleSessionHistoryPage {
  items: VehicleSessionHistoryRecord[];
  total: number;
  limit: number;
  offset: number;
}
