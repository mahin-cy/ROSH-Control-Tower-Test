/**
 * Generates a standalone INTERACTIVE HTML quality dashboard from the
 * Playwright WebRTC test results (webrtc-quality-results.json files
 * found under test-results/).
 *
 * Interactions: hover charts for per-second values, clickable legend
 * toggles, freeze-event overlays, quality score rings, collapsible
 * stream cards, plain-English metric explanations.
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
for (const dir of readdirSync(RESULTS_DIR)) {
  const file = join(RESULTS_DIR, dir, 'webrtc-quality-results.json');
  try { statSync(file); } catch { continue; }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const match = dir.match(/chromium-(.+)$/);
  data.streamName = match ? match[1] : dir;
  runs.push(data);
}
if (runs.length === 0) {
  console.error('No webrtc-quality-results.json files found under test-results/.');
  process.exit(1);
}
runs.sort((a, b) => a.samples[0].timestamp - b.samples[0].timestamp);

// ---------------------------------------------------------------------------
// 2. Thresholds, glossary, quality score
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
  const m = r.intervalMetrics;
  const num = (xs) => xs.filter((x) => typeof x === 'number');
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const lastInbound = r.samples.at(-1).inbound[0] ?? {};

  const bitrates = num(m.map((x) => x.bitrateMbps));
  const rtts = num(m.map((x) => x.roundTripTimeMs));
  const jitters = num(m.map((x) => x.jitterMs));
  const fpss = m.map((x) => x.framesDecoded);
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

  const rows = [
    { label: 'Startup time', ...S(startupSec > 10 ? 'bad' : startupSec > 5 ? 'warn' : 'good', `${startupSec.toFixed(1)} s`, 'Startup time') },
    { label: 'Resolution', ...S('good', r.samples.at(-1).playback ? `${r.samples.at(-1).playback.width}×${r.samples.at(-1).playback.height}` : 'n/a', 'Resolution') },
    { label: 'Bitrate (avg / min / max)', ...S(avgBitrate < 0.5 ? 'warn' : 'good', bitrates.length ? `${avgBitrate.toFixed(2)} / ${Math.min(...bitrates).toFixed(2)} / ${Math.max(...bitrates).toFixed(2)} Mbps` : 'n/a', 'Bitrate') },
    { label: 'Latency (RTT avg)', ...S(avgRtt > 150 ? 'bad' : avgRtt > 50 ? 'warn' : 'good', `${avgRtt?.toFixed(1) ?? 'n/a'} ms`, 'Latency (RTT avg)') },
    { label: 'Jitter (avg)', ...S(avgJitter > 30 ? 'bad' : avgJitter > 15 ? 'warn' : 'good', `${avgJitter?.toFixed(1) ?? 'n/a'} ms`, 'Jitter (avg)') },
    { label: 'Frame rate (avg)', ...S(avgFps < 15 ? 'bad' : avgFps < 25 ? 'warn' : 'good', `${avgFps?.toFixed(1) ?? 'n/a'} fps`, 'Frame rate (avg)') },
    { label: 'Frames dropped', ...S(dropped > 50 ? 'bad' : dropped > 0 ? 'warn' : 'good', `${dropped} of ${received}`, 'Frames dropped') },
    { label: 'Freezes / stutters', ...S(freezePct > 10 ? 'bad' : freezePct > 2 ? 'warn' : 'good', `${lastInbound.freezeCount ?? 0} freezes · ${freezeSec.toFixed(1)} s (${freezePct.toFixed(1)}%)`, 'Freezes / stutters') },
    { label: 'Packet loss', ...S(lossPct > 1 ? 'bad' : lossPct > 0.1 ? 'warn' : 'good', `${lossPct.toFixed(3)}%`, 'Packet loss') },
  ];
  const worst = rows.some((x) => x.level === 'bad') ? 'bad' : rows.some((x) => x.level === 'warn') ? 'warn' : 'good';

  // Quality score: start at 100, deduct penalties, clamp 0..100
  const score = clamp(Math.round(
    100
    - freezePct * 2
    - (received > 0 ? (dropped / received) * 100 : 0)
    - Math.max(0, (avgRtt ?? 0) - 10) * 0.15
    - Math.max(0, (avgJitter ?? 0) - 10) * 0.5
    - lossPct * 20
    - Math.max(0, 30 - (avgFps ?? 30)) * 1
    - Math.max(0, startupSec - 2) * 1
  ), 0, 100);
  const scoreLevel = score >= 90 ? 'good' : score >= 70 ? 'warn' : 'bad';

  // Per-second series for charts
  const freezeDur = r.samples.map((s) => (s.inbound[0]?.totalFreezesDuration ?? 0));
  const freezePerSec = freezeDur.map((v, i) => (i === 0 ? 0 : Math.max(0, v - freezeDur[i - 1])));

  return {
    name: r.streamName, url: r.streamUrl, worst, rows, score, scoreLevel,
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
const worstOverall = streams.some((s) => s.worst === 'bad') ? 'bad' : streams.some((s) => s.worst === 'warn') ? 'warn' : 'good';
const generatedAt = new Date().toLocaleString();

// ---------------------------------------------------------------------------
// 3. HTML template
// ---------------------------------------------------------------------------
const badge = { good: ['✔ GOOD', '#1db954'], warn: ['⚠ WARNING', '#e8a33d'], bad: ['✖ POOR', '#e5484d'] };
const donutCirc = 2 * Math.PI * 34; // r = 34

const comparisonRows = streams[0].rows.map((_, i) => `
  <tr><td>${streams[0].rows[i].label}</td>
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
  <section class="card" data-idx="${idx}">
    <div class="card-head">
      <button class="collapse" title="Collapse / expand">▾</button>
      <h2>${s.name}</h2>
      <span class="badge" style="background:${color}1f;color:${color};border:1px solid ${color}55">${label}</span>
      <div class="donut-wrap" title="Overall quality score: ${s.score}/100 — ${scoreLabel.replace(/^[^ ]+ /, '')}">
        <svg class="donut" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" class="donut-track"/>
          <circle cx="40" cy="40" r="34" class="donut-val"
            style="stroke:${scoreColor};stroke-dasharray:${donutCirc.toFixed(1)};stroke-dashoffset:${donutCirc.toFixed(1)}"
            data-offset="${donutOffset.toFixed(1)}"/>
          <text x="40" y="45" class="donut-text" style="fill:${scoreColor}">${s.score}</text>
        </svg>
        <span class="donut-cap">${scoreLabel.split(' ')[0]} ${s.score}/100</span>
      </div>
    </div>
    <p class="muted">${s.url} · measured ${s.durationSec.toFixed(0)} s · ${s.measuredAt}</p>
    <div class="card-body">
      <div class="metrics">${metricTiles}</div>
      <div class="charts">
        <figure data-chart="bitrate" data-stream="${idx}">
          <figcaption>Bitrate over time <span class="hint">hover for values</span></figcaption>
          <div class="plot"><svg preserveAspectRatio="none"></svg><div class="tip"></div></div>
          <div class="legend"></div>
        </figure>
        <figure data-chart="latency" data-stream="${idx}">
          <figcaption>Latency, jitter &amp; freezes over time <span class="hint">red bars = frozen video</span></figcaption>
          <div class="plot"><svg preserveAspectRatio="none"></svg><div class="tip"></div></div>
          <div class="legend"></div>
        </figure>
        <figure data-chart="fps" data-stream="${idx}">
          <figcaption>Decoded frames per second</figcaption>
          <div class="plot"><svg preserveAspectRatio="none"></svg><div class="tip"></div></div>
          <div class="legend"></div>
        </figure>
      </div>
    </div>
  </section>`;
}).join('\n');

const dataJson = JSON.stringify({ streams: streams.map((s) => ({ name: s.name, series: s.series })) })
  .replace(/</g, '\\u003c');

const [overallLabel, overallColor] = badge[worstOverall];

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Video Stream Quality Report</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px; background: #0f1115; color: #e6e8ee;
         font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 1150px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
  h1 { font-size: 24px; margin: 0; }
  h2 { font-size: 18px; margin: 0; }
  code { background:#1d212b; padding:1px 6px; border-radius:6px; font-size:12px; }
  .muted { color: #8b90a0; font-size: 13px; margin: 6px 0 16px; }
  .badge { padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; white-space: nowrap; }
  .card { background: #171a21; border: 1px solid #262b36; border-radius: 14px; padding: 22px; margin: 18px 0; }
  .card-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .card.collapsed .card-body, .card.collapsed .muted { display: none; }
  .card.collapsed .collapse { transform: rotate(-90deg); }
  .collapse { background: #1d212b; color: #aab0c0; border: 1px solid #2a3040; border-radius: 8px;
              width: 28px; height: 28px; cursor: pointer; font-size: 14px; line-height: 1;
              transition: transform .15s ease; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); gap: 10px; margin-top: 6px; }
  .metric { background: #1d212b; border: 1px solid #2a3040; border-left-width: 4px; border-radius: 10px; padding: 10px 12px; }
  .metric.good { border-left-color: #1db954; }
  .metric.warn { border-left-color: #e8a33d; }
  .metric.bad  { border-left-color: #e5484d; }
  .metric-label { font-size: 12px; color: #8b90a0; margin-bottom: 3px; }
  .metric-value { font-size: 15px; font-weight: 600; }
  .info { display: inline-block; width: 14px; height: 14px; line-height: 14px; text-align: center;
          background: #2a3040; color: #aab0c0; border-radius: 50%; font-size: 10px; cursor: help;
          margin-left: 5px; position: relative; }
  .info:hover::after { content: attr(data-tip); position: absolute; left: 50%; bottom: 130%; transform: translateX(-50%);
          width: 240px; background: #0b0d11; border: 1px solid #2a3040; color: #d7dae3; border-radius: 8px;
          padding: 8px 10px; font-size: 11px; line-height: 1.45; z-index: 20; white-space: normal; }
  .charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin-top: 18px; }
  figure { margin: 0; background: #1d212b; border: 1px solid #2a3040; border-radius: 10px; padding: 12px; }
  figcaption { font-size: 13px; color: #aab0c0; margin-bottom: 6px; }
  .hint { color: #6b7183; font-size: 11px; margin-left: 6px; }
  .plot { position: relative; }
  .plot svg { width: 100%; height: 170px; display: block; cursor: crosshair; }
  .tip { position: absolute; pointer-events: none; background: #0b0d11; border: 1px solid #2a3040;
         border-radius: 8px; padding: 6px 9px; font-size: 11px; line-height: 1.5; color: #d7dae3;
         display: none; white-space: nowrap; z-index: 10; }
  .legend { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #aab0c0;
          background: #171a21; border: 1px solid #2a3040; border-radius: 999px; padding: 3px 10px;
          cursor: pointer; user-select: none; }
  .chip.off { opacity: .35; text-decoration: line-through; }
  .chip i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .grid { stroke: #2a3040; stroke-width: 1; }
  .axis { fill: #6b7183; font-size: 10px; text-anchor: end; }
  .axis-x { fill: #6b7183; font-size: 10px; text-anchor: middle; }
  .freezebar { fill: #e5484d; opacity: .22; }
  .guide { stroke: #aab0c0; stroke-width: .6; stroke-dasharray: 3 3; opacity: .5; }
  .donut-wrap { display: flex; align-items: center; gap: 8px; margin-left: auto; }
  .donut { width: 64px; height: 64px; transform: rotate(-90deg); }
  .donut-track { fill: none; stroke: #262b36; stroke-width: 8; }
  .donut-val { fill: none; stroke-width: 8; stroke-linecap: round;
               transition: stroke-dashoffset 1.1s cubic-bezier(.22,.8,.35,1); }
  .donut-text { font-size: 20px; font-weight: 700; text-anchor: middle; transform: rotate(90deg);
                transform-origin: 40px 40px; }
  .donut-cap { font-size: 12px; font-weight: 600; color: #aab0c0; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #262b36; white-space: nowrap; }
  th { color: #8b90a0; font-weight: 600; }
  td.good { color: #1db954; } td.warn { color: #e8a33d; } td.bad { color: #e5484d; }
  footer { color: #6b7183; font-size: 12px; margin-top: 24px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>📹 Video Stream Quality Report</h1>
    <span class="badge" style="background:${overallColor}1f;color:${overallColor};border:1px solid ${overallColor}55">${overallLabel} — overall</span>
  </header>
  <p class="muted">WebRTC streams measured via <code>getStats()</code> · generated ${generatedAt} · ${streams.length} stream(s).
     Hover the charts for per-second values · click legend chips to toggle series · click ▾ to collapse a card.</p>

  <section class="card">
    <h2>Side-by-side comparison</h2>
    <div class="table-wrap"><table>
      <tr><th>Metric</th>${streams.map((s) => `<th>${s.name}</th>`).join('')}</tr>
      ${comparisonRows}
    </table></div>
  </section>
  ${cards}
  <footer>Generated by generate-report.mjs from Playwright WebRTC quality test results.</footer>
</div>
<script id="report-data" type="application/json">${dataJson}</script>
<script>
__CLIENT_JS__
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// 4. Client-side JavaScript (rendered into the page)
// ---------------------------------------------------------------------------
const CLIENT_JS = String.raw`
const DATA = JSON.parse(document.getElementById('report-data').textContent);

const W = 640, H = 170, PAD = { l: 46, r: 12, t: 12, b: 24 };
const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil((v * 1.12) / p) * p;
}

/** Generic interactive line chart with freeze overlay, tooltip and legend toggles. */
function mountChart(fig, seriesCfg, freezeArr) {
  const svg = fig.querySelector('svg');
  const tip = fig.querySelector('.tip');
  const legend = fig.querySelector('.legend');
  const n = Math.max(1, ...seriesCfg.map((s) => s.values.length));
  const state = { on: seriesCfg.map(() => true) };

  const X = (i) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
  const xIndex = (x) => clamp(Math.round(((x - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1)), 0, n - 1);

  function draw() {
    svg.innerHTML = '';
    const visible = seriesCfg.filter((_, i) => state.on[i]);
    const max = niceMax(Math.max(1e-9, ...visible.flatMap((s) => s.values.filter((v) => v != null))));
    const Y = (v) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);

    // grid + y labels
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const y = PAD.t + f * (H - PAD.t - PAD.b);
      svg.appendChild(svgEl('line', { x1: PAD.l, y1: y, x2: W - PAD.r, y2: y, class: 'grid' }));
      const t = svgEl('text', { x: PAD.l - 5, y: y + 3, class: 'axis' });
      t.textContent = (max * (1 - f)).toFixed(max >= 10 ? 0 : 1);
      svg.appendChild(t);
    }
    // x labels (0s, mid, end)
    for (const f of [0, 0.5, 1]) {
      const t = svgEl('text', { x: X(f * (n - 1)), y: H - 8, class: 'axis-x' });
      t.textContent = Math.round(f * (n - 1)) + 's';
      svg.appendChild(t);
    }
    // freeze overlay
    (freezeArr || []).forEach((d, i) => {
      if (d > 0) {
        svg.appendChild(svgEl('rect', {
          x: X(i) - (W - PAD.l - PAD.r) / (n - 1) / 2, y: PAD.t,
          width: Math.max(2, (W - PAD.l - PAD.r) / (n - 1)), height: H - PAD.t - PAD.b,
          class: 'freezebar',
        }));
      }
    });
    // series lines
    seriesCfg.forEach((s, i) => {
      if (!state.on[i]) return;
      const pts = s.values.map((v, j) => (v == null ? null : X(j).toFixed(1) + ',' + Y(v).toFixed(1)))
        .filter(Boolean).join(' ');
      svg.appendChild(svgEl('polyline', { points: pts, fill: 'none', stroke: s.color, 'stroke-width': 1.7, 'stroke-linejoin': 'round' }));
    });
    // hover guide
    const guide = svgEl('line', { x1: 0, y1: PAD.t, x2: 0, y2: H - PAD.b, class: 'guide', style: 'display:none' });
    svg.appendChild(guide);

    svg.onmousemove = (ev) => {
      const rect = svg.getBoundingClientRect();
      const sx = (ev.clientX - rect.left) * (W / rect.width);
      const i = xIndex(sx);
      guide.setAttribute('x1', X(i)); guide.setAttribute('x2', X(i));
      guide.style.display = '';
      let html = '<b>t = ' + i + ' s</b>';
      seriesCfg.forEach((s, si) => {
        if (!state.on[si]) return;
        const v = s.values[i];
        html += '<br><span style="color:' + s.color + '">●</span> ' + s.name + ': <b>' + (v == null ? 'n/a' : (typeof v === 'number' ? v.toFixed(2) : v)) + ' ' + s.unit + '</b>';
      });
      if (freezeArr && freezeArr[i] > 0) {
        html += '<br><span style="color:#e5484d">🔴 frozen ' + freezeArr[i].toFixed(2) + ' s</span>';
      }
      tip.innerHTML = html;
      tip.style.display = 'block';
      const px = Math.min(Math.max(ev.clientX - rect.left + 12, 0), rect.width - 150);
      const py = Math.max(ev.clientY - rect.top - 10, 0);
      tip.style.left = px + 'px'; tip.style.top = py + 'px';
    };
    svg.onmouseleave = () => { tip.style.display = 'none'; guide.style.display = 'none'; };
  }

  // legend chips (clickable toggles)
  seriesCfg.forEach((s, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = '<i style="background:' + s.color + '"></i>' + s.name + ' (' + s.unit + ')';
    chip.onclick = () => { state.on[i] = !state.on[i]; chip.classList.toggle('off', !state.on[i]); draw(); };
    legend.appendChild(chip);
  });

  draw();
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const CHART_DEFS = {
  bitrate: (s) => [{ name: 'bitrate', color: '#4f9cf9', unit: 'Mbps', values: s.series.bitrate }],
  latency: (s) => [
    { name: 'RTT', color: '#e5484d', unit: 'ms', values: s.series.rtt },
    { name: 'jitter', color: '#e8a33d', unit: 'ms', values: s.series.jitter },
  ],
  fps: (s) => [{ name: 'fps', color: '#1db954', unit: 'fps', values: s.series.fps }],
};

document.querySelectorAll('figure[data-chart]').forEach((fig) => {
  const s = DATA.streams[Number(fig.dataset.stream)];
  const freeze = fig.dataset.chart === 'latency' ? s.series.freeze : null;
  mountChart(fig, CHART_DEFS[fig.dataset.chart](s), freeze);
});

// animate score rings
setTimeout(() => {
  document.querySelectorAll('.donut-val').forEach((c) => {
    c.style.strokeDashoffset = c.dataset.offset;
  });
}, 60);

// collapse cards
document.querySelectorAll('.collapse').forEach((btn) => {
  btn.onclick = () => btn.closest('.card').classList.toggle('collapsed');
});
`;

// ---------------------------------------------------------------------------
// 5. Write file
// ---------------------------------------------------------------------------
writeFileSync(OUTPUT_FILE, html.replace('__CLIENT_JS__', () => CLIENT_JS));
console.log(`Interactive report written to ${OUTPUT_FILE} (${streams.length} stream(s): ${streams.map((r) => r.name).join(', ')})`);
