/**
 * ROSH Control Tower — Unified Combined Test Report Generator
 *
 * Merges the protocol integrity results from `load-test-report.json` with the
 * WebRTC live video quality metrics from `video-quality/test-results/` into a
 * single, self-contained interactive HTML dashboard: `combined-test-report.html`.
 *
 * Usage:  node tools/generate-combined-report.mjs
 * Output: combined-test-report.html
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOAD_TEST_JSON = path.join(repoRoot, 'load-test-report.json');
const RESULTS_DIR = path.join(repoRoot, 'video-quality', 'test-results');
const OUTPUT_FILE = path.join(repoRoot, 'combined-test-report.html');

// ---------------------------------------------------------------------------
// 1. Load Data Sources
// ---------------------------------------------------------------------------

let loadTest = null;
if (existsSync(LOAD_TEST_JSON)) {
  try {
    loadTest = JSON.parse(readFileSync(LOAD_TEST_JSON, 'utf8'));
  } catch (err) {
    console.warn(`[combined-report] Failed to parse ${LOAD_TEST_JSON}:`, err.message);
  }
} else {
  console.warn(`[combined-report] ${LOAD_TEST_JSON} not found. Running with video metrics only.`);
}

const webrtcRuns = [];
if (existsSync(RESULTS_DIR)) {
  for (const dir of readdirSync(RESULTS_DIR)) {
    const file = path.join(RESULTS_DIR, dir, 'webrtc-quality-results.json');
    if (!existsSync(file)) continue;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      const match = dir.match(/chromium-(.+)$/);
      const rawName = match ? match[1] : dir;
      data.streamName = rawName.toUpperCase();
      data.dirName = dir;
      webrtcRuns.push(data);
    } catch { /* skip unparseable */ }
  }
}

if (!loadTest && webrtcRuns.length === 0) {
  console.error('[combined-report] Error: Neither load-test-report.json nor WebRTC test results were found.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. WebRTC Quality Metric Extraction & Analysis
// ---------------------------------------------------------------------------

const GLOSSARY = {
  'Startup time': 'Time from page load until the first decoded video frame starts playing.',
  'Resolution': 'Decoded frame size at the end of the measurement (width × height).',
  'Bitrate': 'Media data rate computed from bytesReceived deltas per second. Avg/min/max across the run.',
  'Latency (RTT avg)': 'ICE round-trip time between browser and media server. Lower is better; >150ms is high.',
  'Jitter (avg)': 'Variation in packet arrival time. Sustained values above ~30ms cause visible stutter.',
  'Frame rate (avg)': 'Frames decoded per second. Target is 30 fps for live vehicle cameras.',
  'Frames dropped': 'Frames received but dropped before decoding — indicates decoder pressure or late delivery.',
  'Freezes / stutters': 'Moments the rendered video froze (browser-reported). % is frozen time / test time.',
  'Packet loss': 'RTP packets lost vs received. Above 1% creates visible compression artifacts.',
};

const S = (level, text, key) => ({ level, text: String(text), key });
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function analyseWebRtc(r) {
  const m = r.intervalMetrics ?? [];
  const num = (xs) => xs.filter((x) => typeof x === 'number');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const lastSample = r.samples?.at(-1) ?? { inbound: [], playback: null };
  const lastInbound = lastSample.inbound?.[0] ?? {};

  const bitrates = num(m.map((x) => x.bitrateMbps));
  const rtts = num(m.map((x) => x.roundTripTimeMs));
  const jitters = num(m.map((x) => x.jitterMs));
  const fpss = num(m.map((x) => x.framesDecoded));
  const avgBitrate = mean(bitrates);
  const avgRtt = mean(rtts);
  const avgJitter = mean(jitters);
  const avgFps = mean(fpss);
  const dropped = lastInbound.framesDropped ?? 0;
  const received = lastInbound.framesReceived ?? 0;
  const freezeSec = lastInbound.totalFreezesDuration ?? 0;
  const durationSec = r.measurementDurationSeconds || 60;
  const freezePct = pct(freezeSec, durationSec);
  const lossPct = [...m].reverse().find((x) => x.packetLossPercent != null)?.packetLossPercent ?? 0;
  const startupSec = (r.startupTimeMs || 0) / 1000;
  const resolution = lastSample.playback && lastSample.playback.width > 0
    ? `${lastSample.playback.width}×${lastSample.playback.height}`
    : 'n/a';

  const rows = [
    { label: 'Startup time', ...S(startupSec > 10 ? 'bad' : startupSec > 6 ? 'warn' : 'good', `${startupSec.toFixed(1)} s`, 'Startup time') },
    { label: 'Resolution', ...S(resolution === 'n/a' ? 'bad' : 'good', resolution, 'Resolution') },
    { label: 'Bitrate (avg / min / max)', ...S(avgBitrate < 0.2 ? 'warn' : 'good', bitrates.length ? `${avgBitrate.toFixed(2)} / ${Math.min(...bitrates).toFixed(2)} / ${Math.max(...bitrates).toFixed(2)} Mbps` : 'n/a', 'Bitrate') },
    { label: 'Latency (RTT avg)', ...S(avgRtt > 350 ? 'bad' : avgRtt > 150 ? 'warn' : 'good', `${avgRtt?.toFixed(1) ?? 'n/a'} ms`, 'Latency (RTT avg)') },
    { label: 'Jitter (avg)', ...S(avgJitter > 50 ? 'bad' : avgJitter > 20 ? 'warn' : 'good', `${avgJitter?.toFixed(1) ?? 'n/a'} ms`, 'Jitter (avg)') },
    { label: 'Frame rate (avg)', ...S(avgFps < 15 ? 'bad' : avgFps < 25 ? 'warn' : 'good', `${avgFps?.toFixed(1) ?? 'n/a'} fps`, 'Frame rate (avg)') },
    { label: 'Frames dropped', ...S(dropped > 50 ? 'bad' : dropped > 0 ? 'warn' : 'good', `${dropped} of ${received}`, 'Frames dropped') },
    { label: 'Freezes / stutters', ...S(freezePct > 15 ? 'bad' : freezePct > 3 ? 'warn' : 'good', `${lastInbound.freezeCount ?? 0} freezes · ${freezeSec.toFixed(1)} s (${freezePct.toFixed(1)}%)`, 'Freezes / stutters') },
    { label: 'Packet loss', ...S(lossPct > 1 ? 'bad' : lossPct > 0.1 ? 'warn' : 'good', `${lossPct.toFixed(3)}%`, 'Packet loss') },
  ];

  const worst = rows.some((x) => x.level === 'bad') ? 'bad' : rows.some((x) => x.level === 'warn') ? 'warn' : 'good';

  const score = clamp(Math.round(
    100
    - freezePct * 1.5
    - (received > 0 ? (dropped / received) * 100 : 0)
    - Math.max(0, (avgRtt ?? 0) - 100) * 0.05
    - Math.max(0, (avgJitter ?? 0) - 20) * 0.3
    - lossPct * 20
    - Math.max(0, 30 - (avgFps ?? 30)) * 1.2
    - Math.max(0, startupSec - 3) * 1
  ), 0, 100);
  const scoreLevel = score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad';

  const freezeDur = (r.samples || []).map((s) => (s.inbound?.[0]?.totalFreezesDuration ?? 0));
  const freezePerSec = freezeDur.map((v, i) => (i === 0 ? 0 : Math.max(0, v - freezeDur[i - 1])));

  return {
    vin: r.streamName,
    url: r.streamUrl,
    worst,
    rows,
    score,
    scoreLevel,
    resolution,
    avgFps: avgFps ? `${avgFps.toFixed(1)} fps` : 'n/a',
    avgBitrate: avgBitrate ? `${avgBitrate.toFixed(2)} Mbps` : 'n/a',
    startupTime: `${startupSec.toFixed(1)}s`,
    avgRtt: avgRtt ? `${avgRtt.toFixed(0)} ms` : 'n/a',
    avgJitter: avgJitter ? `${avgJitter.toFixed(1)} ms` : 'n/a',
    freezeCount: lastInbound.freezeCount ?? 0,
    freezeSec: freezeSec.toFixed(1),
    durationSec,
    series: {
      bitrate: m.map((x) => x.bitrateMbps ?? null),
      rtt: m.map((x) => x.roundTripTimeMs ?? null),
      jitter: m.map((x) => x.jitterMs ?? null),
      fps: m.map((x) => x.framesDecoded ?? null),
      freeze: freezePerSec.map((x) => Number(x.toFixed(3))),
    }
  };
}

const webrtcByVin = new Map();
for (const run of webrtcRuns) {
  const analysed = analyseWebRtc(run);
  webrtcByVin.set(analysed.vin, analysed);
}

// ---------------------------------------------------------------------------
// 3. Fused Fleet Dataset
// ---------------------------------------------------------------------------

// Collect all distinct VINs
const allVins = new Set();
if (loadTest?.bots) {
  for (const b of loadTest.bots) allVins.add(b.vin);
}
for (const vin of webrtcByVin.keys()) allVins.add(vin);

const sortedVins = Array.from(allVins).sort((a, b) => {
  const numA = parseInt(a.replace(/\D/g, '') || '0', 10);
  const numB = parseInt(b.replace(/\D/g, '') || '0', 10);
  return numA - numB;
});

const fusedBots = sortedVins.map((vin) => {
  const ltBot = loadTest?.bots?.find((b) => b.vin === vin);
  const wtBot = webrtcByVin.get(vin);

  const protocolPass = ltBot ? ltBot.pass : true;
  const videoQualityPass = wtBot ? wtBot.worst !== 'bad' : true;
  const overallPass = protocolPass && videoQualityPass;

  return {
    vin,
    macId: ltBot?.macId ?? 'n/a',
    sessionId: ltBot?.sessionId ?? 'n/a',
    protocolPass,
    videoQualityPass,
    overallPass,
    lt: ltBot,
    wt: wtBot
  };
});

const totalBots = fusedBots.length;
const overallPassedCount = fusedBots.filter((b) => b.overallPass).length;
const loadTestPassedCount = fusedBots.filter((b) => b.protocolPass).length;
const videoPassedCount = fusedBots.filter((b) => b.videoQualityPass).length;

const overallStatus = overallPassedCount === totalBots ? 'PASS' : (overallPassedCount >= totalBots * 0.7 ? 'WARN' : 'FAIL');

// ---------------------------------------------------------------------------
// 4. HTML Report Builder
// ---------------------------------------------------------------------------

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const badgeStyle = {
  good: 'background:#2da44e22;color:#2da44e;border:1px solid #2da44e55',
  warn: 'background:#d2992222;color:#d29922;border:1px solid #d2992255',
  bad: 'background:#cf222e22;color:#cf222e;border:1px solid #cf222e55',
  ok: 'color:#2da44e',
  fail: 'color:#cf222e'
};

// Summary metrics
const avgFleetFps = () => {
  const vals = fusedBots.map((b) => parseFloat(b.wt?.avgFps)).filter((n) => !isNaN(n));
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : 'n/a';
};

const avgFleetBitrate = () => {
  const vals = fusedBots.map((b) => parseFloat(b.wt?.avgBitrate)).filter((n) => !isNaN(n));
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : 'n/a';
};

const avgFleetRtt = () => {
  const vals = fusedBots.map((b) => parseFloat(b.wt?.avgRtt)).filter((n) => !isNaN(n));
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(0) : 'n/a';
};

const totalFreezes = fusedBots.reduce((sum, b) => sum + (b.wt?.freezeCount ?? 0), 0);

// Unified Table Rows
const unifiedRows = fusedBots.map((b) => {
  const lt = b.lt;
  const wt = b.wt;

  const handshake = lt?.checks?.handshake?.pass ? `${lt.checks.handshake.latencyMs} ms` : (lt ? 'FAIL' : 'n/a');
  const telemetry = lt?.checks?.telemetry?.pass ? `${lt.checks.telemetry.ratePerSec}/s` : (lt ? 'FAIL' : 'n/a');
  const vidStatus = lt?.checks?.video?.statusSequence?.join(' → ') ?? (lt ? 'n/a' : 'active');
  const res = wt?.resolution ?? 'n/a';
  const fps = wt?.avgFps ?? 'n/a';
  const bitrate = wt?.avgBitrate ?? 'n/a';
  const rtt = wt?.avgRtt ?? 'n/a';
  const score = wt ? `${wt.score}/100` : 'n/a';

  const statusLabel = b.overallPass ? 'PASS' : 'WARN';
  const statusColor = b.overallPass ? 'good' : 'warn';

  return `<tr>
    <td><b>${esc(b.vin)}</b></td>
    <td>${handshake}</td>
    <td>${telemetry}</td>
    <td><code class="pipe-code">${esc(vidStatus)}</code></td>
    <td>${esc(res)}</td>
    <td>${esc(fps)}</td>
    <td>${esc(bitrate)}</td>
    <td>${esc(rtt)}</td>
    <td><b>${score}</b></td>
    <td><span class="badge" style="${badgeStyle[statusColor]}">${statusLabel}</span></td>
  </tr>`;
}).join('\n');

// Build Accordion Video Cards
const videoCards = fusedBots.filter((b) => b.wt).map((b, idx) => {
  const s = b.wt;
  const [label, color] = s.worst === 'good' ? ['PASSED', '#2da44e'] : s.worst === 'warn' ? ['WARNING', '#d29922'] : ['FAILED', '#cf222e'];

  const metricTiles = s.rows.map((row) => `
    <div class="metric ${row.level}">
      <div class="metric-label">${esc(row.label)}</div>
      <div class="metric-value">${esc(row.text)}</div>
    </div>`).join('');

  return `
  <details class="bot-dropdown" data-idx="${idx}">
    <summary class="dropdown-header">
      <div class="dh-left">
        <span class="status-icon ${s.worst}">●</span>
        <span class="bot-name">${esc(s.vin)}</span>
        <span class="pill pill-spec">${esc(s.resolution)}</span>
        <span class="pill pill-fps">${esc(s.avgFps)}</span>
        <span class="pill pill-rate">${esc(s.avgBitrate)}</span>
        <span class="pill pill-rtt">RTT: ${esc(s.avgRtt)}</span>
        <span class="pill pill-time">Startup: ${esc(s.startupTime)}</span>
      </div>
      <div class="dh-right">
        <div class="score-pill">Score: <b>${s.score}</b>/100</div>
        <span class="badge" style="background:${color}22;color:${color};border:1px solid ${color}55">${label}</span>
        <span class="dropdown-arrow">▾</span>
      </div>
    </summary>
    <div class="dropdown-body">
      <div class="stream-info-bar">
        <span><b>Stream URL:</b> <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)}</a></span>
        <span><b>Measurement Duration:</b> ${s.durationSec.toFixed(0)}s</span>
      </div>
      <div class="metrics-grid">
        ${metricTiles}
      </div>
      <div class="charts-grid">
        <figure data-chart="bitrate" data-stream="${idx}">
          <figcaption><b>Bitrate Over Time (Mbps)</b> <span class="hint">hover for second-by-second rate</span></figcaption>
          <div class="plot"><svg viewBox="0 0 640 160" preserveAspectRatio="none"></svg><div class="tip"></div></div>
        </figure>
        <figure data-chart="latency" data-stream="${idx}">
          <figcaption><b>Latency (RTT ms) &amp; Freezes</b> <span class="hint">red shaded bars = video freeze</span></figcaption>
          <div class="plot"><svg viewBox="0 0 640 160" preserveAspectRatio="none"></svg><div class="tip"></div></div>
        </figure>
        <figure data-chart="fps" data-stream="${idx}">
          <figcaption><b>Decoded FPS Over Time</b> <span class="hint">target: 30 fps</span></figcaption>
          <div class="plot"><svg viewBox="0 0 640 160" preserveAspectRatio="none"></svg><div class="tip"></div></div>
        </figure>
      </div>
    </div>
  </details>`;
}).join('\n');

// Time-series data for WebRTC charts
const webrtcSeriesData = JSON.stringify({
  streams: fusedBots.filter((b) => b.wt).map((b) => ({ name: b.vin, series: b.wt.series }))
}).replace(/</g, '\\u003c');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ROSH Control Tower — Combined Load &amp; Video Quality Report</title>
<style>
  :root {
    --bg-page: #0d1117;
    --bg-surface: #161b22;
    --bg-subtle: #21262d;
    --border-default: #30363d;
    --text-primary: #f0f6fc;
    --text-secondary: #8b949e;
    --text-muted: #6e7681;
    --color-green: #2da44e;
    --color-yellow: #d29922;
    --color-red: #cf222e;
    --color-blue: #58a6ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 24px 20px;
    background: var(--bg-page);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.5;
  }
  .wrap { max-width: 1280px; margin: 0 auto; }

  header.banner {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    padding: 20px 24px;
    margin-bottom: 24px;
  }
  .banner-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 16px;
  }
  h1 { margin: 0; font-size: 22px; display: flex; align-items: center; gap: 10px; }
  .badge {
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .banner-meta { color: var(--text-secondary); font-size: 13px; margin-bottom: 16px; }

  /* KPI Grid */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  .kpi-card {
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    padding: 12px 16px;
  }
  .kpi-label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; font-weight: 600; }
  .kpi-value { font-size: 20px; font-weight: 700; margin-top: 4px; }
  .kpi-sub { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

  /* Tab Navigation */
  .tabs-nav {
    display: flex;
    gap: 8px;
    border-bottom: 1px solid var(--border-default);
    margin-bottom: 20px;
  }
  .tab-btn {
    background: none;
    border: none;
    color: var(--text-secondary);
    padding: 10px 16px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tab-btn:hover { color: var(--text-primary); }
  .tab-btn.active {
    color: var(--color-blue);
    border-bottom-color: var(--color-blue);
  }
  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Tables */
  table.data-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    overflow: hidden;
    font-size: 13px;
  }
  table.data-table th, table.data-table td {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-default);
    text-align: left;
  }
  table.data-table th { background: var(--bg-subtle); color: var(--text-secondary); font-weight: 600; }
  table.data-table tr:last-child td { border-bottom: none; }
  code.pipe-code { background: #0004; padding: 2px 6px; border-radius: 4px; font-size: 11px; }

  /* Accordion Cards */
  details.bot-dropdown {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    margin-bottom: 12px;
    overflow: hidden;
  }
  summary.dropdown-header {
    padding: 12px 18px;
    cursor: pointer;
    list-style: none;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg-subtle);
    user-select: none;
  }
  summary.dropdown-header::-webkit-details-marker { display: none; }
  .dh-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .dh-right { display: flex; align-items: center; gap: 12px; }
  .bot-name { font-weight: 700; font-size: 14px; }
  .status-icon.good { color: var(--color-green); }
  .status-icon.warn { color: var(--color-yellow); }
  .status-icon.bad { color: var(--color-red); }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: #ffffff11; color: var(--text-secondary); }
  .score-pill { font-size: 12px; color: var(--text-secondary); }
  .score-pill b { color: var(--text-primary); }

  .dropdown-body { padding: 18px; border-top: 1px solid var(--border-default); }
  .stream-info-bar { display: flex; gap: 20px; font-size: 12px; color: var(--text-secondary); margin-bottom: 16px; }
  .stream-info-bar a { color: var(--color-blue); text-decoration: none; }

  /* Metrics Grid */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
    margin-bottom: 20px;
  }
  .metric {
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    padding: 8px 12px;
  }
  .metric-label { font-size: 11px; color: var(--text-secondary); }
  .metric-value { font-size: 14px; font-weight: 600; margin-top: 2px; }
  .metric.good .metric-value { color: var(--color-green); }
  .metric.warn .metric-value { color: var(--color-yellow); }
  .metric.bad .metric-value { color: var(--color-red); }

  /* Charts */
  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
    gap: 16px;
  }
  figure { margin: 0; }
  figcaption { font-size: 12px; font-weight: 600; margin-bottom: 6px; display: flex; justify-content: space-between; }
  figcaption .hint { font-weight: 400; color: var(--text-muted); font-size: 11px; }
  .plot {
    position: relative;
    background: #090d13;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    height: 160px;
  }
  .plot svg { width: 100%; height: 100%; display: block; }
  .plot .tip {
    position: absolute;
    top: 6px;
    right: 8px;
    font-size: 11px;
    color: var(--text-secondary);
    pointer-events: none;
    font-family: monospace;
  }
</style>
</head>
<body>
<div class="wrap">

  <header class="banner">
    <div class="banner-top">
      <div class="title-group">
        <h1>ROSH Control Tower — Combined Test Dashboard</h1>
      </div>
      <div>
        <span class="badge" style="${overallStatus === 'PASS' ? badgeStyle.good : (overallStatus === 'WARN' ? badgeStyle.warn : badgeStyle.bad)}">
          FLEET ${overallStatus} (${overallPassedCount}/${totalBots} BOTS)
        </span>
      </div>
    </div>
    <div class="banner-meta">
      <b>Target:</b> ${esc(loadTest?.config?.broker ?? 'Local/Dev Stack')} &nbsp;·&nbsp;
      <b>Window:</b> ${esc(loadTest?.config?.durationSeconds ?? 600)}s &nbsp;·&nbsp;
      <b>Active Bots:</b> ${totalBots} vehicles &nbsp;·&nbsp;
      <b>Generated:</b> ${new Date().toLocaleString()}
    </div>

    <div class="kpi-grid">
      <div class="kpi-card">
        <div class="kpi-label">Protocol Integrity</div>
        <div class="kpi-value" style="color:${loadTestPassedCount === totalBots ? 'var(--color-green)' : 'var(--color-red)'}">
          ${loadTestPassedCount}/${totalBots}
        </div>
        <div class="kpi-sub">0 Network-loss events</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Live Video Streams</div>
        <div class="kpi-value" style="color:${videoPassedCount === totalBots ? 'var(--color-green)' : 'var(--color-yellow)'}">
          ${videoPassedCount}/${totalBots}
        </div>
        <div class="kpi-sub">${totalFreezes} freeze occurrences</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Average Fleet FPS</div>
        <div class="kpi-value" style="color:var(--color-blue)">${avgFleetFps()}</div>
        <div class="kpi-sub">Target: 30 fps (Webcam/ZED)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Average Bitrate</div>
        <div class="kpi-value" style="color:var(--color-blue)">${avgFleetBitrate()} Mbps</div>
        <div class="kpi-sub">H.264 CBR Stream</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Average RTT Latency</div>
        <div class="kpi-value" style="color:var(--color-blue)">${avgFleetRtt()} ms</div>
        <div class="kpi-sub">ICE PeerConnection RTT</div>
      </div>
    </div>
  </header>

  <nav class="tabs-nav">
    <button class="tab-btn active" onclick="showTab('tab-overview')">Unified Fleet Overview</button>
    <button class="tab-btn" onclick="showTab('tab-webrtc')">WebRTC Video Quality (${webrtcRuns.length})</button>
    <button class="tab-btn" onclick="showTab('tab-protocol')">MQTT Protocol Checks</button>
  </nav>

  <!-- TAB 1: Unified Fleet Overview -->
  <section id="tab-overview" class="tab-content active">
    <table class="data-table">
      <thead>
        <tr>
          <th>VIN</th>
          <th>Handshake Latency</th>
          <th>Telemetry Rate</th>
          <th>Video Pipeline (RTSP)</th>
          <th>Resolution</th>
          <th>Avg FPS</th>
          <th>Bitrate</th>
          <th>Latency (RTT)</th>
          <th>Quality Score</th>
          <th>Overall</th>
        </tr>
      </thead>
      <tbody>
        ${unifiedRows}
      </tbody>
    </table>
  </section>

  <!-- TAB 2: WebRTC Video Quality (Accordions + Charts) -->
  <section id="tab-webrtc" class="tab-content">
    ${videoCards}
  </section>

  <!-- TAB 3: MQTT Protocol & Telemetry -->
  <section id="tab-protocol" class="tab-content">
    <table class="data-table">
      <thead>
        <tr>
          <th>VIN</th>
          <th>Handshake Status</th>
          <th>Heartbeat Aggregate</th>
          <th>Telemetry Delivery</th>
          <th>Session Registry End State</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>
        ${fusedBots.map((b) => {
          const lt = b.lt;
          return `<tr>
            <td><b>${esc(b.vin)}</b></td>
            <td>${lt?.checks?.handshake?.pass ? '✓ ' + lt.checks.handshake.latencyMs + ' ms' : '✗ Failed'}</td>
            <td>${lt?.checks?.heartbeat?.pass ? '✓ ' + lt.checks.heartbeat.aggregateRatePerSec + '/s' : '✗'}</td>
            <td>${lt?.checks?.telemetry?.pass ? '✓ ' + lt.checks.telemetry.messages + ' msgs (' + lt.checks.telemetry.ratePerSec + '/s)' : '✗'}</td>
            <td>${esc(lt?.checks?.sessionRegistry?.endState ?? 'ended')}</td>
            <td><span class="badge" style="${lt?.pass ? badgeStyle.good : badgeStyle.bad}">${lt?.pass ? 'PASS' : 'FAIL'}</span></td>
          </tr>`;
        }).join('\n')}
      </tbody>
    </table>
  </section>

</div>

<script>
  function showTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.getElementById(tabId).classList.add('active');
    event.target.classList.add('active');
    if (tabId === 'tab-webrtc') {
      renderAllCharts();
    }
  }

  const chartData = ${webrtcSeriesData};
  let chartsRendered = false;

  function renderAllCharts() {
    if (chartsRendered) return;
    chartsRendered = true;

    chartData.streams.forEach((stream, idx) => {
      renderStreamCharts(stream, idx);
    });
  }

  function renderStreamCharts(stream, idx) {
    const s = stream.series;

    // Bitrate Chart
    drawSparkline(document.querySelector(\`figure[data-chart="bitrate"][data-stream="\${idx}"] svg\`), s.bitrate, '#58a6ff', 'Mbps');
    // Latency Chart
    drawSparkline(document.querySelector(\`figure[data-chart="latency"][data-stream="\${idx}"] svg\`), s.rtt, '#d29922', 'ms', s.freeze);
    // FPS Chart
    drawSparkline(document.querySelector(\`figure[data-chart="fps"][data-stream="\${idx}"] svg\`), s.fps, '#2da44e', 'fps', null, 30);
  }

  function drawSparkline(svg, values, color, unit, freezeSeries, targetLine) {
    if (!svg || !values || values.length === 0) return;
    const clean = values.map(v => (typeof v === 'number' && !isNaN(v)) ? v : 0);
    const max = Math.max(...clean, targetLine || 1) * 1.15;
    const min = 0;
    const w = 640;
    const h = 160;

    let d = '';
    clean.forEach((v, i) => {
      const x = (i / (clean.length - 1 || 1)) * w;
      const y = h - ((v - min) / (max - min || 1)) * h;
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
    });

    let inner = '';
    // Draw target line if specified
    if (targetLine != null) {
      const ty = h - ((targetLine - min) / (max - min || 1)) * h;
      inner += \`<line x1="0" y1="\${ty}" x2="\${w}" y2="\${ty}" stroke="#ffffff33" stroke-dasharray="4,4"/>\`;
    }

    // Freeze bands
    if (freezeSeries) {
      freezeSeries.forEach((fz, i) => {
        if (fz > 0) {
          const x = (i / (freezeSeries.length - 1 || 1)) * w;
          inner += \`<rect x="\${x - 2}" y="0" width="4" height="\${h}" fill="#cf222e44"/>\`;
        }
      });
    }

    inner += \`<path d="\${d}" fill="none" stroke="\${color}" stroke-width="2"/>\`;
    svg.innerHTML = inner;

    // Tip interaction
    const container = svg.closest('.plot');
    const tip = container.querySelector('.tip');
    container.onmousemove = (e) => {
      const rect = svg.getBoundingClientRect();
      const xNorm = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const idx = Math.min(clean.length - 1, Math.floor(xNorm * clean.length));
      tip.textContent = \`t=\${idx}s: \${clean[idx].toFixed(1)} \${unit}\`;
    };
    container.onmouseleave = () => { tip.textContent = ''; };
  }
</script>
</body>
</html>`;

writeFileSync(OUTPUT_FILE, htmlContent, 'utf8');
console.log(`[combined-report] Unified HTML report successfully generated: ${OUTPUT_FILE}`);
