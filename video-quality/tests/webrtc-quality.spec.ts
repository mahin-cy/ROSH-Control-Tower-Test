
import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

test('measure WebRTC live stream quality', async ({
  page,
}, testInfo) => {
  const durationSec = Number(
    process.env.TEST_DURATION ??
    (testInfo.project.use as { env?: Record<string, string> })?.env?.TEST_DURATION ??
    60
  );
  test.setTimeout((durationSec + 60) * 1000);

  // The stream URL comes from the project's `use.env`
  // (see the `streams` list in playwright.config.ts), or
  // from the STREAM_URL environment variable as an override.
  const streamUrl =
    process.env.STREAM_URL ??
    (testInfo.project.use as { env?: Record<string, string> })
      .env?.STREAM_URL;

  if (!streamUrl) {
    throw new Error(
      'Set STREAM_URL to your local streaming page.'
    );
  }

  // Capture peer connections created by the application.
  await page.addInitScript(() => {
    const original = window.RTCPeerConnection;
    const connections: RTCPeerConnection[] = [];

    Object.defineProperty(window, '__pwPeerConnections', {
      value: connections,
      configurable: false,
    });

    window.RTCPeerConnection = new Proxy(original, {
      construct(target, args) {
        const pc = Reflect.construct(target, args);
        connections.push(pc);
        return pc;
      },
    });
  });

  // MediaMTX behind Traefik prefix (/webrtc) returns WHEP session Location headers
  // omitting /webrtc (e.g. /TEST-VIN-001/whep/<uuid>). When reader.js sends subsequent
  // PATCH (ICE candidate) requests to that path, Traefik routes them to the React frontend
  // SPA, returning HTTP 200 instead of HTTP 204. Rewrite missing /webrtc in WHEP paths so
  // requests reach MediaMTX cleanly.
  if (streamUrl.includes('/webrtc/')) {
    await page.route(
      (url) => url.pathname.includes('/whep/'),
      async (route) => {
        const origUrl = route.request().url();
        if (!origUrl.includes('/webrtc/')) {
          const newUrl = origUrl.replace(/(https?:\/\/[^/]+)\/([^/]+\/whep\/.*)/, '$1/webrtc/$2');
          const response = await page.request.fetch(route.request(), { url: newUrl });
          await route.fulfill({ response });
        } else {
          await route.continue();
        }
      }
    );
  }

  await page.goto(streamUrl, {
    waitUntil: 'domcontentloaded',
  });

  // If login is required, complete it before this step.
  const video = page.locator('video').first();
  await expect(video).toBeAttached({ timeout: 30_000 });

  // Start playback when possible and measure startup.
  const startupTimeMs = await video.evaluate(async (v) => {
    const video = v as HTMLVideoElement;

    if (!video.paused && video.readyState >= 2) {
      return 0; // Already playing when measurement began.
    }

    const startedAt = performance.now();

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for video playback'));
      }, 30_000);

      const cleanup = () => {
        window.clearTimeout(timeout);
        video.removeEventListener('playing', onPlaying);
      };

      const onPlaying = () => {
        cleanup();
        resolve();
      };

      video.addEventListener('playing', onPlaying, {
        once: true,
      });

      const tryPlay = (attempt: number) => {
        video.play().catch((error) => {
          // The play() request can be interrupted while the
          // player is still loading its stream; retry briefly.
          if (attempt < 10 && video.paused) {
            window.setTimeout(() => tryPlay(attempt + 1), 500);
          } else {
            cleanup();
            reject(error);
          }
        });
      };

      tryPlay(0);
    });

    return performance.now() - startedAt;
  });

  // Read inbound video RTP stats from the current page.
  const readStats = async () =>
    page.evaluate(async () => {
      const connections = (
        window as typeof window & {
          __pwPeerConnections?: RTCPeerConnection[];
        }
      ).__pwPeerConnections ?? [];

      const inbound: Array<Record<string, unknown>> = [];
      let roundTripTimeMs: number | null = null;

      for (const pc of connections) {
        const report = await pc.getStats();

        report.forEach((raw) => {
          const s = raw as RTCStats & Record<string, any>;

          if (
            s.type === 'inbound-rtp' &&
            (s.kind === 'video' || s.mediaType === 'video') &&
            !s.isRemote
          ) {
            inbound.push({
              id: s.id,
              timestamp: s.timestamp,
              bytesReceived: s.bytesReceived ?? 0,
              packetsReceived: s.packetsReceived ?? 0,
              packetsLost: s.packetsLost ?? 0,
              jitterMs:
                typeof s.jitter === 'number'
                  ? s.jitter * 1000
                  : null,
              framesReceived: s.framesReceived ?? null,
              framesDecoded: s.framesDecoded ?? null,
              framesDropped: s.framesDropped ?? null,
              framesPerSecond: s.framesPerSecond ?? null,
              frameWidth: s.frameWidth ?? null,
              frameHeight: s.frameHeight ?? null,
              freezeCount: s.freezeCount ?? null,
              totalFreezesDuration:
                s.totalFreezesDuration ?? null,
            });
          }

          if (
            s.type === 'candidate-pair' &&
            (s.selected === true ||
              (s.nominated === true &&
                s.state === 'succeeded')) &&
            typeof s.currentRoundTripTime === 'number'
          ) {
            roundTripTimeMs =
              s.currentRoundTripTime * 1000;
          }
        });
      }

      const video = document.querySelector('video');

      return {
        timestamp: Date.now(),
        peerConnectionCount: connections.length,
        connectionStates: connections.map((pc) => ({
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
        })),
        roundTripTimeMs,
        playback: video
          ? {
              currentTime: video.currentTime,
              paused: video.paused,
              ended: video.ended,
              readyState: video.readyState,
              width: video.videoWidth,
              height: video.videoHeight,
            }
          : null,
        inbound,
      };
    });

  const samples = [];

  // One sample per second for durationSec seconds.
  for (let i = 0; i < durationSec; i++) {
    samples.push(await readStats());

    if (i < durationSec - 1) {
      await page.waitForTimeout(1_000);
    }
  }

  // Aggregate counters across incoming video tracks.
  const totals = (sample: typeof samples[number]) => {
    const sum = (key: string) =>
      sample.inbound.reduce(
        (total, stream) =>
          total + Number(stream[key] ?? 0),
        0
      );

    return {
      bytes: sum('bytesReceived'),
      received: sum('packetsReceived'),
      lost: sum('packetsLost'),
      framesReceived: sum('framesReceived'),
      framesDecoded: sum('framesDecoded'),
      framesDropped: sum('framesDropped'),
    };
  };

  const intervalMetrics = [];

  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1];
    const current = samples[i];
    const before = totals(previous);
    const after = totals(current);

    const elapsedSeconds =
      (current.timestamp - previous.timestamp) / 1000;

    const delta = (now: number, then: number) =>
      Math.max(0, now - then);

    const bytesDelta = delta(after.bytes, before.bytes);
    const receivedDelta = delta(
      after.received,
      before.received
    );
    const lostDelta = delta(after.lost, before.lost);

    const packetTotal = receivedDelta + lostDelta;

    intervalMetrics.push({
      timestamp: new Date(current.timestamp).toISOString(),
      bitrateMbps:
        elapsedSeconds > 0
          ? (bytesDelta * 8) / elapsedSeconds / 1_000_000
          : null,
      packetLossPercent:
        packetTotal > 0
          ? (lostDelta / packetTotal) * 100
          : null,
      jitterMs: current.inbound.length
        ? current.inbound
            .map((s) => s.jitterMs)
            .filter((n): n is number => typeof n === 'number')
            .reduce((a, b, _, arr) => a + b / arr.length, 0) ||
          null
        : null,
      roundTripTimeMs: current.roundTripTimeMs,
      framesReceived: delta(
        after.framesReceived,
        before.framesReceived
      ),
      framesDecoded: delta(
        after.framesDecoded,
        before.framesDecoded
      ),
      framesDropped: delta(
        after.framesDropped,
        before.framesDropped
      ),
      width: current.playback?.width ?? null,
      height: current.playback?.height ?? null,
      playbackTime: current.playback?.currentTime ?? null,
      connectionStates: current.connectionStates,
    });
  }

  const first = samples[0];
  const last = samples[samples.length - 1];

  const report = {
    streamUrl,
    startupTimeMs,
    sampleCount: samples.length,
    measurementDurationSeconds:
      (last.timestamp - first.timestamp) / 1000,
    videoProgressSeconds:
      (last.playback?.currentTime ?? 0) -
      (first.playback?.currentTime ?? 0),
    samples,
    intervalMetrics,
  };

  // ---- Human-readable summary for the HTML report ----
  const numeric = (values: Array<number | null>) =>
    values.filter((n): n is number => typeof n === 'number');
  const mean = (values: number[]) =>
    values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null;
  const round = (n: number | null, digits = 2) =>
    n === null ? null : Number(n.toFixed(digits));

  const bitrateSamples = numeric(
    intervalMetrics.map((m) => m.bitrateMbps)
  );
  const finalInbound = last.inbound[0] as
    | Record<string, any>
    | undefined;
  const packetLossPercent =
    [...intervalMetrics]
      .reverse()
      .find((m) => m.packetLossPercent != null)
      ?.packetLossPercent ?? null;

  const summary = {
    startupTimeMs: round(startupTimeMs, 0),
    durationSeconds: round(
      report.measurementDurationSeconds,
      1
    ),
    finalResolution: last.playback
      ? `${last.playback.width}x${last.playback.height}`
      : null,
    avgBitrateMbps: round(mean(bitrateSamples)),
    minBitrateMbps: round(
      bitrateSamples.length ? Math.min(...bitrateSamples) : null
    ),
    maxBitrateMbps: round(
      bitrateSamples.length ? Math.max(...bitrateSamples) : null
    ),
    avgJitterMs: round(
      mean(numeric(intervalMetrics.map((m) => m.jitterMs)))
    ),
    avgRoundTripTimeMs: round(
      mean(numeric(intervalMetrics.map((m) => m.roundTripTimeMs)))
    ),
    avgFps: round(
      mean(intervalMetrics.map((m) => m.framesDecoded)),
      1
    ),
    framesReceived: (finalInbound?.framesReceived as number) ?? null,
    framesDecoded: (finalInbound?.framesDecoded as number) ?? null,
    framesDropped: (finalInbound?.framesDropped as number) ?? null,
    freezeCount: (finalInbound?.freezeCount as number) ?? null,
    totalFreezesDurationSec: round(
      (finalInbound?.totalFreezesDuration as number) ?? null
    ),
    packetLossPercent: round(packetLossPercent, 3),
  };

  // Annotations are rendered on the test detail page
  // of the Playwright HTML report.
  const summaryLines = [
    `Stream: ${streamUrl}`,
    `Startup time: ${summary.startupTimeMs} ms`,
    `Duration: ${summary.durationSeconds} s`,
    `Resolution: ${summary.finalResolution ?? 'n/a'}`,
    `Bitrate avg/min/max: ${summary.avgBitrateMbps} / ${summary.minBitrateMbps} / ${summary.maxBitrateMbps} Mbps`,
    `Latency (RTT avg): ${summary.avgRoundTripTimeMs} ms | Jitter avg: ${summary.avgJitterMs} ms`,
    `FPS avg: ${summary.avgFps} | Frames received/decoded/dropped: ${summary.framesReceived} / ${summary.framesDecoded} / ${summary.framesDropped}`,
    `Freezes: ${summary.freezeCount} (${summary.totalFreezesDurationSec} s) | Packet loss: ${summary.packetLossPercent}%`,
  ];

  for (const line of summaryLines) {
    testInfo.annotations.push({
      type: 'quality-metric',
      description: line,
    });
  }

  // Attachments appear under "Attachments" in the report.
  await testInfo.attach('quality-summary.json', {
    body: JSON.stringify(summary, null, 2),
    contentType: 'application/json',
  });

  const outputPath = testInfo.outputPath(
    'webrtc-quality-results.json'
  );

  await fs.writeFile(
    outputPath,
    JSON.stringify(report, null, 2)
  );

  await testInfo.attach('quality-results-full.json', {
    path: outputPath,
    contentType: 'application/json',
  });

  console.log('--- WebRTC quality summary ---');
  for (const line of summaryLines) {
    console.log(line);
  }
  console.log('WebRTC quality report:', outputPath);
  console.log(JSON.stringify({
    startupTimeMs,
    sampleCount: samples.length,
    videoProgressSeconds: report.videoProgressSeconds,
    finalResolution: last.playback
      ? `${last.playback.width}x${last.playback.height}`
      : null,
    inboundVideoStreams: last.inbound.length,
    resultsPath: outputPath,
  }, null, 2));

  expect(
    samples.some((sample) => sample.inbound.length > 0),
    'No incoming WebRTC video statistics were detected.'
  ).toBeTruthy();

  expect(
    report.videoProgressSeconds,
    'Video playback did not progress during the test.'
  ).toBeGreaterThan(0);
});
