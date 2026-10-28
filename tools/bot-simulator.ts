// Standalone local-test tool: stands in for a real AV bot (Jetson Orin)
// so the Docker Compose stack can be exercised without hardware. Not part
// of any npm workspace — run directly with `npx tsx tools/bot-simulator.ts`
// from the repo root. Requires `npm run build --workspace=shared` to have
// been run at least once (this script imports the compiled @roshai/shared
// package, same schemas/topics/proto the backend validates against).
//
// Env vars:
//   MQTT_BROKER_URL  default mqtt://localhost:1883 (local dev, Docker host
//                    published port). Real/fielded bots reach the broker
//                    over the tailnet instead, via Traefik's existing
//                    /mqtt WSS path addressed by MagicDNS, e.g.
//                    wss://roshai-control-tower.<tailnet>.ts.net/mqtt
//   BOT_VIN          default TEST-VIN-001
//   BOT_MAC          default 00:11:22:33:44:55 — override to simulate a
//                    different bot fitted to the same BOT_VIN
//   SIM_NO_GPS       set to 1 to start without a GPS fix (telemetry still
//                    sent at 1Hz, gps_status NO_FIX, position zeroed —
//                    same as the real bot indoors)
//   SIM_GPS_TOGGLE_S flip between fix and no-fix every N seconds, to
//                    exercise both transitions on the Live page
//   BACKEND_HTTP_URL default http://localhost:3000 (local dev, Docker host
//                    published port — see docker-compose.yml). Real/fielded
//                    bots reach the backend's REST API over the tailnet via
//                    Traefik instead, same as MQTT.
//   BOT_VIDEO          explicit path to the video file this bot "streams"
//                      when told to start video — overrides the VIN-based
//                      mapping below
//   MOCK_VIDEO_DIR     directory containing the mock videos, default
//                      <repo-root>/video-test (in-repo folder holding
//                      mock_vehicle{,2,3}.mp4)
//   FFMPEG_PATH        explicit path to the ffmpeg binary. Default: `ffmpeg`
//                      from PATH, falling back to a WinGet-installed
//                      Gyan.FFmpeg under the user profile (observed not to be
//                      on Git-bash's PATH even when installed)
//   RTSP_PUBLISH_BASE  fallback RTSP base when a video/control START command
//                      carries no ingestUrl, default rtsp://localhost:8554
//                      (local MediaMTX — see tools/run-local-mediamtx.sh)
//
// While running, press "s" + Enter to publish a stop-event, or Ctrl+C to
// publish session-end and exit. Every stop path (manual, e-stop received,
// or Ctrl+C/kill signal) also uploads a PDF test report over HTTP to the
// backend's reports endpoint — mimicking what the real bot does at test
// end, not something carried over MQTT (see uploadReport() below).
//
// Video: this simulator also stands in for the real bot's camera pipeline.
// It subscribes to robot/{vin}/video/control and, on START, loops its mapped
// mock video to MediaMTX over RTSP (the same `-c copy` ffmpeg re-stream the
// mock files were published with manually before). The video file is mapped
// from the VIN unless BOT_VIDEO overrides it: TEST-VIN-001 ->
// mock_vehicle.mp4, TEST-VIN-002 -> mock_vehicle2.mp4, TEST-VIN-003 ->
// mock_vehicle3.mp4 (trailing digits of the VIN; no digits ->
// mock_vehicle.mp4). START/STOP arrive viewer-driven from the backend
// (video-control-service.ts publishes on the 0->1 / 1->0 viewer-count
// transitions), and video status (starting/streaming/stopped/error) is
// reported back on robot/video/status, same as the real bot's contract.
//
// Every bot message (handshake request/response, heartbeat, telemetry,
// command, stop-event, video control/status) is real binary protobuf now.
// Multi-vehicle topic
// scheme: three backend->bot targeted topics (handshake-response,
// command, video/control) are per-vin (robot/{vin}/...); the rest are
// fixed/shared (robot/handshake/request, robot/heartbeat, robot/
// telemetry, robot/stop-event, robot/video/status) — see
// shared/src/mqtt/topics.ts and docs/mqtt-multi-vehicle-topic-proposal.html
// for the full bot-team contract. This script also simulates the bot's
// own required deadman-switch behavior: if no heartbeat arrives within 3
// intervals, it publishes a network-loss stop-event, same as the real bot
// must.

import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import {
  MQTT_TOPICS_INBOUND,
  HEARTBEAT_TOPIC,
  commandTopic,
  handshakeResponseTopic,
  videoControlTopic,
  commandPayloadSchema,
  sessionAckPayloadSchema,
  heartbeatPayloadSchema,
  videoControlCommandSchema,
  ProtoSessionPayload,
  ProtoSessionAckPayload,
  ProtoHeartbeatPayload,
  ProtoTelemetryPayload,
  ProtoCommandPayload,
  ProtoStopEventPayload,
  ProtoVideoControlCommand,
  ProtoVideoStatus,
  SessionEventType,
  CommandAction,
  StopEventCause,
  VideoAction,
  VideoState,
  GpsStatus
} from '@roshai/shared';

function protoVideoActionToApp(
  action: VideoAction
): 'start' | 'stop' | 'set-bitrate' | undefined {
  switch (action) {
    case VideoAction.VIDEO_ACTION_START:
      return 'start';
    case VideoAction.VIDEO_ACTION_STOP:
      return 'stop';
    case VideoAction.VIDEO_ACTION_SET_BITRATE:
      return 'set-bitrate';
    default:
      return undefined;
  }
}

function protoCommandActionToApp(action: CommandAction): 'e-stop' | 'resume' | undefined {
  switch (action) {
    case CommandAction.COMMAND_ACTION_E_STOP:
      return 'e-stop';
    case CommandAction.COMMAND_ACTION_RESUME:
      return 'resume';
    default:
      return undefined;
  }
}

function appStopEventCauseToProto(
  cause: 'operator' | 'network-loss' | 'error' | 'manual-shutdown' | 'unknown'
): StopEventCause {
  switch (cause) {
    case 'operator':
      return StopEventCause.STOP_EVENT_CAUSE_OPERATOR;
    case 'network-loss':
      return StopEventCause.STOP_EVENT_CAUSE_NETWORK_LOSS;
    case 'error':
      return StopEventCause.STOP_EVENT_CAUSE_ERROR;
    case 'manual-shutdown':
      return StopEventCause.STOP_EVENT_CAUSE_MANUAL_SHUTDOWN;
    case 'unknown':
      return StopEventCause.STOP_EVENT_CAUSE_UNKNOWN;
  }
}

const brokerUrl = process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883';
const vin = process.env.BOT_VIN ?? 'TEST-VIN-001';
const sessionId = String(Math.floor(Date.now() / 1000));
// Overridable so two concurrent instances can simulate different bots
// fitted to the same vehicle (same BOT_VIN, different BOT_MAC) — needed
// to exercise the composite (vin, macId, sessionId) identity fix; a
// shared hardcoded default would make that scenario impossible to drive.
const mac = process.env.BOT_MAC ?? '00:11:22:33:44:55';

// The backend's HTTP API has no host-published port of its own reachable
// from outside Docker in the "real" Traefik/tailnet path — this default
// points at the local-dev-only port docker-compose publishes for exactly
// this kind of host-side tooling (same reasoning as MQTT_BROKER_URL's
// localhost default above). Real/fielded bots reach it over the tailnet
// via Traefik instead, same as MQTT.
const backendHttpUrl = process.env.BACKEND_HTTP_URL ?? 'http://localhost:3000';

// --- Mock camera pipeline (see header comment) ---

// `<repo-root>/video-test` — the mock files live in the in-repo video-test
// folder. import.meta.url (rather than process.cwd) so the mapping survives
// being launched from anywhere.
const mockVideoDir =
  process.env.MOCK_VIDEO_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'video-test');

// Maps this bot's VIN to its mock video unless BOT_VIDEO overrides:
// trailing digits of the VIN select mock_vehicle{,2,3}.mp4 (TEST-VIN-001 ->
// mock_vehicle.mp4); a VIN with no digits gets the first file. Returns
// undefined when the mapped file doesn't exist — startVideo reports that as
// a video-status error, same shape as the real bot's "camera not found".
function resolveMockVideo(): string | undefined {
  if (process.env.BOT_VIDEO) return process.env.BOT_VIDEO;
  const digits = /(\d+)\s*$/.exec(vin);
  const n = digits ? Number(digits[1]) : 1;
  const file = path.join(mockVideoDir, n <= 1 ? 'mock_vehicle.mp4' : `mock_vehicle${n}.mp4`);
  return existsSync(file) ? file : undefined;
}
const mockVideo = resolveMockVideo();

// `ffmpeg` from PATH first; fall back to a WinGet-installed Gyan.FFmpeg —
// on this dev machine winget links aren't on Git-bash's PATH even though the
// package is installed, and Node inherits that same PATH. FFMPEG_PATH wins
// over both.
function resolveFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const wingetPkgs = path.join(
      process.env.LOCALAPPDATA ?? '',
      'Microsoft',
      'WinGet',
      'Packages'
    );
    for (const dir of readdirSync(wingetPkgs)) {
      if (!dir.startsWith('Gyan.FFmpeg')) continue;
      for (const sub of readdirSync(path.join(wingetPkgs, dir))) {
        const candidate = path.join(wingetPkgs, dir, sub, 'bin', 'ffmpeg.exe');
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // WinGet dir unreadable/absent — rely on PATH below.
  }
  return 'ffmpeg';
}
const ffmpegPath = resolveFfmpegPath();

const rtspPublishBase = (process.env.RTSP_PUBLISH_BASE ?? 'rtsp://localhost:8554').replace(
  /\/$/,
  ''
);

let ffmpegProc: ChildProcess | null = null;
// Distinguishes an intentional kill (STOP command, e-stop, shutdown) from a
// crash — only the latter transitions status to error.
let ffmpegStopping = false;
let lastVideoCommandId = '';
let ffmpegStreamingTimer: ReturnType<typeof setTimeout> | undefined;
let ffmpegKillTimer: ReturnType<typeof setTimeout> | undefined;

function publishVideoStatus(
  state: 'starting' | 'streaming' | 'stopped' | 'error',
  commandId: string,
  errorMessage?: string
): void {
  const protoState =
    state === 'starting'
      ? VideoState.VIDEO_STATE_STARTING
      : state === 'streaming'
        ? VideoState.VIDEO_STATE_STREAMING
        : state === 'stopped'
          ? VideoState.VIDEO_STATE_STOPPED
          : VideoState.VIDEO_STATE_ERROR;
  const bytes = ProtoVideoStatus.encode(
    ProtoVideoStatus.fromPartial({
      vinNumber: vin,
      sessionId,
      commandId,
      state: protoState,
      ...(errorMessage ? { errorMessage } : {}),
      reportedAtMs: Date.now()
    })
  ).finish();
  client.publish(MQTT_TOPICS_INBOUND.videoStatus, Buffer.from(bytes), { qos: 1 }, (err) => {
    if (err)
      console.error(`[bot-sim] publish failed on ${MQTT_TOPICS_INBOUND.videoStatus}:`, err.message);
  });
  console.log('[bot-sim] published video-status', { vin, state, commandId, errorMessage });
}

function stopFfmpeg(reportStopped: boolean): void {
  clearTimeout(ffmpegStreamingTimer);
  clearTimeout(ffmpegKillTimer);
  const proc = ffmpegProc;
  ffmpegProc = null;
  if (!proc || proc.killed || proc.exitCode !== null) return;
  ffmpegStopping = true;
  proc.kill('SIGTERM');
  // Escalate if ffmpeg ignores SIGTERM (Windows ffmpeg usually exits on the
  // first signal, but a stuck TCP connect to a dead MediaMTX can hang it).
  ffmpegKillTimer = setTimeout(() => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  }, 3000);
  if (reportStopped) publishVideoStatus('stopped', lastVideoCommandId);
}

function startFfmpeg(command: { commandId: string; ingestUrl?: string }): void {
  stopFfmpeg(false);
  lastVideoCommandId = command.commandId;

  if (!mockVideo) {
    publishVideoStatus(
      'error',
      command.commandId,
      `mock video for VIN ${vin} not found in ${mockVideoDir} (set BOT_VIDEO or MOCK_VIDEO_DIR)`
    );
    return;
  }

  const url = command.ingestUrl ?? `${rtspPublishBase}/${vin}`;
  // -stream_loop -1: loop the file indefinitely (a vehicle camera never
  // EOFs). -c copy: no re-encode, same as the manual mock publishing —
  // cheap, and these files are already H.264. -rtsp_transport tcp: required
  // by the bot-team contract for rtspclientsink-style push.
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-stream_loop',
    '-1',
    '-re',
    '-i',
    mockVideo,
    '-c',
    'copy',
    '-rtsp_transport',
    'tcp',
    '-f',
    'rtsp',
    url
  ];
  console.log('[bot-sim] starting video push', { vin, url, mockVideo, ffmpegPath });
  publishVideoStatus('starting', command.commandId);

  let stderrTail = '';
  try {
    ffmpegProc = spawn(ffmpegPath, args);
  } catch (err) {
    publishVideoStatus('error', command.commandId, `ffmpeg spawn failed: ${String(err)}`);
    return;
  }
  const proc = ffmpegProc;
  ffmpegStopping = false;

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });
  proc.on('error', (err) => {
    if (ffmpegProc !== proc) return;
    ffmpegProc = null;
    publishVideoStatus('error', command.commandId, `ffmpeg failed to start: ${err.message}`);
  });
  proc.on('exit', (code) => {
    clearTimeout(ffmpegStreamingTimer);
    if (ffmpegProc !== proc) return;
    ffmpegProc = null;
    if (ffmpegStopping) return; // already reported stopped by stopFfmpeg
    publishVideoStatus(
      'error',
      command.commandId,
      `ffmpeg exited unexpectedly (code ${code}): ${stderrTail.trim().slice(-300) || 'no output'}`
    );
  });

  // Declare streaming once ffmpeg has stayed alive past startup — the real
  // bot reports STREAMING when its pipeline is up, which for us is "spawned
  // and didn't immediately die".
  ffmpegStreamingTimer = setTimeout(() => {
    if (ffmpegProc === proc && proc.exitCode === null) {
      publishVideoStatus('streaming', command.commandId);
    }
  }, 1000);
}

// Mirrors backend/src/lib/heartbeat-service.ts's 500ms interval and the
// business requirement's "3 consecutive missed = stop" rule. +300ms
// margin absorbs local jitter/scheduling delay rather than firing on the
// first slightly-late tick.
const HEARTBEAT_INTERVAL_MS = 500;
const MISSED_HEARTBEAT_LIMIT = 3;
const HEARTBEAT_TIMEOUT_MS = MISSED_HEARTBEAT_LIMIT * HEARTBEAT_INTERVAL_MS + 300;

let hasGpsFix = process.env.SIM_NO_GPS !== '1';
const gpsToggleSeconds = Number(process.env.SIM_GPS_TOGGLE_S ?? 0);
if (gpsToggleSeconds > 0) {
  setInterval(() => {
    hasGpsFix = !hasGpsFix;
    console.log(`[bot-sim] GPS ${hasGpsFix ? 'fix acquired' : 'fix lost'}`);
  }, gpsToggleSeconds * 1000).unref(); // never keeps the process alive on shutdown
}
let lat = 37.7749;
let lon = -122.4194;

function now(): string {
  return new Date().toISOString();
}

function publishHandshake(client: mqtt.MqttClient, eventType?: SessionEventType): void {
  const bytes = ProtoSessionPayload.encode(
    ProtoSessionPayload.fromPartial({
      vinNumber: vin,
      macId: mac,
      sessionId,
      ...(eventType !== undefined ? { eventType } : {})
    })
  ).finish();
  client.publish(MQTT_TOPICS_INBOUND.handshakeRequest, Buffer.from(bytes), { qos: 1 }, (err) => {
    if (err)
      console.error(
        `[bot-sim] publish failed on ${MQTT_TOPICS_INBOUND.handshakeRequest}:`,
        err.message
      );
  });
  console.log(
    `[bot-sim] published handshake request (${eventType === SessionEventType.SESSION_EVENT_TYPE_SESSION_END ? 'session-end' : 'session-start'})`,
    {
      vin,
      mac,
      sessionId
    }
  );
}

console.log(`[bot-sim] connecting to ${brokerUrl} as VIN ${vin} (anonymous)`);
const client = mqtt.connect(brokerUrl, {
  clientId: `bot-sim-${vin}-${process.pid}`,
  connectTimeout: 10_000,
  reconnectPeriod: 2_000
});

let telemetryTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatWatchdog: ReturnType<typeof setInterval> | undefined;
let lastHeartbeatAt: number | null = null;
let signalLostReported = false;

// mqtt.js's 'connect' event fires on every successful CONNACK, including
// reconnects after a network drop (not just the first connect) — this
// handler's unconditional publishHandshake(client) call below therefore
// already satisfies the new bot-team convention of re-handshaking after
// any reconnect, not just on power-on (see
// docs/mqtt-multi-vehicle-topic-proposal.html), without needing separate
// reconnect-specific logic.
client.on('connect', () => {
  console.log('[bot-sim] connected');

  // Ordering matters now that handshake-response is a per-vin topic
  // (robot/{vin}/handshake/response): MQTT does not redeliver a message
  // to a client that subscribes after it was published, so this bot must
  // be subscribed to its own response topic BEFORE it publishes its
  // request — subscribing late means silently missing its own ack. Same
  // reasoning applies to the command topic (robot/{vin}/command):
  // subscribe first, in case an e-stop arrives before the handshake ack.
  client.subscribe(commandTopic(vin), { qos: 1 }, (err) => {
    if (err) console.error('[bot-sim] command subscribe failed:', err.message);
    else console.log(`[bot-sim] subscribed to ${commandTopic(vin)}`);
  });

  client.subscribe(handshakeResponseTopic(vin), { qos: 1 }, (err) => {
    if (err) console.error('[bot-sim] handshake-response subscribe failed:', err.message);
    else console.log(`[bot-sim] subscribed to ${handshakeResponseTopic(vin)}`);
  });

  client.subscribe(HEARTBEAT_TOPIC, { qos: 0 }, (err) => {
    if (err) console.error('[bot-sim] heartbeat subscribe failed:', err.message);
    else console.log(`[bot-sim] subscribed to ${HEARTBEAT_TOPIC}`);
  });

  // Subscribe to video control before handshaking, same late-subscribe-loses-
  // messages reasoning as the command topic: if a viewer is already on this
  // vehicle's page when we (re)connect, the backend's START could land
  // between our handshake being processed and a later subscribe.
  client.subscribe(videoControlTopic(vin), { qos: 1 }, (err) => {
    if (err) console.error('[bot-sim] video/control subscribe failed:', err.message);
    else console.log(`[bot-sim] subscribed to ${videoControlTopic(vin)}`);
  });

  publishHandshake(client);

  // Simulates the real bot's required deadman-switch behavior: if no
  // heartbeat arrives within 3 intervals, treat the control-center link
  // as lost and stop the vehicle (here: publish a network-loss stop-event,
  // same as the real bot would).
  heartbeatWatchdog = setInterval(() => {
    if (lastHeartbeatAt === null || signalLostReported) return;
    if (Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
      signalLostReported = true;
      console.warn(
        `[bot-sim] *** no heartbeat for >${HEARTBEAT_TIMEOUT_MS}ms — signal lost, stopping vehicle`
      );
      publishStopEvent('network-loss', 'no heartbeat received within the missed-heartbeat limit');
    }
  }, 250);

  telemetryTimer = setInterval(() => {
    lat += (Math.random() - 0.5) * 0.0005;
    lon += (Math.random() - 0.5) * 0.0005;
    const telemetry = {
      vinNumber: vin,
      timestamp: now(),
      speedMps: Math.round(Math.random() * 8 * 100) / 100,
      headingDeg: Math.round(Math.random() * 360),
      // No fix: keep publishing (telemetry is the backend's proof of life)
      // but flag it and zero the position, per the bot-team contract.
      gpsStatus: hasGpsFix ? GpsStatus.GPS_STATUS_FIX : GpsStatus.GPS_STATUS_NO_FIX,
      latitude: hasGpsFix ? lat : 0,
      longitude: hasGpsFix ? lon : 0,
      altitude: hasGpsFix ? 10 : 0
    };
    const bytes = ProtoTelemetryPayload.encode(
      ProtoTelemetryPayload.fromPartial(telemetry)
    ).finish();
    // QoS 0 — spec-agreed loss-tolerant (a missed reading is fine, just
    // move to the next), same reasoning as the heartbeat's QoS 0.
    client.publish(MQTT_TOPICS_INBOUND.telemetry, Buffer.from(bytes), { qos: 0 }, (err) => {
      if (err)
        console.error(`[bot-sim] publish failed on ${MQTT_TOPICS_INBOUND.telemetry}:`, err.message);
    });
    console.log('[bot-sim] telemetry', telemetry);
  }, 1000); // 1Hz — bot team confirmed Aug 2026 (unrelated to the separate 500ms heartbeat)
});

client.on('message', (topic, payloadBuffer) => {
  if (topic === HEARTBEAT_TOPIC) {
    let decoded: ReturnType<typeof ProtoHeartbeatPayload.decode>;
    try {
      decoded = ProtoHeartbeatPayload.decode(payloadBuffer);
    } catch (err) {
      console.warn(`[bot-sim] received invalid heartbeat protobuf on ${topic}:`, err);
      return;
    }
    const result = heartbeatPayloadSchema.safeParse(decoded);
    if (!result.success) {
      console.warn(
        `[bot-sim] received invalid heartbeat payload on ${topic}:`,
        result.error.message
      );
      return;
    }
    lastHeartbeatAt = Date.now();
    signalLostReported = false;
    console.log(`[bot-sim] heartbeat #${result.data.sequence}`);
    return;
  }

  if (topic === handshakeResponseTopic(vin)) {
    let decoded: ReturnType<typeof ProtoSessionAckPayload.decode>;
    try {
      decoded = ProtoSessionAckPayload.decode(payloadBuffer);
    } catch (err) {
      console.warn(`[bot-sim] received invalid handshake-response protobuf on ${topic}:`, err);
      return;
    }
    const result = sessionAckPayloadSchema.safeParse(decoded);
    if (!result.success) {
      console.warn(
        `[bot-sim] received invalid handshake-response payload on ${topic}:`,
        result.error.message
      );
      return;
    }
    console.log(`[bot-sim] *** received handshake response on ${topic}:`, result.data);
    return;
  }

  if (topic === videoControlTopic(vin)) {
    let decoded: ReturnType<typeof ProtoVideoControlCommand.decode>;
    try {
      decoded = ProtoVideoControlCommand.decode(payloadBuffer);
    } catch (err) {
      console.warn(`[bot-sim] received invalid video/control protobuf on ${topic}:`, err);
      return;
    }
    const result = videoControlCommandSchema.safeParse({
      vinNumber: decoded.vinNumber,
      sessionId: decoded.sessionId,
      commandId: decoded.commandId,
      action: protoVideoActionToApp(decoded.action ?? VideoAction.VIDEO_ACTION_UNSPECIFIED),
      targetBitrateKbps: decoded.targetBitrateKbps || undefined,
      targetWidth: decoded.targetWidth || undefined,
      targetHeight: decoded.targetHeight || undefined,
      targetFps: decoded.targetFps || undefined,
      ingestUrl: decoded.ingestUrl || undefined,
      issuedAtMs: decoded.issuedAtMs
    });
    if (!result.success) {
      console.warn(
        `[bot-sim] received invalid video/control payload on ${topic}:`,
        result.error.message
      );
      return;
    }
    const command = result.data;
    console.log(`[bot-sim] *** received video/control on ${topic}:`, {
      action: command.action,
      commandId: command.commandId,
      ingestUrl: command.ingestUrl
    });

    if (command.action === 'start') {
      startFfmpeg(command);
    } else if (command.action === 'stop') {
      stopFfmpeg(true);
    } else {
      // set-bitrate: a looped file push has nothing to throttle — accept and
      // ignore, same as a real bot that can't go below its floor.
      console.log('[bot-sim] set-bitrate acknowledged (no-op for mock video)');
    }
    return;
  }

  if (topic !== commandTopic(vin)) {
    console.warn(`[bot-sim] received message on unexpected topic ${topic}`);
    return;
  }

  let decoded: ReturnType<typeof ProtoCommandPayload.decode>;
  try {
    decoded = ProtoCommandPayload.decode(payloadBuffer);
  } catch (err) {
    console.warn(`[bot-sim] received invalid command protobuf on ${topic}:`, err);
    return;
  }

  const result = commandPayloadSchema.safeParse({
    vinNumber: decoded.vinNumber,
    action: protoCommandActionToApp(decoded.action ?? CommandAction.COMMAND_ACTION_UNSPECIFIED),
    issuedAt: decoded.issuedAt,
    issuedBy: decoded.issuedBy
  });
  if (!result.success) {
    console.warn(`[bot-sim] received invalid command payload on ${topic}:`, result.error.message);
    return;
  }
  console.log(`[bot-sim] *** received command on ${topic}:`, result.data);

  if (result.data.action === 'e-stop') {
    console.warn('[bot-sim] *** e-stop command received — stopping vehicle');
    if (telemetryTimer) {
      clearInterval(telemetryTimer);
      telemetryTimer = undefined;
    }
    // Disarm the deadman-switch watchdog too — otherwise it sees the
    // heartbeats the backend correctly stops sending on this same
    // stop-event as a network-loss condition and fires a redundant
    // second stop-event ~1.8s later.
    if (heartbeatWatchdog) {
      clearInterval(heartbeatWatchdog);
      heartbeatWatchdog = undefined;
    }
    signalLostReported = true;
    lastHeartbeatAt = null;
    stopFfmpeg(false); // e-stop stops everything, camera included
    publishStopEvent('operator', 'e-stop command received');
    void uploadReport(); // fire-and-forget: process keeps running after an e-stop, no exit to block
  }
});

client.on('error', (err) => console.error('[bot-sim] mqtt error:', err.message));
client.on('reconnect', () => console.warn('[bot-sim] reconnecting...'));
client.on('close', () => console.warn('[bot-sim] connection closed'));

function publishStopEvent(
  cause: 'operator' | 'network-loss' | 'error' | 'manual-shutdown' | 'unknown',
  reason?: string
): void {
  const timestampMs = Date.now();
  const stopEvent = {
    vinNumber: vin,
    timestampMs,
    cause: appStopEventCauseToProto(cause),
    ...(reason ? { reason } : {})
  };
  const bytes = ProtoStopEventPayload.encode(ProtoStopEventPayload.fromPartial(stopEvent)).finish();
  client.publish(MQTT_TOPICS_INBOUND.stopEvent, Buffer.from(bytes), { qos: 1 }, (err) => {
    if (err)
      console.error(`[bot-sim] publish failed on ${MQTT_TOPICS_INBOUND.stopEvent}:`, err.message);
  });
  console.log('[bot-sim] published stop-event', { vin, timestampMs, cause, reason });
}

// Minimal fixture PDF — enough to pass the backend's magic-byte check and
// render in a modern viewer (no xref table; Chrome and most readers
// recover fine via object-scanning), not a spec-perfect PDF. Real bots
// generate an actual report; this just stands in for one during local
// testing.
const FIXTURE_PDF = Buffer.from(
  '%PDF-1.1\n' +
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n' +
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
    '3 0 obj << /Type /Page /Parent 2 0 R /Resources << >> /MediaBox [0 0 200 200] >> endobj\n' +
    'trailer << /Root 1 0 R >>\n' +
    '%%EOF\n',
  'ascii'
);

// Mimics the HTTP upload the real Jetson/C++ bot will do (via libcurl) at
// the same stop points — see the API contract documented for the bot
// team. Best-effort: logs and continues rather than throwing, so a failed
// upload never blocks the bot's own stop/shutdown sequence. A single
// attempt is enough for this test double; bounded retry logic belongs in
// the real bot's C++ client, not duplicated here.
async function uploadReport(): Promise<void> {
  const checksum = createHash('sha256').update(FIXTURE_PDF).digest('hex');
  const formData = new FormData();
  formData.append('sessionId', sessionId);
  formData.append('checksum', checksum);
  formData.append('file', new Blob([FIXTURE_PDF], { type: 'application/pdf' }), 'report.pdf');

  try {
    const res = await fetch(
      `${backendHttpUrl}/api/v1/vehicles/${encodeURIComponent(vin)}/reports`,
      {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(10_000)
      }
    );
    if (!res.ok) {
      console.warn(`[bot-sim] report upload failed: HTTP ${res.status}`);
      return;
    }
    console.log('[bot-sim] report uploaded', { vin, sessionId, sizeBytes: FIXTURE_PDF.length });
  } catch (err) {
    console.warn('[bot-sim] report upload failed:', err instanceof Error ? err.message : err);
  }
}

const rl = readline.createInterface({ input: process.stdin });
console.log('[bot-sim] press "s" + Enter to publish a stop-event, "q" or Ctrl+C to exit');
rl.on('line', (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === 's') {
    publishStopEvent('operator', 'manual stop-event triggered from bot-simulator');
    void uploadReport(); // fire-and-forget: process keeps running after a manual stop, no exit to block
  } else if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
    void shutdown();
  }
});
rl.on('close', () => {
  void shutdown();
});

let isShuttingDown = false;
// The kill-signal path: this is the one exit point where the upload is
// actually awaited before the process dies, since there's no "after" for
// a fire-and-forget call to run in once exit proceeds.
async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('\n[bot-sim] shutting down: publishing session-end');
  if (telemetryTimer) clearInterval(telemetryTimer);
  if (heartbeatWatchdog) clearInterval(heartbeatWatchdog);
  stopFfmpeg(false);
  await uploadReport();
  publishHandshake(client, SessionEventType.SESSION_EVENT_TYPE_SESSION_END);
  rl.close();
  setTimeout(() => {
    client.end(false, {}, () => process.exit(0));
  }, 250); // brief delay so the publish above actually flushes before disconnect
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
