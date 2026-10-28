import { randomUUID } from 'node:crypto';
import type { MqttClient } from 'mqtt';
import { publishVideoControl } from './mqtt-client.js';
import { getMqttClient } from './mqtt-state.js';
import { getActiveSession } from './vehicle-registry.js';
import {
  addVideoViewer,
  removeVideoViewer,
  removeAllVideoViewersForSocket
} from './video-viewer-registry.js';
import { logger } from './logger.js';

// Client-confirmed profile (CLAUDE.md's "Live video" Tech Stack entry):
// 2,500-4,000 kbps at 30fps/720p. Requesting the upper end by default;
// SET_BITRATE exists on the wire for throttling down later if bandwidth
// actually drops, but nothing automatically triggers that yet — no
// bandwidth-detection logic is implemented (see Open Items in CLAUDE.md).
const TARGET_BITRATE_KBPS = 4000;
const TARGET_WIDTH = 1280;
const TARGET_HEIGHT = 720;
const TARGET_FPS = 30;

// Decided Sep 2026: RTSP ingest, not WHIP — bot pushes here directly
// (rtspclientsink's ANNOUNCE/RECORD flow), browser playback is unaffected
// (still WHEP via Traefik's /webrtc, see use-vehicle-video.ts). Must be
// reachable BY THE BOT (an external tailnet device), not just by this
// backend container — and unlike a Traefik-routed URL, this is NOT the
// /webrtc path: RTSP isn't HTTP, so it bypasses Traefik entirely and
// goes straight to MediaMTX's own published RTSP port (see
// docker-compose.yml's mediamtx service, MEDIAMTX_RTSP_PORT). Same
// "won't work until the real tailnet domain is set" posture already
// accepted for OIDC_REDIRECT_URI.
//
// Path is the vin (multi-vehicle support) — each vehicle gets its own
// MediaMTX stream path, replacing the old single fixed 'AUTO' path. vin
// is not re-validated here: it always originates from an already-active
// VehicleSession (see publish() below), and vin only ever reaches the
// registry via vinTopicSegmentSchema-validated MQTT topic publishes or
// the vehicles-route.ts REST param, both already-validated entry points.
function buildIngestUrl(vin: string): string | undefined {
  const base = process.env.VIDEO_RTSP_BASE_URL;
  if (!base) return undefined;
  return `${base.replace(/\/$/, '')}/${vin}`;
}

function publish(client: MqttClient, vin: string, action: 'start' | 'stop'): void {
  const session = getActiveSession(vin);
  if (!session) {
    // Nothing to start/stop if the bot isn't in an active session — the
    // common path is an operator opening a vehicle's page after its
    // session has already started, so this is a real but secondary case.
    // Known limitation: a viewer who opens the page before the session
    // starts won't get video auto-started once it does; they'd need to
    // re-navigate. Not worth reacting to session-start for already-open
    // viewers in this first pass (see the plan's viewer-lifecycle
    // decision — same "skip if it adds complexity without a demonstrated
    // need" reasoning already applied to the grace-period debounce).
    logger.debug({ vin, action }, 'skipping video control publish: no active session');
    return;
  }

  const ingestUrl = action === 'start' ? buildIngestUrl(vin) : undefined;
  if (action === 'start' && !ingestUrl) {
    logger.error({ vin }, 'VIDEO_RTSP_BASE_URL not configured — cannot start video');
    return;
  }

  // commandId hoisted out of the payload literal so the success/failure
  // logs below can include it too — it's the field the bot echoes back in
  // its VideoStatus reply, so it's what ties a log line here to one there.
  const commandId = randomUUID();

  publishVideoControl(client, {
    vinNumber: vin,
    sessionId: session.sessionId,
    commandId,
    action,
    targetBitrateKbps: action === 'start' ? TARGET_BITRATE_KBPS : undefined,
    targetWidth: action === 'start' ? TARGET_WIDTH : undefined,
    targetHeight: action === 'start' ? TARGET_HEIGHT : undefined,
    targetFps: action === 'start' ? TARGET_FPS : undefined,
    ingestUrl,
    issuedAtMs: Date.now()
  })
    .then(() => {
      // The one line to grep for to confirm a start/stop actually went
      // out — matches the existing e-stop precedent (vehicles-route.ts's
      // 'e-stop issued'), which also logs success at info, not just
      // failure at error. Without this, there was no positive
      // confirmation in the logs at all, only the absence of an error.
      logger.info({ vin, action, commandId, ingestUrl }, 'video control command published');
    })
    .catch((err: unknown) => {
      logger.error({ err, vin, action, commandId }, 'video control publish failed');
    });
}

// Called from socket-server.ts when a socket subscribes to a vehicle
// (piggybacking on the existing subscribe-vehicle event — see CLAUDE.md's
// "Video control / status" Bot Message Architecture entry). Only
// publishes START on the 0->1 viewer-count transition — MediaMTX fans a
// stream out to multiple viewers for free, so a second viewer opening the
// same vehicle's page must not trigger a second START.
export function handleVideoViewerJoin(socketId: string, vin: string): void {
  if (addVideoViewer(socketId, vin) !== 'started') return;
  const client = getMqttClient();
  if (!client) {
    logger.error({ vin }, 'mqtt client unavailable — cannot start video');
    return;
  }
  publish(client, vin, 'start');
}

// Called on an explicit unsubscribe-vehicle. Only publishes STOP on the
// ->0 transition — stopping on the first viewer to leave would cut off
// everyone else still watching.
export function handleVideoViewerLeave(socketId: string, vin: string): void {
  if (removeVideoViewer(socketId, vin) !== 'stopped') return;
  const client = getMqttClient();
  if (!client) {
    logger.error({ vin }, 'mqtt client unavailable — cannot stop video');
    return;
  }
  publish(client, vin, 'stop');
}

// Called on socket disconnect (closed tab, dropped network) — same "don't
// rely on a clean goodbye" principle already used for the bot's own
// missed-heartbeat self-stop, applied to viewers instead of the bot.
export function handleVideoViewerSocketDisconnect(socketId: string): void {
  const stoppedVins = removeAllVideoViewersForSocket(socketId);
  if (stoppedVins.length === 0) return;
  const client = getMqttClient();
  if (!client) {
    logger.error({ vins: stoppedVins }, 'mqtt client unavailable — cannot stop video');
    return;
  }
  for (const vin of stoppedVins) publish(client, vin, 'stop');
}
