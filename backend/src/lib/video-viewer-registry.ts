// Per-vehicle count of operator browsers currently viewing that vehicle's
// video panel — drives VideoControlCommand START/STOP publishing (see
// video-control-service.ts). Count-based, not a naive per-request toggle:
// MediaMTX fans a stream out to multiple simultaneous viewers for free
// (see CLAUDE.md's "Live video" Tech Stack entry), so stopping on the
// first viewer to leave would cut off everyone else still watching.
//
// Deliberately in-memory, same pattern as vehicle-registry.ts's session
// map — resets on backend restart, an acceptable trade-off since Socket.IO
// connections themselves don't survive a backend restart either (every
// "viewer" reconnects and resubscribes from scratch anyway).
const viewerCountsByVin = new Map<string, number>();

// Tracks which vins each socket currently counts as a video viewer for,
// so a disconnect (closed tab, dropped network — no clean
// unsubscribe-vehicle) can still decrement every vin it was watching. See
// socket-server.ts's 'disconnect' handler and
// removeAllVideoViewersForSocket below.
const vinsBySocketId = new Map<string, Set<string>>();

export type ViewerCountTransition = 'started' | 'stopped' | 'unchanged';

// Called when a socket subscribes to a vehicle's video. Returns 'started'
// only on the 0->1 transition — the only case where the caller should
// actually publish a START command.
export function addVideoViewer(socketId: string, vin: string): ViewerCountTransition {
  const vins = vinsBySocketId.get(socketId) ?? new Set<string>();
  if (vins.has(vin)) return 'unchanged'; // already counted for this socket
  vins.add(vin);
  vinsBySocketId.set(socketId, vins);

  const nextCount = (viewerCountsByVin.get(vin) ?? 0) + 1;
  viewerCountsByVin.set(vin, nextCount);
  return nextCount === 1 ? 'started' : 'unchanged';
}

// Called on an explicit unsubscribe. Returns 'stopped' only on the ->0
// transition — the only case where the caller should publish STOP.
export function removeVideoViewer(socketId: string, vin: string): ViewerCountTransition {
  const vins = vinsBySocketId.get(socketId);
  if (!vins || !vins.has(vin)) return 'unchanged'; // wasn't counted for this socket
  vins.delete(vin);
  if (vins.size === 0) vinsBySocketId.delete(socketId);

  const current = viewerCountsByVin.get(vin) ?? 0;
  const nextCount = Math.max(0, current - 1);
  if (nextCount === 0) viewerCountsByVin.delete(vin);
  else viewerCountsByVin.set(vin, nextCount);
  return nextCount === 0 ? 'stopped' : 'unchanged';
}

// Called on socket disconnect — removes every vin this socket was
// counted for. Returns the vins that transitioned to 'stopped' (the
// caller publishes STOP for each), same "don't rely on a clean goodbye"
// principle already used for the bot's own missed-heartbeat self-stop.
export function removeAllVideoViewersForSocket(socketId: string): string[] {
  const vins = vinsBySocketId.get(socketId);
  if (!vins) return [];
  const stopped: string[] = [];
  for (const vin of [...vins]) {
    if (removeVideoViewer(socketId, vin) === 'stopped') stopped.push(vin);
  }
  return stopped;
}
