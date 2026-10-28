# Load test harness

Spawns N bot-simulators and verifies the control tower handles them
*correctly* — not just "messages flowed", but per-bot protocol integrity:

| Check | What proves it |
|---|---|
| `handshake` | Every VIN's `handshake-request` got a `success:true` response on its own per-VIN topic; latency recorded |
| `heartbeat` | Aggregate `robot/heartbeat` rate ≈ 2/s (backend's 500 ms interval); **zero `network-loss` stop-events** (each one means a bot missed ≥3 heartbeats) |
| `telemetry` | Each bot ≥ 0.8 msg/s; any telemetry payload whose `vinNumber` isn't in the expected set counts as session cross-wiring (global fail) |
| `sessionRegistry` | The UI's own view (socket.io snapshot): N active sessions, distinct `compositeId`/VINs mid-run; all `ended` (not `lost-contact`) after teardown |
| `video` (`--video` only) | Harness publishes `video/control` START per VIN; expects `starting` → `streaming` with matching `vinNumber` + `commandId`; STOP → `stopped` at teardown |
| `unexpectedStopEvents` | Any operator/error stop-event outside teardown is a failure |

Built only from packages already in the repo (`mqtt`, `@roshai/shared`
protobuf, `socket.io-client`, Node built-ins) — no external load-testing
product. k6/Artillery-style generators measure raw transport throughput;
they can't assert this protocol (per-VIN ack topics, protobuf payloads,
registry state), so this harness exists instead.

## Prerequisites

- Backend stack running: `docker compose -f docker/docker-compose.yml -f docker/docker-compose.override.yml up`
- **`docker/.env` must contain `MOSQUITTO_BACKEND_USERNAME` and `MOSQUITTO_BACKEND_PASSWORD`** — the harness observer connects to Mosquitto with these credentials so the ACL permits it to *read* bot→backend topics (`robot/handshake/request`, `robot/telemetry`, etc.). Anonymous MQTT clients can only *write* to those topics per `docker/mosquitto/acl.conf`; without the backend-service credentials the observer receives nothing and all checks fail silently.
- `docker/.env` should also have `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (used once to read the session registry via socket.io; without them the `sessionRegistry` check is skipped but the run still proceeds)
- `npm run build --workspace=shared` — the harness imports compiled `@roshai/shared` protobuf decoders; must be built at least once
- MediaMTX running (`bash tools/run-local-mediamtx.sh`) for `--video` runs
- `video-test/mock_vehicle*.mp4` present (bots run without video otherwise)

## Configuration: `.env.loadtest`

Both the load-test harness and the Playwright video-quality suite automatically read **`.env.loadtest`** located at the repository root. This allows you to toggle between `local` and `dev` (Tailscale) environments in one place without typing flags or manual PowerShell environment variables.

See [`.env.loadtest.example`](file:///C:/Mahin/ROSH-Control-Tower/roshai-autopdi-control-tower/.env.loadtest.example) for all available options:

```properties
# Switch target: "local" or "dev"
LOAD_TEST_ENV=dev

# When LOAD_TEST_ENV=dev, set your Tailscale hostname:
TAILNET_HOST=roshai-control-tower.<tailnet>.ts.net

# Test parameters applied to both the harness and Playwright:
TEST_BOT_COUNT=3
TEST_DURATION=180
TEST_VINS=TEST-VIN-001,TEST-VIN-002,TEST-VIN-003
```

When `LOAD_TEST_ENV=dev` and `TAILNET_HOST` are set:
* Backend URL automatically becomes `https://${TAILNET_HOST}`
* MQTT broker URL automatically becomes `wss://${TAILNET_HOST}/mqtt`
* RTSP ingest base automatically becomes `rtsp://${TAILNET_HOST}:8554`
* Playwright WHEP playback base automatically becomes `https://${TAILNET_HOST}/webrtc`

Any specific CLI flag (e.g. `--broker`, `--count`) or terminal `$env:` variable will still override what's in `.env.loadtest`.

## Usage

```bash
# basic: 5 bots, 60 s measurement window
node tools/load-test/run-load-test.mjs

# custom count / duration
node tools/load-test/run-load-test.mjs --count 12 --duration 120

# with video: starts every bot's stream, holds them up, prints STREAMS READY —
# run the Playwright suite in video-quality/ at that point (see below)
node tools/load-test/run-load-test.mjs --count 5 --duration 300 --video

# observe bots that run somewhere else (e.g. on tailnet devices) — no spawning
node tools/load-test/run-load-test.mjs --observe-only --vins TEST-VIN-001,TEST-VIN-002 --duration 120

# tailnet VM target
node tools/load-test/run-load-test.mjs --count 10 --duration 300 --video `
  --broker wss://roshai-control-tower.<tailnet>.ts.net/mqtt `
  --backend https://roshai-control-tower.<tailnet>.ts.net `
  --ingest-base rtsp://roshai-control-tower.<tailnet>.ts.net:8554
```

Env vars `MQTT_BROKER_URL`, `BACKEND_HTTP_URL`, `RTSP_PUBLISH_BASE` are
honored as defaults for the corresponding flags.

Exit code: `0` = all checks passed, `1` = at least one failure, `2` =
harness error (preflight, args). Ctrl+C tears down gracefully: bots get
SIGINT and publish `session-end`, which the registry check verifies.

## Reports

Three outputs, all per-bot (no aggregation hides a failing instance):

1. **`load-test-report.json`** — full machine-readable record: config,
   per-bot check results with evidence (latencies, rates, status
   sequences, registry end-states), totals.
2. **`load-test-report.html`** — self-contained interactive dashboard
   (no CDN/dependencies): summary header, per-bot table, collapsible
   per-bot cards, SVG comparison charts (handshake latency, telemetry
   rate vs target). Open in any browser.
3. **Console** — the same table printed live.

## Video quality (per-bot Playwright report)

With the harness holding `--video` streams up (wait for `STREAMS READY`):

```powershell
cd video-quality
$env:TEST_VINS = "TEST-VIN-001,TEST-VIN-002,TEST-VIN-003,TEST-VIN-004,TEST-VIN-005"
$env:WHEP_BASE_URL = "http://localhost:8889"   # or https://<host>.<tailnet>.ts.net/webrtc
npx playwright test --project "chromium-test-vin-*"  # one test row per bot
node generate-report.mjs                              # -> quality-report.html, one card per bot
```

Or use the `video-quality/` npm scripts: `npm run test:vins` and `npm run report:html`.

## Scale notes / known limits

- Each spawned bot = 3 Windows processes (npx → tsx → node) + ffmpeg in
  `--video` mode. 20 bots ≈ 60+ node processes — fine on a dev box; near
  the 99 cap, local CPU contention will skew latency numbers (the report
  records them anyway — interpret accordingly).
- At high N, video quality numbers reflect the **local MediaMTX/CPU**
  ceiling, not network conditions.
- The backend session registry is in-memory — restart the backend between
  runs for clean counts: `docker compose -f docker/docker-compose.yml restart backend`
- VIN scheme caps at 99 (`TEST-VIN-0NN`).

## Troubleshooting: all checks fail / zero handshakes observed

The most common cause is the observer's MQTT subscription being silently
rejected by the broker ACL. The harness now detects this and prints a
`REJECTED (qos=0x80)` warning on startup. Fix: ensure `docker/.env`
contains `MOSQUITTO_BACKEND_USERNAME` and `MOSQUITTO_BACKEND_PASSWORD`
matching the values Mosquitto was started with.
