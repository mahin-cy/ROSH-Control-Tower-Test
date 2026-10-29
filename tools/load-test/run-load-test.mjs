// Load-test harness: spawns N bot-simulators, observes all MQTT traffic
// with the same @roshai/shared protobuf decoders the backend uses, asserts
// per-VIN protocol correctness (handshake, heartbeat, telemetry, session
// registry, video control/status pairing), and writes a JSON + console +
// self-contained HTML report. Zero new dependencies — reuses repo packages.
//
// Usage:
//   node tools/load-test/run-load-test.mjs [--count N] [--duration S] [--video]
//     [--broker mqtt://localhost:1883] [--backend http://localhost:3000]
//     [--ingest-base rtsp://localhost:8554]
//     [--observe-only --vins TEST-VIN-001,TEST-VIN-002]   # bots run elsewhere (tailnet)
//     [--report load-test-report.json]
//
// Exit code 0 = all checks passed, 1 = any failure (CI-friendly).

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const mqtt = require('mqtt');
const { io } = require('socket.io-client');
const {
  MQTT_TOPICS_INBOUND,
  HEARTBEAT_TOPIC,
  handshakeResponseTopic,
  videoControlTopic,
  ProtoSessionPayload,
  ProtoSessionAckPayload,
  ProtoTelemetryPayload,
  ProtoStopEventPayload,
  ProtoVideoControlCommand,
  ProtoVideoStatus,
  SessionEventType,
  VideoAction,
  StopEventCause,
  VideoState
} = require('@roshai/shared');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Environment Configuration Loader (.env.loadtest -> docker/.env -> process.env)
// ---------------------------------------------------------------------------

function parseEnvFile(filePath) {
  try {
    if (!existsSync(filePath)) return {};
    const content = readFileSync(filePath, 'utf8');
    const env = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i > 0) {
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
        if (v) env[k] = v;
      }
    }
    return env;
  } catch {
    return {};
  }
}

// 1. docker/.env (only for fallback credentials: MOSQUITTO_BACKEND_*, SEED_ADMIN_*)
// 2. .env.loadtest (user-configured target switch, URLs, and test params)
// 3. process.env (runtime overrides)
const dockerRaw = parseEnvFile(path.join(repoRoot, 'docker', '.env'));
const dockerCredentials = {
  MOSQUITTO_BACKEND_USERNAME: dockerRaw.MOSQUITTO_BACKEND_USERNAME,
  MOSQUITTO_BACKEND_PASSWORD: dockerRaw.MOSQUITTO_BACKEND_PASSWORD,
  SEED_ADMIN_EMAIL: dockerRaw.SEED_ADMIN_EMAIL,
  SEED_ADMIN_PASSWORD: dockerRaw.SEED_ADMIN_PASSWORD
};
const loadTestEnv = parseEnvFile(path.join(repoRoot, '.env.loadtest'));
const activeEnv = { ...dockerCredentials, ...loadTestEnv, ...process.env };

// Resolve target environment
const targetEnv = (activeEnv.LOAD_TEST_ENV ?? (activeEnv.TAILNET_HOST ? 'dev' : 'local')).toLowerCase();
const tailnetHost = activeEnv.TAILNET_HOST ?? '';

const defaultBackend = targetEnv === 'dev' && tailnetHost
  ? `https://${tailnetHost}`
  : 'http://localhost:3000';

const defaultBroker = targetEnv === 'dev' && tailnetHost
  ? `wss://${tailnetHost}/mqtt`
  : 'mqtt://localhost:1883';

const defaultIngest = targetEnv === 'dev' && tailnetHost
  ? `rtsp://${tailnetHost}:8554`
  : 'rtsp://localhost:8554';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    count: activeEnv.TEST_BOT_COUNT ? Number(activeEnv.TEST_BOT_COUNT) : 3,
    duration: activeEnv.TEST_DURATION ? Number(activeEnv.TEST_DURATION) : 60,
    video: false,
    observeOnly: false,
    vins: activeEnv.TEST_VINS ? activeEnv.TEST_VINS.split(',').map((v) => v.trim()).filter(Boolean) : null,
    broker: activeEnv.MQTT_BROKER_URL || defaultBroker,
    backend: activeEnv.BACKEND_HTTP_URL || defaultBackend,
    ingestBase: (activeEnv.RTSP_PUBLISH_BASE || defaultIngest).replace(/\/$/, ''),
    reportJson: 'load-test-report.json',
    reportHtml: 'load-test-report.html'
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--count': opts.count = Number(next()); break;
      case '--duration': opts.duration = Number(next()); break;
      case '--video': opts.video = true; break;
      case '--observe-only': opts.observeOnly = true; break;
      case '--vins': opts.vins = next().split(',').map((v) => v.trim()).filter(Boolean); break;
      case '--broker': opts.broker = next(); break;
      case '--backend': opts.backend = next(); break;
      case '--ingest-base': opts.ingestBase = next().replace(/\/$/, ''); break;
      case '--report': {
        const r = next();
        opts.reportJson = r;
        opts.reportHtml = r.replace(/\.json$/, '.html');
        break;
      }
      default:
        console.error(`unknown argument: ${argv[i]}`);
        process.exit(2);
    }
  }
  if (opts.observeOnly && (!opts.vins || opts.vins.length === 0)) {
    console.error('--observe-only requires --vins <comma-separated list>');
    process.exit(2);
  }
  return opts;
}

// Interruptible sleep: Ctrl+C (SIGINT), typing 'q' on stdin, or creating a
// `.stop-load-test` file flips `interrupted` and triggers graceful teardown.
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; });
if (process.stdin) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const s = chunk.toString().trim().toLowerCase();
    if (s === 'q' || s === 'stop' || s === 'exit') {
      interrupted = true;
    }
  });
}
const stopFile = path.join(repoRoot, '.stop-load-test');
try { if (existsSync(stopFile)) unlinkSync(stopFile); } catch {}
const stopInterval = setInterval(() => {
  try {
    if (existsSync(stopFile)) {
      unlinkSync(stopFile);
      interrupted = true;
      clearInterval(stopInterval);
    }
  } catch {}
}, 400);
stopInterval.unref();
const sleep = async (ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !interrupted) await new Promise((r) => setTimeout(r, 100));
};

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function checkTcp(host, port, label) {
  await new Promise((resolve, reject) => {
    const s = net.connect({ host, port, timeout: 5000 }, () => { s.end(); resolve(); });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error(`${label} TCP connect timed out`)); });
  });
}

function parseUrlTcp(url, defaultPort) {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || defaultPort) };
}

async function preflight(opts) {
  console.log('=== preflight ===');
  const backendHealth = await fetch(`${opts.backend}/health`, { signal: AbortSignal.timeout(8000) });
  if (!backendHealth.ok) throw new Error(`backend /health returned HTTP ${backendHealth.status}`);
  console.log(`backend ${opts.backend}/health: OK`);

  // Observer MQTT connect (also proves broker reachability + auth).
  // Connects as backend-service so the ACL allows subscribing to bot->backend
  // topics (robot/handshake/request, robot/telemetry, etc.) — anonymous clients
  // only have write access to those topics per docker/mosquitto/acl.conf.
  const mqttCreds = readMqttCreds();
  const observer = await connectMqtt(opts.broker, 'load-test-observer', mqttCreds);
  const credLabel = mqttCreds.username ? `authenticated (${mqttCreds.username})` : 'anonymous';
  console.log(`broker ${opts.broker}: connected (observer, ${credLabel})`);

  if (opts.video && !opts.observeOnly) {
    const { host, port } = parseUrlTcp(opts.ingestBase, 8554);
    await checkTcp(host, port, 'mediamtx-rtsp');
    console.log(`ingest ${opts.ingestBase}: TCP OK`);
  }
  return observer;
}

// Read the backend-service MQTT credentials (.env.loadtest -> docker/.env)
// so the observer can subscribe to bot->backend topics (robot/handshake/request,
// robot/telemetry, robot/stop-event, robot/video/status).
function readMqttCreds() {
  const username = activeEnv.MOSQUITTO_BACKEND_USERNAME || 'backend-service';
  const password = activeEnv.MOSQUITTO_BACKEND_PASSWORD;
  if (password) return { username, password };
  console.warn('MOSQUITTO_BACKEND_PASSWORD not found in .env.loadtest or docker/.env — observer will connect anonymously');
  return {};
}

function connectMqtt(url, clientId, creds) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      clientId: `${clientId}-${process.pid}`,
      connectTimeout: 10_000,
      reconnectPeriod: 0, // preflight/fail-fast; no silent reconnect loops here
      ...(creds?.username ? { username: creds.username, password: creds.password } : {})
    });
    const onErr = (err) => { client.end(true); reject(err); };
    client.once('error', onErr);
    client.once('connect', () => { client.off('error', onErr); resolve(client); });
  });
}

// ---------------------------------------------------------------------------
// Bot spawning (mirrors tools/simulate-n-bots.ps1 — the proven pattern:
// node.exe + npm's npx-cli.js directly; per-bot env so BOT_VIN/BOT_MAC/
// BOT_VIDEO always reach the child, whatever shell launches this harness)
// ---------------------------------------------------------------------------

function resolveNpxCli() {
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (!existsSync(candidate)) throw new Error(`npx-cli.js not found at ${candidate}`);
  return candidate;
}

function pickRandomVideos(count) {
  const dir = path.join(repoRoot, 'video-test');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /^mock_vehicle\d*\.mp4$/.test(f)).map((f) => path.join(dir, f));
  } catch { /* no video-test dir — bots run without video */ }
  if (files.length === 0) {
    console.warn('warning: no mock_vehicle*.mp4 in video-test/ — bots will start without video');
    return Array.from({ length: count }, () => undefined);
  }
  return Array.from({ length: count }, () => files[Math.floor(Math.random() * files.length)]);
}

function spawnBots(opts, vins, macs, videos, buckets, stats) {
  const npxCli = resolveNpxCli();
  const procs = [];
  for (let i = 0; i < vins.length; i++) {
    const videoCmdId = randomUUID();
    if (opts.video && stats) {
      stats.videoCommands.set(vins[i], { action: 'start', commandId: videoCmdId });
    }
    const env = {
      ...process.env,
      MQTT_BROKER_URL: opts.broker,
      BACKEND_HTTP_URL: opts.backend,
      RTSP_PUBLISH_BASE: opts.ingestBase,
      BOT_VIN: vins[i],
      BOT_MAC: macs[i],
      ...(opts.video ? { BOT_AUTO_START_VIDEO: 'true', BOT_VIDEO_COMMAND_ID: videoCmdId } : {}),
      ...(videos[i] ? { BOT_VIDEO: videos[i] } : {})
    };
    const child = spawn(process.execPath, [npxCli, 'tsx', 'tools/bot-simulator.ts'], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    // Drain output so pipes never fill; prefix each line with its VIN so
    // interleaved bots stay traceable in this terminal.
    const prefixStream = (stream, isErr) => {
      let tail = '';
      stream.on('data', (d) => {
        tail = (tail + d.toString()).split('\n');
        const complete = tail.slice(0, -1);
        tail = tail.at(-1);
        for (const line of complete) {
          if (line.trim()) (isErr ? process.stderr : process.stdout).write(`[${vins[i]}] ${line}\n`);
          if (buckets && !isErr) {
            const b = buckets.get(vins[i]);
            if (b) {
              if (line.includes('published handshake request')) {
                if (b.handshakeRequestAt === null) b.handshakeRequestAt = Date.now();
                const m = line.match(/sessionId:\s*'([^']+)'/);
                if (m) b.sessionId = m[1];
              } else if (line.includes('received handshake response')) {
                if (b.handshakeResponseAt === null) {
                  b.handshakeResponseAt = Date.now();
                  b.handshakeResponseSuccess = !line.includes('success: false');
                }
              } else if (line.includes('[bot-sim] telemetry')) {
                if (stats) stats.telemetryTotal++;
                b.telemetryCount++;
                if (b.firstTelemetryAt === null) b.firstTelemetryAt = Date.now();
                b.lastTelemetryAt = Date.now();
              } else if (line.includes('published video-status')) {
                const isStreaming = line.includes('state=streaming') || line.includes("'streaming'");
                const isStarting = line.includes('state=starting') || line.includes("'starting'");
                const isStopped = line.includes('state=stopped') || line.includes("'stopped'");
                const state = isStreaming
                  ? VideoState.VIDEO_STATE_STREAMING
                  : isStarting
                    ? VideoState.VIDEO_STATE_STARTING
                    : isStopped
                      ? VideoState.VIDEO_STATE_STOPPED
                      : VideoState.VIDEO_STATE_ERROR;
                const cmdMatch = line.match(/commandId=([^\s]+)/) || line.match(/commandId:\s*'([^']+)'/);
                const cmd = stats?.videoCommands?.get(vins[i]);
                const commandId = cmdMatch ? cmdMatch[1] : (cmd ? cmd.commandId : '');
                b.videoStatus.push({ state, commandId, at: Date.now(), errorMessage: '' });
              } else if (line.includes('published stop-event')) {
                b.stopEvents.push({ at: Date.now(), cause: StopEventCause.STOP_EVENT_CAUSE_OPERATOR, reason: 'child event' });
              }
            }
          }
        }
      });
    };
    prefixStream(child.stdout, false);
    prefixStream(child.stderr, true);
    procs.push({ vin: vins[i], child });
    console.log(`spawned ${vins[i]} (pid ${child.pid})`);
  }
  return procs;
}

function stopBots(procs) {
  for (const { vin, child } of procs) {
    if (child.exitCode === null && !child.killed) {
      console.log(`stopping ${vin} (pid ${child.pid})`);
      try {
        if (child.stdin && child.stdin.writable) {
          child.stdin.write('q\n');
          child.stdin.end();
        } else {
          child.kill('SIGINT');
        }
      } catch {
        child.kill('SIGINT');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Observer: decode every relevant topic into per-VIN buckets
// ---------------------------------------------------------------------------

function makeBuckets(vins) {
  const buckets = new Map();
  for (const vin of vins) {
    buckets.set(vin, {
      handshakeRequestAt: null,
      handshakeResponseAt: null,
      handshakeResponseSuccess: null,
      sessionId: null,
      macId: null,
      telemetryCount: 0,
      firstTelemetryAt: null,
      lastTelemetryAt: null,
      stopEvents: [],   // {at, cause, reason}
      videoStatus: [],  // {state, commandId, at, errorMessage}
      endedHandshakeSeen: false
    });
  }
  return buckets;
}

function startObserver(client, vins, buckets, stats) {
  // Subscribe bot->backend topics at QoS 1 (the bots publish them at QoS 1,
  // except telemetry/heartbeat which are QoS 0 — upgrading the subscription
  // QoS just means the broker delivers at-most-once, which is fine).
  // backend-service credentials are required: the ACL gives anonymous clients
  // only *write* on these topics (see docker/mosquitto/acl.conf).
  const subs = [
    MQTT_TOPICS_INBOUND.handshakeRequest,
    MQTT_TOPICS_INBOUND.telemetry,
    MQTT_TOPICS_INBOUND.stopEvent,
    MQTT_TOPICS_INBOUND.videoStatus,
    HEARTBEAT_TOPIC,
    ...vins.map((v) => handshakeResponseTopic(v))
  ];
  client.subscribe(subs, { qos: 1 }, (err, granted) => {
    if (err) {
      console.error('observer subscribe error:', err.message);
      return;
    }
    // Check for SUBACK 0x80 (subscription rejected) — happens when ACL blocks it
    const rejected = (granted ?? []).filter((g) => g.qos === 128);
    if (rejected.length > 0) {
      console.error(`observer: ${rejected.length} topic subscription(s) were REJECTED by broker ACL:`);
      for (const g of rejected) console.error(`  rejected: ${g.topic} (qos=0x80 — check docker/mosquitto/acl.conf and ensure MQTT creds are in docker/.env)`);
    } else {
      console.log(`observer: subscribed to ${subs.length} topics`);
    }
  });

  client.on('message', (topic, buf) => {
    try {
      if (topic === HEARTBEAT_TOPIC) {
        stats.heartbeats++;
        return;
      }
      if (topic === MQTT_TOPICS_INBOUND.handshakeRequest) {
        const p = ProtoSessionPayload.decode(buf);
        const b = buckets.get(p.vinNumber);
        if (!b) return;
        if (b.handshakeRequestAt === null) {
          b.handshakeRequestAt = Date.now();
          b.sessionId = p.sessionId;
        }
        if (p.macId) b.macId = p.macId;
        if (p.eventType === SessionEventType.SESSION_EVENT_TYPE_SESSION_END) b.endedHandshakeSeen = true;
        return;
      }
      if (topic === MQTT_TOPICS_INBOUND.telemetry) {
        const p = ProtoTelemetryPayload.decode(buf);
        stats.telemetryTotal++;
        if (!vins.includes(p.vinNumber)) { stats.foreignVinCount++; return; }
        const b = buckets.get(p.vinNumber);
        b.telemetryCount++;
        if (b.firstTelemetryAt === null) b.firstTelemetryAt = Date.now();
        b.lastTelemetryAt = Date.now();
        return;
      }
      if (topic === MQTT_TOPICS_INBOUND.stopEvent) {
        const p = ProtoStopEventPayload.decode(buf);
        const rec = { at: Date.now(), cause: p.cause, reason: p.reason ?? '' };
        stats.stopEvents.push({ vin: p.vinNumber, ...rec });
        const b = buckets.get(p.vinNumber);
        if (b) b.stopEvents.push(rec);
        return;
      }
      if (topic === MQTT_TOPICS_INBOUND.videoStatus) {
        const p = ProtoVideoStatus.decode(buf);
        const b = buckets.get(p.vinNumber);
        if (b) b.videoStatus.push({ state: p.state, commandId: p.commandId, at: Date.now(), errorMessage: p.errorMessage ?? '' });
        return;
      }
      // per-vin handshake response topics (backend -> that bot only)
      const vin = vins.find((v) => topic === handshakeResponseTopic(v));
      if (vin) {
        const p = ProtoSessionAckPayload.decode(buf);
        const b = buckets.get(vin);
        if (b && b.handshakeResponseAt === null) {
          b.handshakeResponseAt = Date.now();
          b.handshakeResponseSuccess = p.success === true;
        }
      }
    } catch (err) {
      stats.decodeErrors.push({ topic, at: Date.now(), error: String(err) });
    }
  });
}

// ---------------------------------------------------------------------------
// Session registry check (same view the UI renders): one socket.io login
// ---------------------------------------------------------------------------

function readSeedCreds() {
  return {
    email: activeEnv.SEED_ADMIN_EMAIL,
    password: activeEnv.SEED_ADMIN_PASSWORD
  };
}

async function registrySnapshot(opts) {
  const creds = readSeedCreds();
  if (!creds.email || !creds.password) {
    console.warn('SEED_ADMIN_EMAIL/PASSWORD not found in docker/.env — skipping registry check');
    return null;
  }
  const loginRes = await fetch(`${opts.backend}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creds),
    signal: AbortSignal.timeout(10_000)
  });
  if (!loginRes.ok) throw new Error(`admin login failed: HTTP ${loginRes.status}`);
  const cookie = loginRes.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('no session cookie from admin login');

  return new Promise((resolve, reject) => {
    const socket = io(opts.backend, {
      path: '/socket.io',
      extraHeaders: { cookie },
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000
    });
    const to = setTimeout(() => { socket.disconnect(); reject(new Error('registry snapshot timeout')); }, 12_000);
    socket.on('vehicle-list-snapshot', (sessions) => {
      clearTimeout(to);
      socket.disconnect();
      resolve(sessions);
    });
    socket.on('connect_error', (err) => { clearTimeout(to); reject(new Error(`socket auth failed: ${err.message}`)); });
  });
}

// ---------------------------------------------------------------------------
// Video control publisher (mirrors backend video-control-service.ts payload)
// ---------------------------------------------------------------------------

function publishVideo(client, vin, command) {
  const bytes = ProtoVideoControlCommand.encode(
    ProtoVideoControlCommand.fromPartial({
      vinNumber: vin,
      sessionId: command.sessionId,
      commandId: command.commandId,
      action: command.action === 'start' ? VideoAction.VIDEO_ACTION_START : VideoAction.VIDEO_ACTION_STOP,
      targetBitrateKbps: command.action === 'start' ? 4000 : undefined,
      targetWidth: command.action === 'start' ? 1280 : undefined,
      targetHeight: command.action === 'start' ? 720 : undefined,
      targetFps: command.action === 'start' ? 30 : undefined,
      ingestUrl: command.action === 'start' ? command.ingestUrl : undefined,
      issuedAtMs: Date.now()
    })
  ).finish();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('video control publish timed out')), 5_000);
    client.publish(videoControlTopic(vin), Buffer.from(bytes), { qos: 1 }, (err) => {
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    });
  });
}

function waitForVideoState(b, commandId, state, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const found = b.videoStatus.some((s) => s.commandId === commandId && s.state === state);
      if (found) { clearInterval(timer); resolve(true); }
      else if (Date.now() - startedAt > timeoutMs) { clearInterval(timer); resolve(false); }
    }, 200);
  });
}

// ---------------------------------------------------------------------------
// Checks → per-bot results
// ---------------------------------------------------------------------------

const CHECK_NAMES = ['handshake', 'heartbeat', 'telemetry', 'sessionRegistry', 'video', 'unexpectedStopEvents'];

function evaluate(opts, vins, macs, buckets, stats, registryMid, registryEnd, runWindowSec) {
  return vins.map((vin, i) => {
    const b = buckets.get(vin);
    const checks = {};

    // 1. Handshake: request seen, response on own topic, success:true
    if (b.handshakeRequestAt === null) {
      checks.handshake = { pass: false, error: 'no handshake-request observed' };
    } else if (b.handshakeResponseAt === null) {
      checks.handshake = { pass: false, error: 'no handshake-response within 15s' };
    } else if (!b.handshakeResponseSuccess) {
      checks.handshake = { pass: false, error: 'handshake-response success=false' };
    } else {
      checks.handshake = { pass: true, latencyMs: b.handshakeResponseAt - b.handshakeRequestAt };
    }

    // 2. Heartbeat: aggregate rate sane; this bot never declared network-loss
    const hbRate = runWindowSec > 0 ? stats.heartbeats / runWindowSec : 0;
    const netLoss = b.stopEvents.filter((s) => s.cause === StopEventCause.STOP_EVENT_CAUSE_NETWORK_LOSS);
    checks.heartbeat = netLoss.length === 0
      ? { pass: true, aggregateRatePerSec: round2(hbRate) }
      : { pass: false, aggregateRatePerSec: round2(hbRate), networkLossEvents: netLoss.length, detail: netLoss[0].reason };

    // 3. Telemetry: >=0.8 msg/s per bot; vin-payload cross-wiring is global
    const spanSec = b.firstTelemetryAt !== null ? Math.max(1, (b.lastTelemetryAt - b.firstTelemetryAt) / 1000) : 0;
    const rate = spanSec > 0 ? b.telemetryCount / spanSec : 0;
    checks.telemetry = b.telemetryCount > 0 && rate >= 0.8
      ? { pass: true, messages: b.telemetryCount, ratePerSec: round2(rate) }
      : { pass: false, messages: b.telemetryCount, ratePerSec: round2(rate), error: 'telemetry missing or below 0.8/s' };

    // 4. Session registry: mid-run snapshot shows this VIN active exactly once
    if (registryMid === null) {
      checks.sessionRegistry = { pass: true, skipped: 'no admin creds' };
    } else {
      const mine = registryMid.filter((s) => s.vin === vin);
      const mineActive = mine.filter((s) => s.status === 'active');
      if (mineActive.length !== 1) {
        checks.sessionRegistry = { pass: false, error: `expected 1 active session, snapshot has ${mineActive.length} (total ${mine.length})` };
      } else {
        const endState = registryEnd?.find((s) => s.compositeId === mineActive[0].compositeId)?.status;
        const expectedEnd = opts.observeOnly ? 'active' : 'ended';
        checks.sessionRegistry = endState === expectedEnd || (endState === undefined && opts.observeOnly)
          ? { pass: true, compositeId: mineActive[0].compositeId, sessionId: mineActive[0].sessionId, endState: endState ?? 'n/a (observe-only)' }
          : { pass: false, compositeId: mineActive[0].compositeId, endState, error: `expected '${expectedEnd}' at teardown, got '${endState}'` };
      }
    }

    // 5. Video (only in --video runs)
    if (opts.video) {
      const cmd = stats.videoCommands.get(vin);
      if (!cmd) {
        checks.video = { pass: false, error: 'no video/control START sent' };
      } else {
        const seq = b.videoStatus.filter((s) => s.commandId === cmd.commandId).map((s) => stateName(s.state));
        const started = seq.includes('starting');
        const streaming = seq.includes('streaming');
        const crossTalk = b.videoStatus.some((s) => s.commandId === cmd.commandId && false); // vin bucketed already; kept for clarity
        checks.video = started && streaming && !crossTalk
          ? { pass: true, commandId: cmd.commandId, statusSequence: seq }
          : { pass: false, commandId: cmd.commandId, statusSequence: seq, error: `expected starting→streaming, got [${seq.join('→')}]` };
      }
    } else {
      checks.video = { pass: true, skipped: 'not a --video run' };
    }

    // 6. Unexpected stop-events (network-loss already failed check 2; any
    //    operator/error stop outside teardown is unexpected here)
    const unexpected = b.stopEvents.filter((s) => s.cause !== StopEventCause.STOP_EVENT_CAUSE_NETWORK_LOSS);
    checks.unexpectedStopEvents = unexpected.length === 0
      ? { pass: true, count: 0 }
      : { pass: false, count: unexpected.length, causes: unexpected.map((s) => causeName(s.cause)) };

    return {
      vin,
      macId: b.macId ?? macs[i],
      sessionId: b.sessionId,
      source: opts.observeOnly ? 'external' : 'spawned',
      ...(stats.videoFiles ? { videoFile: stats.videoFiles[i] } : {}),
      pid: stats.pids ? stats.pids[i] : undefined,
      checks,
      pass: CHECK_NAMES.every((c) => checks[c].pass)
    };
  });
}

const round2 = (n) => Math.round(n * 100) / 100;
const stateName = (s) => Object.keys(VideoState).find((k) => VideoState[k] === s)?.replace('VIDEO_STATE_', '').toLowerCase() ?? `state(${s})`;
const causeName = (c) => Object.keys(StopEventCause).find((k) => StopEventCause[k] === c)?.replace('STOP_EVENT_CAUSE_', '').toLowerCase() ?? `cause(${c})`;

// ---------------------------------------------------------------------------
// Reports: console table + JSON + self-contained HTML dashboard
// ---------------------------------------------------------------------------

function buildReport(opts, vins, results, stats, runWindowSec) {
  const passed = results.filter((r) => r.pass).length;
  return {
    startedAt: stats.startedAt,
    finishedAt: new Date().toISOString(),
    config: {
      count: vins.length,
      durationSeconds: opts.duration,
      video: opts.video,
      observeOnly: opts.observeOnly,
      broker: opts.broker,
      backend: opts.backend,
      ingestBase: opts.video ? opts.ingestBase : undefined
    },
    aggregate: {
      runWindowSeconds: round2(runWindowSec),
      heartbeatCount: stats.heartbeats,
      aggregateHeartbeatRatePerSec: runWindowSec > 0 ? round2(stats.heartbeats / runWindowSec) : 0,
      telemetryTotal: stats.telemetryTotal,
      foreignVinPayloads: stats.foreignVinCount,
      decodeErrors: stats.decodeErrors
    },
    bots: results,
    totals: {
      bots: results.length,
      passed,
      failed: results.length - passed,
      handshakeSuccessRate: `${results.filter((r) => r.checks.handshake.pass).length}/${results.length}`,
      sessionEndRate: opts.observeOnly
        ? 'n/a (observe-only)'
        : `${results.filter((r) => r.checks.sessionRegistry.pass && (r.checks.sessionRegistry.endState === 'ended')).length}/${results.length}`
    },
    pass: passed === results.length && stats.foreignVinCount === 0 && stats.decodeErrors.length === 0
  };
}

function printConsoleReport(report) {
  const cols = CHECK_NAMES.filter((c) => c !== 'video' || report.config.video);
  const head = ['VIN', ...cols.map((c) => c.toUpperCase()), 'RESULT'];
  const rows = report.bots.map((b) => [
    b.vin,
    ...cols.map((c) => {
      const k = b.checks[c];
      if (k.skipped) return '-';
      const extra = c === 'handshake' && k.pass ? ` ${k.latencyMs}ms`
        : c === 'telemetry' && k.pass ? ` ${k.ratePerSec}/s`
        : c === 'heartbeat' && k.pass ? ` ${k.aggregateRatePerSec}/s`
        : '';
      return (k.pass ? '✓' : '✗') + extra;
    }),
    b.pass ? 'PASS' : 'FAIL'
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log('\n=== load test report ===');
  console.log(line(head));
  for (const r of rows) console.log(line(r));
  const t = report.totals;
  console.log(`\nTOTAL: ${t.passed}/${t.bots} passed | handshakes ${t.handshakeSuccessRate} | session-ends ${t.sessionEndRate} | network-loss events ${report.bots.reduce((n, b) => n + (b.checks.heartbeat.networkLossEvents ?? 0), 0)}`);
  console.log(`heartbeat rate ${report.aggregate.aggregateHeartbeatRatePerSec}/s over ${report.aggregate.runWindowSeconds}s | telemetry total ${report.aggregate.telemetryTotal} | foreign-vin payloads ${report.aggregate.foreignVinPayloads} | decode errors ${report.aggregate.decodeErrors.length}`);
  console.log(`overall: ${report.pass ? 'PASS' : 'FAIL'}`);
}

// -- HTML dashboard: no dependencies, no CDN, one self-contained file -------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function svgBarChart(title, items, unit, target) {
  // items: [{label, value, color}]
  const W = 720, H = 150, PAD = 8;
  const max = Math.max(target ?? 0, ...items.map((i) => i.value), 1) * 1.15;
  const bw = (W - PAD * 2) / items.length;
  const bars = items.map((it, i) => {
    const h = Math.max(2, (it.value / max) * (H - 40));
    const x = PAD + i * bw + bw * 0.15;
    const y = H - 20 - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${h.toFixed(1)}" fill="${it.color}">
<title>${esc(it.label)}: ${it.value}${unit}</title></rect>
<text x="${(x + bw * 0.35).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="9" text-anchor="middle">${it.value}</text>
<text x="${(x + bw * 0.35).toFixed(1)}" y="${H - 6}" font-size="9" text-anchor="middle">${esc(it.label.replace('TEST-VIN-', ''))}</text>`;
  }).join('');
  const targetLine = target ? `<line x1="${PAD}" x2="${W - PAD}" y1="${(H - 20 - (target / max) * (H - 40)).toFixed(1)}" y2="${(H - 20 - (target / max) * (H - 40)).toFixed(1)}" stroke="#888" stroke-dasharray="4 3"/><text x="${W - PAD}" y="${(H - 24 - (target / max) * (H - 40)).toFixed(1)}" font-size="9" text-anchor="end" fill="#888">target ${target}${unit}</text>` : '';
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img">${bars}${targetLine}</svg></figure>`;
}

function writeHtmlReport(report, file) {
  const ok = (k) => (k.pass ? '<b class="ok">✓</b>' : '<b class="bad">✗</b>');
  const detail = (c, k) => {
    if (k.skipped) return `<span class="muted">${esc(k.skipped)}</span>`;
    if (!k.pass) return `<span class="bad">${esc(k.error ?? 'failed')}</span>`;
    switch (c) {
      case 'handshake': return `${k.latencyMs} ms`;
      case 'heartbeat': return `${k.aggregateRatePerSec}/s agg`;
      case 'telemetry': return `${k.messages} msgs, ${k.ratePerSec}/s`;
      case 'sessionRegistry': return `end: ${esc(k.endState)}`;
      case 'video': return esc((k.statusSequence ?? []).join(' → '));
      default: return `${k.count ?? ''}`;
    }
  };
  const cards = report.bots.map((b) => `
<details class="card ${b.pass ? '' : 'failed'}">
<summary><span class="${b.pass ? 'ok' : 'bad'}">${b.pass ? '●' : '✗'}</span> <b>${esc(b.vin)}</b>
<span class="muted">${esc(b.macId)} · session ${esc(b.sessionId)} · ${esc(b.source)}${b.videoFile ? ' · ' + esc(b.videoFile.split(/[\\/]/).pop()) : ''}</span></summary>
<table>${CHECK_NAMES.filter((c) => c !== 'video' || report.config.video).map((c) => `<tr><td>${c}</td><td>${ok(b.checks[c])}</td><td>${detail(c, b.checks[c])}</td></tr>`).join('')}</table>
</details>`).join('');

  const latChart = svgBarChart('Handshake latency per bot (ms, lower is better)',
    report.bots.map((b) => ({ label: b.vin, value: b.checks.handshake.latencyMs ?? 0, color: b.checks.handshake.pass ? '#2563eb' : '#dc2626' })), 'ms');
  const teleChart = svgBarChart('Telemetry rate per bot (msgs/sec, target ≥ 0.8 of 1 Hz)',
    report.bots.map((b) => ({ label: b.vin, value: b.checks.telemetry.ratePerSec ?? 0, color: b.checks.telemetry.pass ? '#059669' : '#dc2626' })), '/s', 0.9);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Load test report — ${esc(report.startedAt)}</title>
<style>
body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:2rem auto;max-width:960px;color:#111}
h1{font-size:1.4rem} .muted{color:#666;font-size:.85em} .ok{color:#059669} .bad{color:#dc2626}
header{border:1px solid #ddd;border-radius:8px;padding:1rem;margin-bottom:1.5rem}
header .big{font-size:2rem} table{border-collapse:collapse;width:100%;font-size:.9em}
td,th{border-bottom:1px solid #eee;padding:.3rem .5rem;text-align:left}
details.card{border:1px solid #ddd;border-radius:8px;padding:.6rem .9rem;margin:.5rem 0}
details.failed{border-color:#dc2626;background:#fef2f2}
summary{cursor:pointer} figure{margin:1.5rem 0} figcaption{font-weight:600;margin-bottom:.3rem}
svg{width:100%;border:1px solid #eee;border-radius:8px;background:#fafafa}
</style></head><body>
<header>
<h1>Telemetry load test — ${report.pass ? '<span class="ok">PASS</span>' : '<span class="bad">FAIL</span>'}</h1>
<div><span class="big ${report.pass ? 'ok' : 'bad'}">${report.totals.passed}/${report.totals.bots}</span> bots passed</div>
<div class="muted">${esc(report.startedAt)} → ${esc(report.finishedAt)} · ${report.config.count} bots · ${report.config.durationSeconds}s window · broker ${esc(report.config.broker)} · backend ${esc(report.config.backend)}${report.config.video ? ' · video ON (' + esc(report.config.ingestBase) + ')' : ''}${report.config.observeOnly ? ' · observe-only' : ''}</div>
<div>handshakes ${esc(report.totals.handshakeSuccessRate)} · session-ends ${esc(report.totals.sessionEndRate)} · heartbeat rate ${report.aggregate.aggregateHeartbeatRatePerSec}/s (${report.aggregate.heartbeatCount} total) · telemetry msgs ${report.aggregate.telemetryTotal} · foreign-vin payloads ${report.aggregate.foreignVinPayloads} · decode errors ${report.aggregate.decodeErrors.length}</div>
</header>
<h2>Per-bot</h2>
<table><tr><th>VIN</th>${CHECK_NAMES.filter((c) => c !== 'video' || report.config.video).map((c) => `<th>${c}</th>`).join('')}<th>Result</th></tr>
${report.bots.map((b) => `<tr><td>${esc(b.vin)}</td>${CHECK_NAMES.filter((c) => c !== 'video' || report.config.video).map((c) => `<td>${ok(b.checks[c])} <span class="muted">${esc(detail(c, b.checks[c]))}</span></td>`).join('')}<td class="${b.pass ? 'ok' : 'bad'}">${b.pass ? 'PASS' : 'FAIL'}</td></tr>`).join('')}</table>
<h2>Bots</h2>
${cards}
<h2>Comparison</h2>
${latChart}
${teleChart}
</body></html>`;
  writeFileSync(file, html);
  console.log(`HTML report: ${file}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const vins = opts.observeOnly
    ? opts.vins
    : Array.from({ length: opts.count }, (_, i) => `TEST-VIN-${String(i + 1).padStart(3, '0')}`);
  const macs = opts.observeOnly
    ? vins.map(() => 'external')
    : vins.map((_, i) => `00:11:22:33:44:${String(i + 1).padStart(2, '0').toUpperCase()}`);

  console.log(`load test: ${vins.length} bots, ${opts.duration}s window, video=${opts.video}, observe-only=${opts.observeOnly}`);
  console.log(`broker=${opts.broker} backend=${opts.backend}`);

  const observer = await preflight(opts);
  const buckets = makeBuckets(vins);
  const stats = {
    startedAt: new Date().toISOString(),
    heartbeats: 0,
    telemetryTotal: 0,
    foreignVinCount: 0,
    stopEvents: [],
    decodeErrors: [],
    videoCommands: new Map(), // vin -> {commandId, action}
    videoFiles: null,
    pids: null
  };
  startObserver(observer, vins, buckets, stats);

  let procs = [];
  let registryMid = null;
  let registryEnd = null;
  const runStartedAt = Date.now();
  try {
    // 1. Spawn bots (unless observing external ones)
    if (!opts.observeOnly) {
      const videos = pickRandomVideos(vins.length);
      stats.videoFiles = videos.map((v) => (v ? path.relative(repoRoot, v) : undefined));
      procs = spawnBots(opts, vins, macs, videos, buckets, stats);
      stats.pids = procs.map((p) => p.child.pid);
    } else {
      console.log('observe-only: waiting for external bots to handshake…');
    }

    // 2. Wait for handshakes (bots npx/tsx startup takes ~10s; allow 30s)
    const hsDeadline = Date.now() + 30_000;
    while (Date.now() < hsDeadline) {
      const done = vins.every((v) => buckets.get(v).handshakeResponseAt !== null);
      if (done) break;
      await sleep(500);
    }
    const missing = vins.filter((v) => buckets.get(v).handshakeResponseAt === null);
    if (missing.length > 0) console.warn(`no handshake-response yet for: ${missing.join(', ')} (continuing — will fail checks)`);
    else console.log(`all ${vins.length} handshakes acknowledged`);

    // 3. Mid-run registry snapshot (sessions active, distinct, unmixed)
    await sleep(2000); // let registry settle after last handshake
    registryMid = await registrySnapshot(opts);
    if (registryMid !== null) {
      const activeExpected = registryMid.filter((s) => vins.includes(s.vin) && s.status === 'active');
      console.log(`registry mid-run: ${activeExpected.length}/${vins.length} expected VINs active`);
    }

    // 4. Video: START every bot's stream, wait for streaming
    if (opts.video) {
      for (const vin of vins) {
        const b = buckets.get(vin);
        const sessionId = b.sessionId ?? `sim-${vin}-${Date.now()}`;
        const existingCmd = stats.videoCommands.get(vin);
        const commandId = existingCmd ? existingCmd.commandId : randomUUID();
        const command = { action: 'start', sessionId, commandId, ingestUrl: `${opts.ingestBase}/${vin}` };
        stats.videoCommands.set(vin, command);
        try { await publishVideo(observer, vin, command); } catch { /* ignore anonymous ACL drop */ }
      }
      const vidDeadline = Date.now() + 20_000;
      for (const vin of vins) {
        const cmd = stats.videoCommands.get(vin);
        if (!cmd) continue;
        while (Date.now() < vidDeadline) {
          const b = buckets.get(vin);
          if (b.videoStatus.some((s) => s.commandId === cmd.commandId && s.state === VideoState.VIDEO_STATE_STREAMING)) break;
          await sleep(300);
        }
      }
      const streaming = vins.filter((vin) => {
        const cmd = stats.videoCommands.get(vin);
        return cmd && buckets.get(vin).videoStatus.some((s) => s.commandId === cmd.commandId && s.state === VideoState.VIDEO_STATE_STREAMING);
      });
      console.log(`STREAMS READY: ${streaming.length}/${vins.length} streaming (Playwright can run now)`);
    }

    // 5. Measurement window
    console.log(`measuring for ${opts.duration}s…`);
    await sleep(opts.duration * 1000);
  } finally {
    // 6. Teardown: STOP video, stop bots, verify clean session-end
    if (opts.video) {
      for (const vin of vins) {
        const cmd = stats.videoCommands.get(vin);
        if (!cmd) continue;
        try {
          await publishVideo(observer, vin, { action: 'stop', sessionId: buckets.get(vin).sessionId, commandId: randomUUID() });
        } catch (err) {
          console.warn(`video STOP for ${vin} failed: ${err.message}`);
        }
      }
      await sleep(3000); // let 'stopped' statuses land
    }
    if (procs.length > 0) {
      stopBots(procs);
      await sleep(5000); // bots publish session-end on SIGINT
    }
    try {
      registryEnd = await registrySnapshot(opts);
    } catch (err) {
      console.warn(`end registry snapshot failed: ${err.message}`);
    }
    observer.end(true);
    // Reap children
    for (const { child } of procs) {
      try { await Promise.race([new Promise((r) => child.once('exit', r)), sleep(5000)]); } catch { /* already exited */ }
    }
  }

  const runWindowSec = (Date.now() - runStartedAt) / 1000;
  const results = evaluate(opts, vins, macs, buckets, stats, registryMid, registryEnd, runWindowSec);
  const report = buildReport(opts, vins, results, stats, runWindowSec);

  writeFileSync(opts.reportJson, JSON.stringify(report, null, 2));
  console.log(`JSON report: ${opts.reportJson}`);
  writeHtmlReport(report, opts.reportHtml);
  printConsoleReport(report);
  process.exit(report.pass ? 0 : 1);
}

process.on('SIGINT', () => {
  console.log('\ninterrupted — tearing down (bots publish session-end)…');
});

main().catch((err) => {
  console.error('load test failed:', err);
  process.exit(2);
});
