# ROSH AI Autonomous PDI Control Tower — Project Documentation

> **Package:** `roshai-control-tower` v0.1.0
> **Repository:** `Rosh-Ai-Private-Limited/roshai-autopdi-control-tower`
> **Architecture:** npm-workspaces monorepo (`backend`, `frontend`, `shared`, `tools`)
> **Runtime:** Node.js ≥ 22, TypeScript `strict` everywhere

---

## 1. What Is This Project?

A **web-based control tower for autonomous-vehicle (AV) Pre-Delivery Inspection (PDI) testing**.

Operators use it to:

- Monitor **live telemetry** (GPS position, speed, heading, altitude, GPS status) streamed from a test vehicle/bot over MQTT.
- Watch the bot on a **live map** (Leaflet) and view **live video** (WebRTC/WHEP via MediaMTX).
- View **session history** and download post-run artifacts (PDF test reports, stored in S3).
- Issue **e-stop / resume** commands to the bot (admin-only).
- Manage **users and roles** (ADMIN / OPERATOR).

The bot side runs C++ on an **NVIDIA Jetson Orin**. This repo is the cloud/on-prem control tower (bot firmware lives elsewhere). Currently a **single-vehicle pilot**, architected to extend to multi-vehicle fleets.

**Authoritative design doc:** `CLAUDE.md` (1015 lines). Original architecture-decision doc: `AV_Test_App_Tech_Stack_Architecture_Recommendations.md`.

---

## 2. Tech Stack

### Backend (`backend/`)
| Layer | Choice |
|---|---|
| Framework | **Fastify 5** |
| Language | TypeScript (strict) |
| Database | **PostgreSQL 16** via **Prisma 6** |
| Cache / sessions | **Redis 7** (sessions, OIDC flow state — telemetry deliberately NOT stored in Redis) |
| Object storage | **S3-compatible (MinIO → `pgsty/silo`)** — reports only |
| Realtime | **Socket.IO** (bridges MQTT → browser) |
| Messaging | **MQTT** (`mqtt.js` client; broker = **Mosquitto 2**) |
| Auth | Local (argon2) + generic **OIDC** (openid-client, PKCE, Redis-backed flow store) |
| Validation | **zod** on every bot payload |
| Logging | **pino** (+ rate-limited logger) |

### Frontend (`frontend/`)
| Layer | Choice |
|---|---|
| Framework | **React 19 + Vite 6** |
| Language | TypeScript |
| Routing | react-router 7 |
| Server state | @tanstack/react-query |
| Live client state | **zustand** (telemetry, auth, vehicle registry stores) |
| Realtime | socket.io-client |
| Maps | **leaflet + react-leaflet** |
| Charts | recharts |
| Video | hand-rolled **WHEP** client (WebRTC) |
| Forms | react-hook-form + zod resolvers |
| UI | **shadcn/ui-style** components, **Tailwind CSS 4**, Radix primitives, lucide-react icons |

### Infrastructure (`docker/`)
- **Traefik v3.7** reverse proxy (Docker provider via docker-socket-proxy + file provider)
- **Tailscale** sidecar — **Tailscale-only networking, nothing publicly exposed**
- **MediaMTX** (`bluenviron/mediamtx:latest-ffmpeg`) — RTSP ingest + WebRTC (WHEP) playback
- **Mosquitto 2** — MQTT (1883) + WebSockets (9001)
- **postgres:16-alpine**, **redis:7-alpine**, **pgsty/silo** (S3)
- Docker Compose with real `HEALTHCHECK`s + `depends_on: service_healthy` throughout

---

## 3. Repository Layout

```
├── backend/            Fastify API + Prisma + MQTT client + Socket.IO server
│   ├── prisma/         schema.prisma, migrations, seed.ts
│   └── src/
│       ├── index.ts                bootstrap, plugin registration, MQTT wiring, watchdog
│       ├── lib/                    mqtt-client, socket-server, vehicle-registry, storage, oidc, ...
│       └── routes/                 health, auth, auth-oidc, admin-users, vehicles, reports, session-history
├── frontend/           React 19 + Vite SPA
│   └── src/
│       ├── pages/      Login, VehicleList, LiveTelemetry, SessionHistory, RunDetail (stub), Admin
│       ├── components/ vehicle-map, vehicle-video (WHEP), ui/ (shadcn-style)
│       ├── store/      zustand: auth-store, telemetry-store, vehicle-registry-store
│       └── lib/        api-client, socket-client, use-vehicle-video, download-report
├── shared/             Shared contracts between backend ↔ bot ↔ frontend
│   ├── proto/          protobuf definitions (roshai.mqtt.v1)
│   └── src/
│       ├── generated/  ts-proto generated types (via buf)
│       ├── mqtt/       zod schemas + topic builders per payload
│       ├── auth/       login request, roles, admin-user
│       ├── vehicles/   vehicle summary, session history types
│       └── reports/    report upload schema, file naming
├── tools/
│   ├── bot-simulator.ts    Stand-in bot for local dev/testing (telemetry + mock video)
│   ├── simulate-fleet.sh   Launch a 3-bot fleet (TEST-VIN-001/2/3, one mock video each)
│   ├── simulate-n-bots.sh  Ask for a count, then launch that many parallel bots (TEST-VIN-001..N), each given a random mock video (reused as needed)
│   ├── simulate-n-bots.ps1 PowerShell-native version of simulate-n-bots.sh (no bash needed; avoids WSL env-var dropping)
│   ├── run-local-mediamtx.sh  Local MediaMTX (RTSP :8554 / WHEP :8889) from the in-repo video-test config
│   └── load-test/          Protocol-correctness load-test harness (see §15)
│       ├── run-load-test.mjs  Orchestrator: spawns N bots, observes MQTT, asserts per-VIN, writes JSON + HTML report
│       └── README.md          Usage, env vars, how to read the report
├── video-quality/      Playwright WebRTC quality measurement suite (per-bot rows via TEST_VINS env)
├── docker/             docker-compose.yml, Dockerfiles, mosquitto/mediamtx/traefik configs
└── docs/               HTML design docs (contracts, runbooks, deployment spec)
```

---

## 4. Telemetry Data (Captured)

> **This is the complete and exact set of telemetry captured by the system.** There is **no** battery, signal-strength, temperature, IMU, or other sensor telemetry — only the 8 fields below.

### 4.1 Payload: `TelemetryPayload` (`shared/proto/telemetry.proto`, package `roshai.mqtt.v1`)

Published **bot → backend** on topic **`robot/telemetry`** (fixed/shared topic), **protobuf binary, QoS 0, at 1 Hz**.

| # | Proto field | Type | App / zod name | Description |
|---|---|---|---|---|
| 1 | `vin_number` | string | `vinNumber` | Vehicle identity (self-declared in payload, not in topic) |
| 2 | `timestamp` | string (ISO-8601) | `timestamp` | When the reading was recorded |
| 3 | `speed_mps` | float | `speedMps` | Speed in meters/second |
| 4 | `heading_deg` | float | `headingDeg` | Heading in degrees, 0–360 |
| 5 | `latitude` | double | `latitude` | WGS-84 latitude, −90..90 (required when GPS fix) |
| 6 | `longitude` | double | `longitude` | WGS-84 longitude, −180..180 (required when GPS fix) |
| 7 | `altitude` | float | `altitude` | Altitude in meters (required when GPS fix) |
| 8 | `gps_status` | enum `GpsStatus` | `gpsStatus: 'fix' \| 'no-fix'` | `UNSPECIFIED(0)` treated as `fix` (backward compat); `FIX(1)`; `NO_FIX(2)` |

### 4.2 Validation & processing pipeline

1. **Decode** — `handleTelemetry` in `backend/src/lib/mqtt-client.ts`.
2. **`NO_FIX` handling** — position fields (lat/lon/alt) are **stripped** before validation; the bot must still publish at 1 Hz with zeroed position.
3. **Zod validation** — `telemetryPayloadSchema` in `shared/src/mqtt/telemetry-payload.ts`, with a `superRefine` requiring lat/lon/alt when `gpsStatus === 'fix'`.
4. **Enrichment** — `telemetry-enrichment.ts` merges the **last-known MAC address** (per VIN) into the payload → `EnrichedTelemetryPayload` (`mac` field added).
5. **Broadcast** — emitted to Socket.IO room `vehicle:{vin}` as event `telemetry`.
6. **Persistence** — **none.** Telemetry is *not* written to Postgres, Redis, or S3. It exists only in the live Socket.IO broadcast; the live vehicle grid is an in-memory `Map` (`vehicle-registry.ts`) that resets on backend restart. Only **session metadata** (start/end, stop cause, report info) is persisted (see §6).

### 4.3 Display (LiveTelemetryPage)

Each telemetry reading renders as: **Bot ID (MAC), VIN, Latitude, Longitude, Altitude (m), Speed (m/s), Heading (°), Recorded-at timestamp**, plus a **Leaflet map** marker and a **"No GPS"** badge when applicable.

### 4.4 Bot simulator values (`tools/bot-simulator.ts`)

For testing, the simulator publishes a **random walk** from `37.7749, -122.4194` (San Francisco), speed 0–8 m/s, random heading, altitude 10 m, with `SIM_NO_GPS` / `SIM_GPS_TOGGLE_S` env toggles to exercise the no-fix path. It also streams a **mock camera video**: on a viewer-driven `video/control` START it loops its VIN-mapped mock file (`mock_vehicle{,2,3}.mp4`) to MediaMTX over RTSP via ffmpeg; see §10.

---

## 5. MQTT Messaging Contract

Topics defined in `shared/src/mqtt/topics.ts` (multi-vehicle scheme, Sept 2026; superseded the old single-vehicle `robot/AUTO/...`). VIN topic segment validated by `vinTopicSegmentSchema` (`^[^/+#]+$`).

| Topic | Direction | Payload (proto) | QoS | Purpose |
|---|---|---|---|---|
| `robot/handshake/request` | bot → backend | `SessionPayload` (session.proto): `vin_number`, `mac_id`, `session_id`, optional `timestamp`, `event_type` (SESSION_START / SESSION_END) | 1 | Session lifecycle |
| `robot/{vin}/handshake/response` | backend → bot | `SessionAckPayload`: `success`, `message`, `session_id` | 1 | Session ack |
| `robot/heartbeat` | backend → all bots | `HeartbeatPayload`: `sequence` (uint64), `timestamp_ms` (int64) | 0 | **500 ms** fleet heartbeat |
| `robot/telemetry` | bot → backend | `TelemetryPayload` (see §4) | 0 | 1 Hz telemetry |
| `robot/{vin}/command` | backend → bot | `CommandPayload`: `vin_number`, `action` (E_STOP / RESUME), `issued_at`, `issued_by` | 1 | E-stop / resume |
| `robot/stop-event` | bot → backend | `StopEventPayload`: `vin_number`, `timestamp_ms`, `cause` (OPERATOR / NETWORK_LOSS / ERROR / MANUAL_SHUTDOWN / UNKNOWN), `reason` | 1 | Why the bot stopped |
| `robot/{vin}/video/control` | backend → bot | `VideoControlCommand`: `vin_number`, `session_id`, `command_id`, `action` (START / STOP / SET_BITRATE), `target_bitrate_kbps`, `width`, `height`, `fps`, `ingest_url` (rtsp://…) | 1 | Video start/stop/bitrate |
| `robot/video/status` | bot → backend | `VideoStatus`: `vin_number`, `session_id`, `command_id`, `state` (STARTING / STREAMING / STOPPED / ERROR), `current_bitrate_kbps`, `width`, `height`, `error_message`, `reported_at_ms` | 1 | Video state reports |

### Business rules
- Bot **must re-handshake** after any MQTT reconnect.
- **Deadman switch:** 3 missed heartbeats (1.5 s) → bot self-stops and reports `cause: network-loss`.
- Backend **stale-session watchdog** (`sweepStaleSessions`, 5 s sweep, `STALE_SESSION_TIMEOUT_MS` default 30 s) marks silent sessions as `lost-contact` (distinct from `ended`).
- **Security exception:** only the `backend-service` MQTT user may **publish** to `robot/+/command` (forged e-stop prevention). Bots connect anonymously; the VIN is self-declared and unverified (client-confirmed design decision).
- Broker ACL: `docker/mosquitto/acl.conf` (generated by entrypoint).

---

## 6. Database Schema (`backend/prisma/schema.prisma`)

Enum `Role { ADMIN, OPERATOR }`.

| Model | Key fields | Purpose |
|---|---|---|
| **User** | id (uuid), email (unique), name?, passwordHash? (null for OIDC-only users), oidcSubject? (unique — standard `sub` claim), role (default OPERATOR), failedLoginAttempts, lockedUntil | Operator/admin accounts |
| **Vehicle** | id, vin (unique), name? | Registered vehicle (minimal — does NOT back the live grid) |
| **TestConnection** | id, vehicleId → Vehicle, driverComment?, pdfPath? | Legacy test connection record |
| **AdminActionAudit** | id, vin? (e-stop), targetEmail? (role changes), action, issuedBy, issuedAt (indexed) | **Append-only compliance log** |
| **VehicleSessionHistory** | id, vin, macId?, sessionId, startedAt?, endedAt?, stopCause? (freeform), reportSizeBytes?, reportUploadedAt? | **Durable session record** — unique composite `@@unique([vin, macId, sessionId])`, upserted on session-end and report-upload (either order) |

**Note:** telemetry itself is never persisted — only session metadata and the report PDF (in S3).

Migrations live in `backend/prisma/migrations/`. Seed (`backend/prisma/seed.ts`) creates the first admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

---

## 7. Backend API & Realtime

### REST routes
| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | none | PG `SELECT 1`, redis ping, MQTT status |
| `POST /api/v1/auth/login` | none (rate-limited 5/15 min, lockout 5→15 min) | Local login |
| `POST /api/v1/auth/logout`, `GET /api/v1/auth/me` | session | Auth lifecycle |
| `GET/POST /api/v1/auth/oidc/...` | — | OIDC login/callback/logout (503 when OIDC_* unset) |
| `GET /api/v1/admin/users` | requireAdmin | List users |
| `PATCH /api/v1/admin/users/:id/role` | requireAdmin | Change role (audited) |
| `POST /api/v1/vehicles/:vin/stop` | requireAdmin | E-stop (audited) |
| `POST /api/v1/vehicles/clear-ended-sessions` | requireAdmin | Prune ended sessions from live grid |
| `POST /api/v1/vehicles/:vin/reports` | **bot only** (no session auth) | Multipart PDF upload: ≤ 5 MB, SHA-256 checksum, ≤ 10/min |
| `GET /api/v1/vehicles/:vin/reports/:sessionId` | requireAuth | Stream report PDF from S3 |
| `GET /api/v1/vehicles/history?limit&offset&vin` | requireAuth | Paginated session history |

### Socket.IO events
- Server → client (per-vehicle room `vehicle:{vin}`): `telemetry`, `session`, `stop-event`, `video-status`, `report-ready`.
- Server → client (global): `vehicle-list-snapshot`, `vehicle-update`.
- Client → server: `subscribe-vehicle` / `unsubscribe-vehicle` (also drive video start/stop via viewer counts).

Sessions stored in Redis (8 h TTL); OIDC PKCE flow state in Redis (5 min TTL).

---

## 8. Frontend

### Routes (all behind `<AuthGate>` except `/login`)
| Route | Page | Notes |
|---|---|---|
| `/login` | LoginPage | Local + OIDC buttons |
| `/vehicles` | VehicleListPage | Live "Connected vehicles" grid: Watch, Stop (admin), Download Report, clear-ended-sessions |
| `/vehicles/:vin/live` | LiveTelemetryPage | Latest reading card, Leaflet map, WHEP video, Stop button, report download |
| `/vehicles/:vin/runs/:runId` | RunDetailPage | **Placeholder (Phase 3/9 stub)** |
| `/history` | SessionHistoryPage | Paginated history + downloads |
| `/admin` | AdminPage | Role management (ADMIN only) |

State: zustand stores (`auth-store`, `telemetry-store` — holds the latest `LiveTelemetryReading`, `vehicle-registry-store`); React Query for REST.

---

## 9. Video Streaming

- **Bot ingest: RTSP push** (Jetson's GStreamer < 1.22 lacks `whipclientsink`, so WHIP was replaced). Bot pushes H.264 (`rtspclientsink`, `protocols=tcp` required) to `rtsp://<tailnet-host>:8554/{vin}` (`VIDEO_RTSP_BASE_URL`).
- **Browser playback: WHEP / WebRTC** via MediaMTX. The frontend's hand-rolled WHEP client POSTs SDP to `/webrtc/{vin}/whep` (Traefik file-provider route → `http://127.0.0.1:8889`).
- **Control plane:** MQTT `robot/{vin}/video/control` + `robot/video/status` (see §5).
- **Viewer-driven lifecycle:** video starts on viewer-count 0→1, stops on 1→0 (`video-viewer-registry.ts`, driven by Socket.IO subscribe/unsubscribe/disconnect).
- **Target profile:** 4000 kbps, 1280×720, 30 fps (client range 2500–4000 kbps @ 720p/30).
- MediaMTX config (`docker/mediamtx/mediamtx.yml`): RTSP :8554, WebRTC :8889, API :9997, `all_others` paths allowed, no STUN/TURN (tailnet), RTMP/HLS/SRT/MoQ off. Shares the Tailscale container's network namespace (required for WebRTC UDP: `TS_USERSPACE: 'false'`).

---

## 10. Bot Simulator (`tools/bot-simulator.ts`)

A 435-line stand-in for the real Jetson bot (not part of any npm workspace). Run after building shared:

```bash
npm run build --workspace=shared
npx tsx tools/bot-simulator.ts
```

**Env:** `MQTT_BROKER_URL` (default `mqtt://localhost:1883`), `BOT_VIN` (default `TEST-VIN-001`), `BOT_MAC` (default `00:11:22:33:44:55`), `SIM_NO_GPS`, `SIM_GPS_TOGGLE_S`, `BACKEND_HTTP_URL`, `BOT_VIDEO` / `MOCK_VIDEO_DIR` (mock video file / directory; default maps `TEST-VIN-001/2/3` → `mock_vehicle.mp4/2/3` in the in-repo `video-test` folder), `FFMPEG_PATH` (default: `ffmpeg` from PATH, falling back to WinGet's Gyan.FFmpeg), `RTSP_PUBLISH_BASE` (fallback when a START command carries no `ingestUrl`, default `rtsp://localhost:8554`).

**Behavior:** subscribes to its per-vin command + handshake-response + video/control topics and the heartbeat topic before publishing handshake → publishes 1 Hz random-walk telemetry → enforces the deadman switch (3 missed heartbeats → `network-loss` stop-event) → on e-stop publishes `operator` stop-event, stops its ffmpeg push, and uploads a fixture PDF report via HTTP POST `/api/v1/vehicles/{vin}/reports` (multipart: `sessionId`, SHA-256 `checksum`, `file`) → on `video/control` START spawns `ffmpeg -stream_loop -1 -re -i <mock> -c copy -f rtsp <ingestUrl>`, reporting `video/status` starting/streaming/stopped/error (STOP kills it; `set-bitrate` is an acknowledged no-op) → `s`+Enter = manual stop-event → Ctrl+C/SIGTERM = report upload + session-end handshake.

**Local video demo:** start MediaMTX (`bash tools/run-local-mediamtx.sh`), set `VIDEO_RTSP_BASE_URL=rtsp://localhost:8554` in `docker/.env`, then `bash tools/simulate-fleet.sh` and open each vehicle's Live page — telemetry and that bot's mock video appear together (the Vite dev server proxies `/webrtc` → `localhost:8889`, mirroring Traefik's strip-prefix route).

---

## 11. Shared Package Contracts

- **`shared/proto/`** — proto3 files (package `roshai.mqtt.v1`): `telemetry.proto`, `session.proto`, `heartbeat.proto`, `command.proto`, `stop_event.proto`, `video.proto`. Generated via **buf + ts-proto** (`npm run proto:gen --workspace=shared`) into `shared/src/generated/` (exported as `Proto*` types + enums `SessionEventType`, `CommandAction`, `StopEventCause`, `GpsStatus`, `VideoAction`, `VideoState`).
- **`shared/src/mqtt/`** — zod schema per payload + topic builders.
- **`shared/src/auth/`** — login request, `Role`, `AdminUserSummary`, `updateUserRoleRequestSchema`.
- **`shared/src/vehicles/`** — `VehicleSession`, `VehicleSessionStatus` (`active | ended | lost-contact`), `SessionReport`, `VehicleSessionHistoryRecord`, `VehicleSessionHistoryPage`.
- **`shared/src/reports/`** — `reportUploadFieldsSchema`, `MAX_REPORT_SIZE_BYTES` (5 MiB), `ReportReadyEvent`, `reportFileName` → `{vin}_{sessionId}.pdf` (sanitized `[A-Za-z0-9_-]`).

---

## 12. Deployment

- **Orchestration:** Docker Compose (`docker/docker-compose.yml`). Services: postgres, redis, silo (S3), mosquitto, mediamtx, docker-socket-proxy, tailscale, tailscale-cert-refresh (24 h `tailscale cert` loop), traefik (v3.7), backend (port 3000, Traefik `/api` + `/socket.io`), frontend (`serve -s dist`, port 3000, Traefik `/`).
- **No host-published ports in the base file** (production-safe). Local dev ports come from the gitignored `docker/docker-compose.override.yml` (must be passed explicitly with `-f`).
- **Networking:** Tailscale-only; nothing public. Local dev hostname `control-tower-dev`; prod `roshai-control-tower`.
- **Dockerfiles:** multi-stage `node:22-alpine`; backend runtime includes Prisma CLI for deploy-time migrations (`prisma migrate deploy`); admin seeded via `npx prisma db seed`.
- **Docs:** `docs/cloud-vm-setup-runbook.html` (Ubuntu 24.04 VM, NSG lockdown, verified on Azure D2s v3), `docs/control-tower-deployment-spec.html` (pilot vs fleet sizing/licensing), `docs/devops-release-pipeline.html` (**proposed, not yet implemented**: GitHub Actions + GHCR + self-hosted runners, version-tag + approval prod trigger, `DOTENV` env secrets, `pg_dump` before prod migration).

---

## 13. Environment Variables

**`backend/.env.example`:** `PORT` (3000), `LOG_LEVEL`, `DATABASE_URL`, `REDIS_URL`, `MQTT_BROKER_URL`, `MQTT_USERNAME` / `MQTT_PASSWORD`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (+ optional `S3_REGION`), `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, `OIDC_ISSUER_URL` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI` / `OIDC_POST_LOGIN_REDIRECT`. Also read: `STALE_SESSION_TIMEOUT_MS` (default 30000), `VIDEO_RTSP_BASE_URL`, `NODE_ENV`.

**`docker/.env.example`:** adds `POSTGRES_USER/PASSWORD/DB/PORT`, `REDIS_PORT`, `MINIO_ROOT_USER/PASSWORD`, `MINIO_PORT/CONSOLE_PORT`, `MOSQUITTO_PORT`, `MOSQUITTO_BACKEND_USERNAME/PASSWORD`, `TS_AUTHKEY`, `TS_HOSTNAME` (prod default `roshai-control-tower`), `TS_TAILNET_DOMAIN`, `BACKEND_PORT`, `NODE_ENV`, `VIDEO_RTSP_BASE_URL` (e.g. `rtsp://roshai-control-tower.{tailnet-domain}:8554`).

**`frontend/.env.example`:** intentionally empty — the SPA uses relative API paths (same origin via Traefik).

---

## 15. Load-Test Harness (`tools/load-test/`)

A **protocol-correctness load test** (not a raw throughput benchmark). Zero new dependencies — built entirely from packages already in the repo (`mqtt`, `@roshai/shared`, `socket.io-client`, Node built-ins).

### What it tests (per-bot, per-check)

| Check | Pass criteria |
|---|---|
| `handshake` | Every VIN: request seen on `robot/handshake/request`; `success:true` response on `robot/{vin}/handshake/response` within 15 s; latency recorded |
| `heartbeat` | Aggregate `robot/heartbeat` rate ≈ 2/s; **zero** `stop-event` with `cause: network-loss` |
| `telemetry` | Each bot ≥ 0.8 msg/s; `vinNumber` in every payload ∈ expected VIN set (cross-wiring = fail) |
| `sessionRegistry` | Socket.IO snapshot: N active sessions, distinct `compositeId`/VINs mid-run; all `ended` (not `lost-contact`) after shutdown |
| `video` (`--video` only) | Harness publishes `VideoControlCommand` START per VIN; expects `starting` → `streaming` with matching `vinNumber`+`commandId`; STOP at teardown → `stopped` |
| `unexpectedStopEvents` | Any operator/error stop-event outside teardown = fail |

### Usage

```bash
# 5 bots, 60 s measurement window (default)
node tools/load-test/run-load-test.mjs

# Custom count + duration
node tools/load-test/run-load-test.mjs --count 12 --duration 120

# With per-bot video quality (holds streams up, prints STREAMS READY)
node tools/load-test/run-load-test.mjs --count 5 --duration 300 --video

# npm convenience aliases
npm run load:test
npm run load:test:video -- --count 5

# Observe bots running elsewhere (tailnet)
node tools/load-test/run-load-test.mjs --observe-only --vins TEST-VIN-001,TEST-VIN-002
```

Env vars `MQTT_BROKER_URL`, `BACKEND_HTTP_URL`, `RTSP_PUBLISH_BASE` are honored as defaults for the corresponding `--broker`/`--backend`/`--ingest-base` flags.

### Outputs (three, all per-bot — nothing aggregated away)

1. **`load-test-report.json`** — machine-readable; one entry per bot with all check evidence (latencies, rates, status sequences, registry end-states), plus totals. Exit code 0 = all pass, 1 = any failure, 2 = harness error.
2. **`load-test-report.html`** — self-contained interactive dashboard (no CDN, no JS libs): summary header, per-bot table, collapsible per-bot cards (pass/fail per check with values), SVG comparison charts (handshake latency, telemetry rate vs 1 Hz target). Open in any browser.
3. **Console** — same table live during the run.

### Per-bot Playwright video quality (with `--video`)

While the harness holds streams up (wait for `STREAMS READY`):

```powershell
cd video-quality
$env:TEST_VINS = "TEST-VIN-001,TEST-VIN-002,TEST-VIN-003,TEST-VIN-004,TEST-VIN-005"
$env:WHEP_BASE_URL = "http://localhost:8889"   # or https://<host>.<tailnet>.ts.net/webrtc
npx playwright test --project "chromium-test-vin-*"   # one row per bot
node generate-report.mjs                               # -> quality-report.html, one card per bot
```

`playwright.config.ts` generates one Playwright project per VIN from `TEST_VINS`, so each bot gets its own result row in the HTML report + its own `webrtc-quality-results.json` (picked up by `generate-report.mjs`).

### Scale notes

- Each spawned bot = 3 Windows processes (npx → tsx → node) + ffmpeg in `--video` mode. 20 bots ≈ 60+ node processes; near 99, local CPU contention will skew latency numbers (the report records them — interpret accordingly).
- Backend registry is in-memory — restart the backend between runs for clean counts: `docker compose -f docker/docker-compose.yml restart backend`.
- VIN scheme caps at 99 (`TEST-VIN-0NN`).
- Tailnet target: same commands with `--broker wss://roshai-control-tower.<tailnet>.ts.net/mqtt --backend https://roshai-control-tower.<tailnet>.ts.net --ingest-base rtsp://roshai-control-tower.<tailnet>.ts.net:8554`.

---

## 14. Status, Conventions & Known Gaps

- **Testing framework:** none yet (TBD per `CLAUDE.md`).
- **CI/CD:** release pipeline documented but not implemented (no `.github/workflows` yet).
- **Session audio:** `docs/session-audio-contract.html` proposes tus 1.0.0 resumable WAV upload (50–500 MB/session) — backend code does not exist yet.
- **Run detail page:** `/vehicles/:vin/runs/:runId` is a stub (Phase 3/9).
- **Git workflow:** `main` → `dev` → `feature/*`, Conventional Commits, husky + lint-staged pre-commit. (Local branch is `development`; CLAUDE.md says `dev`.)
- **Bot-team confirmation status:** handshake payload + stop-event **confirmed**; heartbeat, telemetry, command, and video control/status topics, plus the whole multi-vehicle rename, are **proposals pending bot-team confirmation**.
- **S3 buckets:** reserved per plan — `telemetry-logs`, `media-audio`, `media-images`, `reports`, `media-video` — only **`reports`** is created/used today.
- **Key architecture decisions (from CLAUDE.md):** Mosquitto over EMQX (license), generic OIDC over Keycloak, Fastify over Express, Prisma over TypeORM, shadcn/ui, **Tailscale-only networking**, MediaMTX + WebRTC(WHEP)/RTSP, S3 (MinIO → silo), pino, zod everywhere.
