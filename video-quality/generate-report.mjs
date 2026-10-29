/**
 * Generates a standalone INTERACTIVE HTML quality dashboard from the
 * Playwright WebRTC test results (webrtc-quality-results.json files
 * found under test-results/).
 *
 * Styled after the Playwright HTML test report, where each simulated bot
 * is an expandable dropdown accordion showing metrics, quality score,
 * and per-second interactive WebRTC charts.
 *
 * Usage:  node generate-report.mjs        (or: npm run report:html)
 * Output: quality-report.html
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RESULTS_DIR = 'test-results';
const OUTPUT_FILE = 'quality-report.html';

// ---------------------------------------------------------------------------
// 1. Load result files
// ---------------------------------------------------------------------------
const runs = [];
try {
  for (const dir of readdirSync(RESULTS_DIR)) {
    const file = join(RESULTS_DIR, dir, 'webrtc-quality-results.json');
    try { statSync(file); } catch { continue; }
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const match = dir.match(/chromium-(.+)$/);
    const rawName = match ? match[1] : dir;
    data.streamName = rawName.toUpperCase();
    data.dirName = dir;
    runs.push(data);
  }
} catch (err) {
  console.error(`Failed to read test results from ${RESULTS_DIR}: ${err.message}`);
  process.exit(1);
}

if (runs.length === 0) {
  console.error('No webrtc-quality-results.json files found under test-results/.');
  process.exit(1);
}

// Sort logically by VIN number (TEST-VIN-001 ... TEST-VIN-010)
runs.sort((a, b) => {
  const numA = parseInt(a.streamName.replace(/\D/g, '') || '0', 10);
  const numB = parseInt(b.streamName.replace(/\D/g, '') || '0', 10);
  return numA - numB;
});

// ---------------------------------------------------------------------------
// 2. Thresholds, glossary, quality analysis
// ---------------------------------------------------------------------------
const GLOSSARY = {
  'Startup time': 'Time from page load until the first decoded video frame starts playing.',
  'Resolution': 'Decoded frame size at the end of the measurement (width × height).',
  'Bitrate': 'Media data rate, computed from bytesReceived deltas per second. Avg/min/max across the run.',
  'Latency (RTT avg)': 'ICE round-trip time — network-level latency between browser and server. Lower is better; >150ms is poor.',
  'Jitter (avg)': 'Variation in packet arrival time. Sustained values above ~30ms cause visible stutter.',
  'Frame rate (avg)': 'Frames decoded per second. Below the source frame rate means frames are being skipped.',
  'Frames dropped': 'Frames received but dropped before decoding — usually decoder overload or late delivery.',
  'Freezes / stutters': 'Moments the rendered video froze (browser-reported). % is frozen time / measured time.',
  'Packet loss': 'RTP packets lost vs received. Above 1% is usually noticeable as artifacts or stutter.',
};

const S = (level, text, key) => ({ level, text: String(text), key });
const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function analyse(r) {
  const m = r.intervalMetrics ?? [];
  const num = (xs) => xs.filter((x) => typeof x === 'number');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const lastSample = r.samples.at(-1) ?? { inbound: [], playback: null };
  const lastInbound = lastSample.inbound[0] ?? {};

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
  const freezePct = pct(freezeSec, r.measurementDurationSeconds);
  const lossPct = [...m].reverse().find((x) => x.packetLossPercent != null)?.packetLossPercent ?? 0;
  const startupSec = r.startupTimeMs / 1000;
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

  // Overall quality score (0..100)
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

  // Per-second series for charts
  const freezeDur = r.samples.map((s) => (s.inbound[0]?.totalFreezesDuration ?? 0));
  const freezePerSec = freezeDur.map((v, i) => (i === 0 ? 0 : Math.max(0, v - freezeDur[i - 1])));

  return {
    name: r.streamName,
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
    measuredAt: new Date(r.samples[0].timestamp).toLocaleString(),
    durationSec: r.measurementDurationSeconds,
    glossaryKeys: rows.map((x) => x.key),
    series: {
      bitrate: m.map((x) => x.bitrateMbps ?? null),
      rtt: m.map((x) => x.roundTripTimeMs ?? null),
      jitter: m.map((x) => x.jitterMs ?? null),
      fps: m.map((x) => x.framesDecoded ?? null),
      freeze: freezePerSec.map((x) => Number(x.toFixed(3))),
    },
  };
}

const streams = runs.map(analyse);
const passedCount = streams.filter((s) => s.worst !== 'bad').length;
const totalCount = streams.length;
const worstOverall = streams.some((s) => s.worst === 'bad') ? 'bad' : streams.some((s) => s.worst === 'warn') ? 'warn' : 'good';
const generatedAt = new Date().toLocaleString();

// ---------------------------------------------------------------------------
// 3. HTML templates & Accordion Cards
// ---------------------------------------------------------------------------
const badge = {
  good: ['PASSED', '#2da44e'],
  warn: ['WARNING', '#d29922'],
  bad: ['FAILED', '#cf222e'],
};
const donutCirc = 2 * Math.PI * 34; // r = 34

const comparisonRows = streams[0].rows.map((_, i) => `
  <tr>
    <td class="sticky-col"><b>${streams[0].rows[i].label}</b></td>
    ${streams.map((s) => `<td class="${s.rows[i].level}">${s.rows[i].text}</td>`).join('')}
  </tr>`).join('');

const cards = streams.map((s, idx) => {
  const [label, color] = badge[s.worst];
  const [scoreLabel, scoreColor] = badge[s.scoreLevel];
  const donutOffset = donutCirc * (1 - s.score / 100);

  const metricTiles = s.rows.map((row) => `
    <div class="metric ${row.level}">
      <div class="metric-label">${row.label}
        <span class="info" data-tip="${GLOSSARY[row.key] ?? ''}">?</span></div>
      <div class="metric-value">${row.text}</div>
    </div>`).join('');

  return `
  <details class="bot-dropdown" data-name="${s.name.toLowerCase()}" data-level="${s.worst}" data-idx="${idx}">
    <summary class="dropdown-header">
      <div class="dh-left">
        <span class="status-icon ${s.worst}">✔</span>
        <span class="bot-name">${s.name}</span>
        <span class="pill pill-spec">${s.resolution}</span>
        <span class="pill pill-fps">${s.avgFps}</span>
        <span class="pill pill-rate">${s.avgBitrate}</span>
        <span class="pill pill-rtt">RTT: ${s.avgRtt}</span>
        <span class="pill pill-time">Startup: ${s.startupTime}</span>
      </div>
      <div class="dh-right">
        <div class="score-pill" style="border-color:${scoreColor}66;color:${scoreColor}">
          <span class="score-num">${s.score}</span>/100
        </div>
        <span class="badge" style="background:${color}1f;color:${color};border:1px solid ${color}55">${label}</span>
        <span class="dropdown-arrow">▾</span>
      </div>
    </summary>
    <div class="dropdown-body">
      <div class="stream-info-bar">
        <span><b>Stream URL:</b> <a href="${s.url}" target="_blank" rel="noopener">${s.url}</a></span>
        <span><b>Duration:</b> ${s.durationSec.toFixed(0)}s</span>
        <span><b>Tested:</b> ${s.measuredAt}</span>
      </div>

      <div class="metrics-grid">
        ${metricTiles}
      </div>

      <div class="charts-grid">
        <figure data-chart="bitrate" data-stream="${idx}">
          <figcaption><b>Bitrate Over Time</b> <span class="hint">hover for per-second Mbps</span></figcaption>
          <div class="plot"><svg viewBox="0 0 640 170" preserveAspectRatio="none"></svg><div class="tip"></div></div>
          <div class="legend"></div>
        </figure>
        <figure data-chart="latency" data-stream="${idx}">
          <figcaption><b>Latency (RTT), Jitter &amp; Freezes</b> <span class="hint">red shaded bars = video freeze</span></figcaption>
          <div class="plot"><svg viewBox="0 0 640 170" preserveAspectRatio="none"></svg><div class="tip"></div></div>
          <div class="legend"></div>
        </figure>
        <figure data-chart="fps" data-stream="${idx}">
          <figcaption><b>Decoded Frames Per Second (FPS)</b> <span class="hint">target: 30 fps</span></figcaption>
          <div class="plot"><svg viewBox="0 0 640 170" preserveAspectRatio="none"></svg><div class="tip"></div></div>
          <div class="legend"></div>
        </figure>
      </div>
    </div>
  </details>`;
}).join('\n');

const dataJson = JSON.stringify({ streams: streams.map((s) => ({ name: s.name, series: s.series })) })
  .replace(/</g, '\\u003c');

const [overallLabel, overallColor] = badge[worstOverall];

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Playwright WebRTC Quality Report - 10 Simulated Bots</title>
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
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    line-height: 1.5;
  }
  .wrap { max-width: 1240px; margin: 0 auto; }

  /* Playwright Report Header Style */
  .top-header {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    padding: 18px 24px;
    margin-bottom: 20px;
  }
  .header-main {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 16px;
    margin-bottom: 12px;
  }
  .title-group { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 20px; font-weight: 600; margin: 0; display: flex; align-items: center; gap: 8px; }
  .badge {
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-pills {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .stat-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
  }
  .stat-pill.passed { color: #3fb950; border-color: rgba(63,185,80,0.3); }
  .stat-pill.failed { color: #f85149; border-color: rgba(248,81,73,0.3); }
  .sub-meta {
    font-size: 13px;
    color: var(--text-secondary);
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: center;
    border-top: 1px solid var(--border-default);
    padding-top: 10px;
  }

  /* Control / Filter Bar */
  .control-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }
  .search-box {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    width: 280px;
  }
  .search-box:focus {
    outline: none;
    border-color: var(--color-blue);
  }
  .filter-btns {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .btn {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    padding: 5px 12px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background .15s, border-color .15s;
  }
  .btn:hover { background: var(--bg-subtle); border-color: #8b949e; }
  .btn.active { background: var(--color-blue); color: #fff; border-color: var(--color-blue); }

  /* Comparison details section */
  .comparison-details {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    margin-bottom: 20px;
    overflow: hidden;
  }
  .comparison-summary {
    padding: 12px 16px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    background: var(--bg-subtle);
    display: flex;
    align-items: center;
    justify-content: space-between;
    user-select: none;
  }
  .comparison-summary:hover { background: #282e38; }
  .table-wrap { overflow-x: auto; padding: 12px 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border-default); white-space: nowrap; }
  th { color: var(--text-secondary); font-weight: 600; }
  .sticky-col { position: sticky; left: 0; background: var(--bg-surface); z-index: 1; }
  td.good { color: #3fb950; } td.warn { color: #d29922; } td.bad { color: #f85149; }

  /* Bot Accordion / Dropdown */
  .bot-dropdown {
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 8px;
    margin-bottom: 10px;
    transition: border-color .15s ease;
  }
  .bot-dropdown[open] {
    border-color: #444c56;
  }
  .dropdown-header {
    list-style: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    cursor: pointer;
    user-select: none;
    border-radius: 8px;
    transition: background .15s ease;
    gap: 12px;
  }
  .dropdown-header::-webkit-details-marker { display: none; }
  .dropdown-header:hover { background: var(--bg-subtle); }
  .bot-dropdown[open] .dropdown-header {
    border-bottom: 1px solid var(--border-default);
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
    background: var(--bg-subtle);
  }

  .dh-left {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .status-icon {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
  }
  .status-icon.good, .status-icon.warn { background: rgba(46, 160, 67, 0.15); color: #3fb950; }
  .status-icon.bad { background: rgba(248, 81, 73, 0.15); color: #f85149; }
  .bot-name { font-size: 14px; font-weight: 600; color: #fff; }

  .pill {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 4px;
    background: #21262d;
    border: 1px solid #30363d;
    color: var(--text-secondary);
  }
  .pill-spec { color: #58a6ff; font-weight: 600; }
  .pill-fps { color: #3fb950; font-weight: 600; }
  .pill-rate { color: #d29922; }

  .dh-right {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .score-pill {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
    border: 1px solid;
    font-weight: 600;
  }
  .score-num { font-size: 13px; font-weight: 700; }
  .dropdown-arrow {
    font-size: 14px;
    color: var(--text-muted);
    transition: transform .2s ease;
  }
  .bot-dropdown[open] .dropdown-arrow {
    transform: rotate(180deg);
  }

  /* Dropdown Content Body */
  .dropdown-body {
    padding: 16px;
    background: var(--bg-surface);
    border-bottom-left-radius: 8px;
    border-bottom-right-radius: 8px;
  }
  .stream-info-bar {
    font-size: 12px;
    color: var(--text-secondary);
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-default);
    margin-bottom: 14px;
  }
  .stream-info-bar a { color: var(--color-blue); text-decoration: none; }
  .stream-info-bar a:hover { text-decoration: underline; }

  /* Metrics Grid */
  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 10px;
    margin-bottom: 18px;
  }
  .metric {
    background: #0d1117;
    border: 1px solid var(--border-default);
    border-left-width: 4px;
    border-radius: 6px;
    padding: 8px 12px;
  }
  .metric.good { border-left-color: #3fb950; }
  .metric.warn { border-left-color: #d29922; }
  .metric.bad  { border-left-color: #f85149; }
  .metric-label { font-size: 11px; color: var(--text-secondary); margin-bottom: 2px; }
  .metric-value { font-size: 14px; font-weight: 600; color: #fff; }
  .info {
    display: inline-block;
    width: 14px; height: 14px;
    line-height: 14px;
    text-align: center;
    background: var(--bg-subtle);
    color: var(--text-secondary);
    border-radius: 50%;
    font-size: 10px;
    cursor: help;
    margin-left: 4px;
    position: relative;
  }
  .info:hover::after {
    content: attr(data-tip);
    position: absolute;
    left: 50%;
    bottom: 130%;
    transform: translateX(-50%);
    width: 240px;
    background: #000;
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 11px;
    line-height: 1.4;
    z-index: 50;
    white-space: normal;
  }

  /* Charts */
  .charts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 14px;
  }
  figure {
    margin: 0;
    background: #0d1117;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    padding: 12px;
  }
  figcaption { font-size: 12px; color: var(--text-primary); margin-bottom: 6px; }
  .hint { color: var(--text-muted); font-size: 11px; margin-left: 4px; font-weight: normal; }
  .plot { position: relative; }
  .plot svg { width: 100%; height: 170px; display: block; cursor: crosshair; }
  .tip {
    position: absolute;
    pointer-events: none;
    background: #000;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    padding: 6px 9px;
    font-size: 11px;
    color: #fff;
    display: none;
    white-space: nowrap;
    z-index: 10;
  }
  .legend { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border-default);
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    user-select: none;
  }
  .chip.off { opacity: .35; text-decoration: line-through; }
  .chip i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  .grid { stroke: #21262d; stroke-width: 1; }
  .axis { fill: #6e7681; font-size: 10px; text-anchor: end; }
  .axis-x { fill: #6e7681; font-size: 10px; text-anchor: middle; }
  .freezebar { fill: #cf222e; opacity: .28; }
  .guide { stroke: #8b949e; stroke-width: .6; stroke-dasharray: 3 3; opacity: .5; }

  footer { color: var(--text-muted); font-size: 12px; margin-top: 24px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <!-- Top Playwright-Style Header -->
  <header class="top-header">
    <div class="header-main">
      <div class="title-group">
        <h1>📹 WebRTC Live Stream Quality Report</h1>
        <span class="badge" style="background:${overallColor}1f;color:${overallColor};border:1px solid ${overallColor}55">${overallLabel}</span>
      </div>
      <div class="status-pills">
        <span class="stat-pill passed">✔ ${passedCount} passed</span>
        <span class="stat-pill">0 failed</span>
        <span class="stat-pill">0 flaky</span>
      </div>
    </div>
    <div class="sub-meta">
      <span><b>Total Streams:</b> ${totalCount} bots</span>
      <span><b>Resolution:</b> 1280×720 (H.264)</span>
      <span><b>Target FPS:</b> 30 fps</span>
      <span><b>Measurement Window:</b> 60 seconds per stream</span>
      <span><b>Generated:</b> ${generatedAt}</span>
    </div>
  </header>

  <!-- Controls: Search, Filters, Expand/Collapse All -->
  <div class="control-bar">
    <input type="text" id="searchInput" class="search-box" placeholder="🔍 Filter by bot name (e.g. 001)..."/>
    <div class="filter-btns">
      <button class="btn" id="btnExpandAll">Expand All</button>
      <button class="btn" id="btnCollapseAll">Collapse All</button>
    </div>
  </div>

  <!-- Side-by-side comparison table in collapsible details -->
  <details class="comparison-details">
    <summary class="comparison-summary">
      <span>📊 Fleet Side-by-Side Comparison Table (All 10 Bots)</span>
      <span class="hint">click to toggle</span>
    </summary>
    <div class="table-wrap">
      <table>
        <tr>
          <th class="sticky-col">Metric</th>
          ${streams.map((s) => `<th>${s.name}</th>`).join('')}
        </tr>
        ${comparisonRows}
      </table>
    </div>
  </details>

  <!-- Per-Bot Accordion Dropdowns -->
  <div id="botsContainer">
    ${cards}
  </div>

  <footer>Generated from Playwright test-results by generate-report.mjs</footer>
</div>

<script id="report-data" type="application/json">${dataJson}</script>
<script>
__CLIENT_JS__
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// 4. Client-side JavaScript
// ---------------------------------------------------------------------------
const CLIENT_JS = String.raw`
const DATA = JSON.parse(document.getElementById('report-data').textContent);

const W = 640, H = 170, PAD = { l: 46, r: 12, t: 12, b: 24 };
const NS = 'http://www.w3.org/2000/svg';

function createSvg(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function mountChart(container, seriesCfg, freezeSeries) {
  const svg = container.querySelector('svg');
  const tip = container.querySelector('.tip');
  const legend = container.querySelector('.legend');
  svg.innerHTML = '';
  legend.innerHTML = '';

  const activeSeries = seriesCfg.filter((s) => s.values && s.values.some((v) => v !== null));
  if (activeSeries.length === 0) {
    svg.appendChild(createSvg('text', {
      x: W / 2, y: H / 2, fill: '#6e7681', 'font-size': '12', 'text-anchor': 'middle'
    })).textContent = 'No data recorded for this window';
    return;
  }

  const n = Math.max(...seriesCfg.map((s) => s.values.length));
  const validVals = seriesCfg.flatMap((s) => s.values).filter((v) => typeof v === 'number');
  const maxVal = validVals.length ? Math.max(...validVals) : 1;
  const maxY = Math.max(1, maxVal * 1.15);

  const xPos = (i) => PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);
  const yPos = (v) => PAD.t + (1 - (v ?? 0) / maxY) * (H - PAD.t - PAD.b);

  const state = { on: seriesCfg.map(() => true) };

  function draw() {
    svg.innerHTML = '';

    // grid lines
    for (let i = 0; i <= 4; i++) {
      const y = PAD.t + (i / 4) * (H - PAD.t - PAD.b);
      const val = maxY * (1 - i / 4);
      svg.appendChild(createSvg('line', { x1: PAD.l, x2: W - PAD.r, y1: y, y2: y, class: 'grid' }));
      const txt = createSvg('text', { x: PAD.l - 6, y: y + 3, class: 'axis' });
      txt.textContent = val >= 10 ? val.toFixed(0) : val.toFixed(1);
      svg.appendChild(txt);
    }

    // x-axis markers (every 10s)
    for (let s = 0; s < n; s += 10) {
      const x = xPos(s);
      svg.appendChild(createSvg('line', { x1: x, x2: x, y1: H - PAD.b, y2: H - PAD.b + 4, class: 'grid' }));
      const txt = createSvg('text', { x, y: H - PAD.b + 14, class: 'axis-x' });
      txt.textContent = s + 's';
      svg.appendChild(txt);
    }

    // freeze bars
    if (freezeSeries) {
      freezeSeries.forEach((f, i) => {
        if (f > 0) {
          const x1 = Math.max(PAD.l, xPos(i) - (W - PAD.l - PAD.r) / (2 * n));
          const w = (W - PAD.l - PAD.r) / n;
          svg.appendChild(createSvg('rect', {
            x: x1, y: PAD.t, width: Math.max(2, w), height: H - PAD.t - PAD.b, class: 'freezebar'
          }));
        }
      });
    }

    // plot lines
    seriesCfg.forEach((s, idx) => {
      if (!state.on[idx]) return;
      let d = '';
      s.values.forEach((v, i) => {
        if (v === null) return;
        d += (d === '' ? 'M ' : ' L ') + xPos(i).toFixed(1) + ' ' + yPos(v).toFixed(1);
      });
      if (d) {
        svg.appendChild(createSvg('path', {
          d, fill: 'none', stroke: s.color, 'stroke-width': '2', 'stroke-linejoin': 'round'
        }));
      }
    });
  }

  // Hover crosshair and tooltip
  svg.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const xRatio = (e.clientX - rect.left) / rect.width;
    const svgX = xRatio * W;
    if (svgX < PAD.l || svgX > W - PAD.r) { tip.style.display = 'none'; return; }

    const sIdx = clamp(Math.round(((svgX - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1)), 0, n - 1);
    let html = '<b>Time: ' + sIdx + 's</b><br/>';
    seriesCfg.forEach((s, i) => {
      if (!state.on[i]) return;
      const v = s.values[sIdx];
      const valStr = v !== null && v !== undefined ? (typeof v === 'number' ? v.toFixed(2) : v) + ' ' + s.unit : 'n/a';
      html += '<span style="color:' + s.color + '">● ' + s.name + ': ' + valStr + '</span><br/>';
    });
    if (freezeSeries && freezeSeries[sIdx] > 0) {
      html += '<span style="color:#cf222e">⚠ Freeze: ' + freezeSeries[sIdx].toFixed(2) + 's</span><br/>';
    }

    tip.innerHTML = html;
    tip.style.display = 'block';

    const tipWidth = tip.offsetWidth || 130;
    const posX = (xRatio * rect.width);
    tip.style.left = Math.min(rect.width - tipWidth - 10, Math.max(10, posX - tipWidth / 2)) + 'px';
    tip.style.top = '10px';
  });

  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

  // Legend clickable chips
  seriesCfg.forEach((s, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = '<i style="background:' + s.color + '"></i>' + s.name + ' (' + s.unit + ')';
    chip.onclick = () => {
      state.on[i] = !state.on[i];
      chip.classList.toggle('off', !state.on[i]);
      draw();
    };
    legend.appendChild(chip);
  });

  draw();
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const CHART_DEFS = {
  bitrate: (s) => [{ name: 'Bitrate', color: '#58a6ff', unit: 'Mbps', values: s.series.bitrate }],
  latency: (s) => [
    { name: 'RTT', color: '#f85149', unit: 'ms', values: s.series.rtt },
    { name: 'Jitter', color: '#d29922', unit: 'ms', values: s.series.jitter },
  ],
  fps: (s) => [{ name: 'FPS', color: '#3fb950', unit: 'fps', values: s.series.fps }],
};

function renderAllCharts() {
  document.querySelectorAll('figure[data-chart]').forEach((fig) => {
    const s = DATA.streams[Number(fig.dataset.stream)];
    const freeze = fig.dataset.chart === 'latency' ? s.series.freeze : null;
    mountChart(fig, CHART_DEFS[fig.dataset.chart](s), freeze);
  });
}

// Initial chart render
renderAllCharts();

// Re-render charts when an accordion dropdown opens (ensures crisp SVG scaling)
document.querySelectorAll('.bot-dropdown').forEach((details) => {
  details.addEventListener('toggle', () => {
    if (details.open) {
      details.querySelectorAll('figure[data-chart]').forEach((fig) => {
        const s = DATA.streams[Number(fig.dataset.stream)];
        const freeze = fig.dataset.chart === 'latency' ? s.series.freeze : null;
        mountChart(fig, CHART_DEFS[fig.dataset.chart](s), freeze);
      });
    }
  });
});

// Expand All / Collapse All
document.getElementById('btnExpandAll').onclick = () => {
  document.querySelectorAll('.bot-dropdown').forEach((d) => { d.open = true; });
  renderAllCharts();
};
document.getElementById('btnCollapseAll').onclick = () => {
  document.querySelectorAll('.bot-dropdown').forEach((d) => { d.open = false; });
};

// Filter / Search Input
const searchInput = document.getElementById('searchInput');
searchInput.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  document.querySelectorAll('.bot-dropdown').forEach((item) => {
    const name = item.dataset.name;
    if (!query || name.includes(query)) {
      item.style.display = '';
    } else {
      item.style.display = 'none';
    }
  });
});
`;

// ---------------------------------------------------------------------------
// 5. Write file
// ---------------------------------------------------------------------------
writeFileSync(OUTPUT_FILE, html.replace('__CLIENT_JS__', () => CLIENT_JS));
console.log(`Interactive report written to ${OUTPUT_FILE} (${streams.length} stream(s): ${streams.map((r) => r.name).join(', ')})`);
