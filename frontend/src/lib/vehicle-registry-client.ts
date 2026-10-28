import { useEffect } from 'react';
import { io } from 'socket.io-client';
import type { VehicleSession } from '@roshai/shared';
import { useVehicleRegistryStore } from '@/store/vehicle-registry-store';

// Global (not per-vehicle) connection — separate from useVehicleSocket's
// per-vin room connection, since this one needs the global broadcast, not
// a room. Gets a full snapshot on connect (covers sessions that started
// before this page was open) plus live updates after that.
export function useVehicleRegistry(): void {
  const setSessions = useVehicleRegistryStore((s) => s.setSessions);
  const upsertSession = useVehicleRegistryStore((s) => s.upsertSession);
  const setConnected = useVehicleRegistryStore((s) => s.setConnected);

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      withCredentials: true
    });

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('vehicle-list-snapshot', (sessions: VehicleSession[]) => setSessions(sessions));
    socket.on('vehicle-update', (session: VehicleSession) => upsertSession(session));

    return () => {
      socket.disconnect();
    };
  }, [setSessions, upsertSession, setConnected]);
}
