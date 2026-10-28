import { create } from 'zustand';
import type { VehicleSession } from '@roshai/shared';

interface VehicleRegistryState {
  sessions: VehicleSession[];
  connected: boolean;
  setSessions: (sessions: VehicleSession[]) => void;
  upsertSession: (session: VehicleSession) => void;
  setConnected: (connected: boolean) => void;
}

export const useVehicleRegistryStore = create<VehicleRegistryState>((set) => ({
  sessions: [],
  connected: false,
  setSessions: (sessions) => set({ sessions }),
  // Deduped by compositeId, not sessionId — sessionId alone isn't
  // guaranteed unique across different bots/vehicles (see
  // VehicleSession.compositeId's doc comment), so filtering by it here
  // could otherwise merge two genuinely different sessions' rows.
  upsertSession: (session) =>
    set((state) => ({
      sessions: [session, ...state.sessions.filter((s) => s.compositeId !== session.compositeId)]
    })),
  setConnected: (connected) => set({ connected })
}));
