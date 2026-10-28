import { Server as SocketIoServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { parse as parseCookies } from 'cookie';
import type { BotTopicKind, ReportReadyEvent, VehicleSession } from '@roshai/shared';
import { logger } from './logger.js';
import { SESSION_COOKIE_NAME } from './auth-guard.js';
import { getSession } from './session-store.js';
import { listVehicleSessions } from './vehicle-registry.js';
import {
  handleVideoViewerJoin,
  handleVideoViewerLeave,
  handleVideoViewerSocketDisconnect
} from './video-control-service.js';

let io: SocketIoServer | undefined;

export function vehicleRoom(vin: string): string {
  return `vehicle:${vin}`;
}

export function createSocketServer(httpServer: HttpServer): SocketIoServer {
  io = new SocketIoServer(httpServer, {
    path: '/socket.io',
    cors: { origin: false } // same-origin via Traefik
  });

  // Any authenticated user (admin or operator) may watch live telemetry —
  // no role check here, just that a valid session exists. Without this,
  // the frontend's login gate is cosmetic: anyone who reaches the WS
  // endpoint directly could watch live telemetry regardless of login.
  io.use(async (socket, next) => {
    const cookieHeader = socket.handshake.headers.cookie;
    const sessionId = cookieHeader ? parseCookies(cookieHeader)[SESSION_COOKIE_NAME] : undefined;
    const session = sessionId ? await getSession(sessionId) : null;
    if (!session) {
      next(new Error('authentication required'));
      return;
    }
    next();
  });

  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'socket.io client connected');

    // One-time snapshot of current vehicle state for this newly-connected
    // socket — covers vehicles that handshook before this client opened
    // the page. broadcastVehicleUpdate() below handles live updates after
    // this point. Targeted emit (this socket only), not a broadcast.
    socket.emit('vehicle-list-snapshot', listVehicleSessions());

    // Browsers opt into a vehicle's room explicitly rather than
    // auto-joining everything, so multi-vehicle scaling doesn't broadcast
    // every vehicle's traffic to every connected client. Also drives live
    // video start/stop (see video-control-service.ts) — the video panel
    // is always shown alongside the map for whichever vehicle's page is
    // open (not independently toggled), so this same subscribe/
    // unsubscribe signal is reused rather than adding a second one.
    socket.on('subscribe-vehicle', (vin: unknown) => {
      if (typeof vin !== 'string' || vin.length === 0) return;
      socket.join(vehicleRoom(vin));
      handleVideoViewerJoin(socket.id, vin);
    });
    socket.on('unsubscribe-vehicle', (vin: unknown) => {
      if (typeof vin !== 'string') return;
      socket.leave(vehicleRoom(vin));
      handleVideoViewerLeave(socket.id, vin);
    });
    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, reason }, 'socket.io client disconnected');
      // Closed tab / dropped network — no clean unsubscribe-vehicle will
      // arrive, so stop video for every vehicle this socket was still
      // counted as watching (see video-control-service.ts).
      handleVideoViewerSocketDisconnect(socket.id);
    });
  });

  return io;
}

export function broadcastToVehicle(vin: string, kind: BotTopicKind, payload: unknown): void {
  io?.to(vehicleRoom(vin)).emit(kind, payload);
}

// Deliberately separate from broadcastToVehicle: 'report-ready' isn't an
// MQTT topic bridged 1:1 to a socket event like BotTopicKind's members
// are — it's a REST-upload-triggered notification, so it gets its own
// narrowly-typed emit instead of overloading that union.
export function broadcastReportReady(vin: string, payload: ReportReadyEvent): void {
  io?.to(vehicleRoom(vin)).emit('report-ready', payload);
}

// Global, not room-scoped — every connected client watches the vehicle
// discovery grid, not just clients that opted into a specific vehicle's
// room. Paired with the on-connect snapshot above.
export function broadcastVehicleUpdate(vehicle: VehicleSession): void {
  io?.emit('vehicle-update', vehicle);
}

// Broadcasts a full snapshot to every connected client — used when
// server-side state changes in a way that isn't representable as a single
// 'vehicle-update' upsert (clearing ended sessions removes rows entirely).
export function broadcastVehicleListSnapshot(): void {
  io?.emit('vehicle-list-snapshot', listVehicleSessions());
}
