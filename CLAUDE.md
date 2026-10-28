# RoshAI Control Tower — AV Test App

## Project Overview

Web control tower for autonomous-vehicle (AV) testing: operators monitor live
telemetry from a test vehicle/bot over MQTT, view session history and
post-run media (CSV/JSON/JPG/WAV, expandable to video), and can issue an
e-stop / control commands. On-prem, containerized deployment (Docker
Compose), single-vehicle pilot today, designed to extend to multi-vehicle.

Full architecture rationale lives in
`AV_Test_App_Tech_Stack_Architecture_Recommendations.md` — this file is the
condensed, working reference Claude Code should follow day to day.

## Tech Stack

- **Backend**: Node.js + TypeScript
- **Frontend**: React + TypeScript (React Query/SWR for REST, Zustand for
  live telemetry state)
- **Relational DB**: PostgreSQL via **Prisma** (see decision rationale in
  Key Libraries & Packages — chosen over TypeORM for its 2025 TS/WASM
  engine rewrite: ~90% smaller bundle, faster queries, and first-party
  Accelerate/Pulse tooling for future multi-vehicle/live-dashboard scaling)
- **Cache / live-telemetry window**: Redis
- **Object storage**: MinIO (S3-compatible)
- **Message broker**: **Mosquitto** (Eclipse Foundation, EPL/EDL) — MQTT
  over WSS (TLS-encrypted transport only — no bot-side client certs, see
  "Bot identity & the no-auth decision" below), port 443. Decided Aug 2026:
  EMQX moved to Business Source License (BSL 1.1) with its prior
  open-source 5.8 branch already EOL (Feb 2026, no further security
  patches); the BSL free grant now covers single-node use only (clustering
  requires a paid license) and its "no bundling in a commercial product
  sold to others" term is ambiguous for a client-delivered on-prem product.
  Mosquitto has a longer track record, a stable Eclipse-governed license
  with no BSL-style history, a much smaller footprint (EMQX wants
  server-class hardware; Mosquitto runs on edge-class hardware), and native
  WSS/mTLS support with nothing paywalled — mTLS remains available in the
  software even though it's unused for bot auth per the Aug 2026 decision
  below. Trade-off: no EMQX-style built-in automatic clustering or
  web dashboard — multi-vehicle scaling means bridging separate Mosquitto
  instances yourself, or adopting a commercial platform on top of it, when
  that need arrives. Revisit if/when clustering becomes a hard requirement.
- **Auth**: OIDC (Microsoft Entra ID now, swappable to Google later) via a
  **generic OIDC client library** — no Keycloak/identity-broker. Decided
  Aug 2026: both Entra and Google expose standard
  `.well-known/openid-configuration` discovery, so the app is never written
  against Entra-specific behavior — swapping IdPs is an env-var change
  (issuer URL, client ID/secret, redirect URI) + restart, no code change.
  Keycloak's actual value (LDAP/AD federation, multi-app SSO, admin-UI
  live swap) doesn't match a single-client pilot with a small dev team, and
  it would add a JVM-based service with its own ops/patching burden on top
  of the rest of the stack. Revisit only if RoshAI ends up deploying to
  many clients each needing self-service IdP swap without dev involvement
  — Zitadel (Go-based, lighter than Keycloak) would be the option to
  evaluate first at that point, ahead of Keycloak itself. **Implemented
  Aug 2026**: role/authorization deliberately stays DB-driven, never read
  from the OIDC token (no Entra App Roles configured) — a Role
  Management UI (`AdminPage.tsx`, admin-only) lets any Admin promote/
  demote users directly, so this stays swap-safe too: nothing about
  authorization needs to change when the provider does. Password login
  was kept alongside OIDC rather than replaced (dual login by choice).
  See Security baseline below for the full route/schema details, and
  "Entra App Registration not yet created" under Open Items — the code
  is done but the one-time Azure Portal setup step isn't.
- **Deploy**: Docker Compose, Linux-based images (Windows host via Docker
  Desktop + WSL2)
- **Networking — decided Aug 2026: Tailscale, not public internet
  exposure.** Supersedes the original "expose Traefik on public port 443"
  plan below. The client-site laptop, every bot, and every operator device
  now join a private tailnet (MagicDNS); nothing is exposed to the public
  internet at all, which removes the firewall-approval friction entirely
  rather than just minimizing it. A `tailscale` sidecar (official
  `tailscale/tailscale` image, `docker/docker-compose.yml`) joins the
  tailnet; **only Traefik** moves onto its network namespace
  (`network_mode: service:tailscale`) — `backend`/`frontend`/`mosquitto`
  are unchanged (same network, same Docker labels, same ports), keeping the
  diff small. Bots reach Mosquitto the same way as before — MQTT-over-WSS
  through Traefik's `/mqtt` path — just via the tailnet MagicDNS hostname
  instead of a public one. Coordination plane: Tailscale's own hosted SaaS,
  not self-hosted Headscale (matches this project's existing pattern of
  avoiding self-hosted infra with its own ops burden, e.g. the OIDC/
  Keycloak decision below); accepted trade-off is that a Tailscale outage
  can delay *new* connections/handshakes (a bot reconnecting after a power
  cycle) but doesn't drop already-established WireGuard sessions. **Cost
  note**: Tailscale's free "Personal" tier is non-commercial-use only —
  budget the Standard plan (~$8/user/month) for a client-delivered product.
  TLS: Traefik's websecure (:443) entrypoint is now enabled, using a cert
  fetched via `tailscale cert` (a periodic refresh service, since Traefik
  has no automatic issuance of its own) — this is what resolves the
  previously-parked "server TLS certificate source" item; see Open Items
  below.
- **Tailscale needs real kernel network access, not just the container
  image — found Sep 2026 during the first cloud VM deployment.** Without
  `cap_add: NET_ADMIN`/`NET_RAW` and `/dev/net/tun` device access, the
  official `tailscale/tailscale` image silently falls back to
  `--tun=userspace-networking` (visible in its own startup log). That mode
  passes TCP-based traffic fine — which is why WHEP's HTTP signaling and
  RTSP's TCP control channel appeared to work — but doesn't properly carry
  WebRTC's actual UDP/ICE media path: WHEP sessions returned `201` and
  negotiated successfully, yet no video ever played, cycling
  create→silence→`DELETE`→retry indefinitely. `cap_add`/`devices` on the
  `tailscale` service (Tailscale's documented Docker guidance) turned out
  not to be sufficient alone — on the actual cloud VM, `containerboot`
  (the image's entrypoint) still chose `--tun=userspace-networking` even
  with the device confirmed present both host-side and inside the
  container, and the capability confirmed applied to the running
  container via `docker inspect`, with no AppArmor denial in
  dmesg/journalctl either. Root cause: the image needs `TS_USERSPACE:
  'false'` set explicitly — it doesn't reliably auto-detect kernel-mode
  availability on its own. All three together (`cap_add`, `devices`,
  `TS_USERSPACE: 'false'`) is the actual fix. Scoped to that one
  container's own network namespace only (no `network_mode: host` here)
  — every other service is unaffected. **Operational gotcha found in the
  same rollout**: `traefik`, `tailscale-cert-refresh`, and `mediamtx` all
  use `network_mode: service:tailscale` — recreating `tailscale` alone
  (e.g. `--force-recreate tailscale`) breaks those three, since they stay
  attached to the now-removed old container's namespace. Always recreate
  all four together. Likely also explains an earlier-observed symptom:
  the bot's RTSP push
  publishing successfully for ~17s then being torn down and retried every
  ~30s, if that data path relies on UDP RTP under the hood.
- **Local dev and the cloud VM are separate Tailscale devices with
  distinct hostnames — decided Sep 2026, after a real collision.** Both
  originally started from `docker/.env.example`'s same
  `TS_HOSTNAME=roshai-control-tower` default; whichever registered first
  claimed the clean name and the other was silently auto-suffixed
  (`roshai-control-tower-1`) by Tailscale's own collision handling — not
  an error, just confusing, and actively wrong for anything that hardcoded
  the unsuffixed hostname as "production" (the bot-team-facing
  `docs/video-streaming-contract.html`, `.env.example`'s
  `VIDEO_RTSP_BASE_URL`/OIDC redirect URIs). Fix: local dev now registers
  as `control-tower-dev` (`docker/.env`'s `TS_HOSTNAME`, gitignored/
  per-machine), leaving the clean `roshai-control-tower`-family name for
  the cloud VM. A pure hostname/env change wasn't enough to apply on its
  own — the `tailscale` container reuses its persisted node identity
  (`tailscale-state` volume) across restarts, and asking an
  already-registered node to rename itself triggered
  `machineAuthorized=false`/a stuck re-approval flow on this tailnet
  (`RegisterReq` needing manual approval, and the approval URL itself
  then refusing with "device already exists" since it's a rename, not a
  fresh login). Resolved by clearing the `tailscale-state` volume so the
  container registers as a brand-new node under the new hostname instead
  of trying to rename the old one in place — the old `roshai-control-
  tower` node this local machine previously held is now orphaned in the
  admin console and should be manually removed there. A separate,
  dev-specific bot will be configured by the bot team against
  `control-tower-dev.<tailnet-domain>` — kept intentionally distinct from
  the production contract doc/URLs so dev/test traffic can never again
  collide with or masquerade as production.
- **Reverse proxy**: **Traefik** in front of the whole stack — single
  TLS termination point and single point of ingress (now on the tailnet,
  not a public port — see above), routing REST/WebSocket traffic to the
  backend, static assets to the frontend, and MQTT-over-WSS to Mosquitto.
  Originally decided Aug 2026 for the "ideally just one publicly-approved
  port" goal (client's IT approves firewall access port-by-port); that
  goal itself is now moot under the tailnet model, but Traefik's
  path-based multiplexing behind one hostname is still what's used — see
  the Networking note above for why Traefik was kept rather than replaced
  by `tailscale serve`. Traefik over Nginx specifically for its
  Docker-label-based auto-discovery (less hand-maintained config for a
  solo dev); Nginx remains a fine alternative if its wider documentation/
  familiarity is preferred.
- **Bulk post-run transfer**: HTTPS resumable upload through the portal
  (not SFTP/SSH). Decided Aug 2026: no bot-side credential (see "Bot
  identity & the no-auth decision" below — the client confirmed bots
  implement no security of their own, so the upload is identified by the
  VIN supplied in the request, same no-auth model as MQTT), the same
  single port-443 exposure via the reverse proxy, and the already-chosen
  stack (`@fastify/multipart` + checksum verification + `@aws-sdk/
  client-s3`) — no new exposed port, no new service to secure, no bridge
  process needed to land files into MinIO. Resumability (real requirement
  — client-confirmed cellular coverage is "medium to very good," not
  guaranteed) should use the `tus` resumable-upload protocol rather than
  hand-rolled chunking. Note: the Requirements Document v1.1 still lists
  this choice as "pending" on the client's side — this doesn't change
  what the client experiences, but flag it to them before finalizing.
- **Post-run PDF test report (Aug 2026)**: a separate artifact from the
  CSV/JSON/JPG/WAV bulk transfer above, uploaded by the bot right before
  it exits (kill signal, e-stop, or manual stop — see Bot Message
  Architecture's stop-event handling). Deliberately not routed through
  `tus`: at up to 5MB, a dropped upload just gets retried whole, so a
  single-shot `@fastify/multipart` POST (`POST /api/v1/vehicles/{vin}/
  reports`) is used instead of standing up a second resumable pathway for
  a file this small. Lands in its own `reports` bucket (see Object
  storage layout) at `{vin}/{session-id}/report.pdf`. Downloads are
  served as `{vin}_{sessionId}.pdf` (`reportFileName` in `/shared`,
  sanitized to `[A-Za-z0-9_-]`) — a download-name change only, the
  storage key is unchanged. On success the
  backend emits a `report-ready` Socket.IO event so the web app can
  enable a download button; download (`GET .../reports/{sessionId}`,
  requires an authenticated operator/admin session) streams the file
  through the backend rather than returning a presigned MinIO URL —
  MinIO is only reachable at its internal Docker hostname, which a
  browser can't resolve, and exposing it through Traefik as a second
  public route would reintroduce exactly the new-exposed-surface problem
  this whole design avoids. The real bot is C++ on an NVIDIA Jetson
  (Ubuntu-based L4T), not `tools/bot-simulator.ts` — `libcurl`'s
  `curl_mime_*` API is the expected client. Contract is proposed, not yet
  bot-team-confirmed, same status as the other post-handshake messages.
- **Live video (Phase 2) — decided Sep 2026: WebRTC playback via a
  self-hosted MediaMTX media server**, not MJPEG/HLS/RTSP-to-browser.
  Browser plays back over WHEP — WebRTC under the hood, so no browser
  plugin and no custom signaling/SFU to build in-house. WebRTC's usual
  NAT-traversal complexity is largely moot here since bot, server, and
  operator devices already share one Tailscale tailnet. Meets the
  client-confirmed 2,500–4,000 kbps @ 720p/30fps target via WebRTC's
  built-in adaptive bitrate; MJPEG rejected (no adaptive bitrate, blows
  past the bandwidth target) and HLS/DASH rejected (multi-second latency,
  a poor fit for anything safety-adjacent). MediaMTX (Go binary, MIT
  license, one more Docker service) follows the same small/self-hosted
  bias as Mosquitto/Traefik rather than a heavier platform.
  - **Bot ingest — decided (updated) Sep 2026: RTSP, not WHIP.**
    Supersedes the original WHIP-ingest design in this same decision;
    browser playback (above) is unaffected — MediaMTX bridges the two
    independently. Bot pushes H.264 (Jetson hardware NVENC,
    `nvv4l2h264enc`) via `rtspclientsink`'s ANNOUNCE/RECORD flow to
    MediaMTX's own RTSP port. **Reasoning — bot-team-confirmed, not a
    proactive choice**: the bot team reported their Jetson runs an older
    Ubuntu version than assumed, whose bundled GStreamer predates
    `whipclientsink`'s GStreamer ≥1.22 requirement — WHIP was never
    viable against their real hardware once checked, not just a
    theoretical compatibility concern. RTSP push (`rtspclientsink`) is
    available on far older GStreamer builds and is the de facto standard
    many IP/vendor camera SDKs already speak, so it was the direct
    substitute once WHIP was ruled out. Trade-offs accepted knowingly:
    RTSP has no WebRTC-style built-in
    adaptive bitrate (not a practical loss — `SET_BITRATE` over MQTT is
    the throttling mechanism regardless of ingest transport) and no
    mandatory encryption (mitigated by the tailnet's own WireGuard
    encryption wrapping every hop anyway). Infra consequence: RTSP isn't
    HTTP, so — like the WebRTC media port — it can't ride through
    Traefik's path-based routing; it needs to be reachable on the tailnet
    directly.
    - **Decided (updated) Sep 2026, found via real bot-team testing:
      MediaMTX runs on `network_mode: service:tailscale`**, sharing the
      `tailscale`/Traefik network namespace — supersedes an earlier design
      that published RTSP/WebRTC-media ports via ordinary Docker `ports:`.
      On this project's Windows/Docker-Desktop dev host, a `ports:`-
      published port turned out to only be reliably reachable via
      Windows' own `localhost` — never via any other host-side network
      interface, including the Tailscale virtual adapter — so the bot's
      RTSP push was refused before ever reaching the container, regardless
      of Tailscale ACL correctness. Traefik already avoids this identical
      problem the same way; MediaMTX now does too. Consequence: no
      `ports:` section on the mediamtx service at all (a container sharing
      another's network namespace has no independent interface to publish
      from), and the WHEP route Traefik used to auto-discover via
      `traefik.*` Docker labels is now a static route in
      `docker/traefik/dynamic-mediamtx.yml` (Traefik's file provider)
      pointing at `http://127.0.0.1:8889`, since Traefik and MediaMTX
      share one loopback now. Local verification lost its two dev-only
      published ports as a result — use `docker compose exec mediamtx
      ...` instead (see Debugging section).
    - **Bot-side pipeline note, found via the same testing**: GStreamer's
      `rtspclientsink` defaults to negotiating UDP for the actual RTP
      media, separate from the TCP control connection — this dropped the
      session after ~10s over the tailnet in testing. Forcing TCP-
      interleaved transport (`rtspclientsink ... protocols=tcp`) fixed it
      immediately and reliably. Passed along to the bot team as a required
      pipeline flag, not optional — see the Video Streaming Contract
      artifact/`docs/video-streaming-contract.html`.
  - Camera-agnostic by design regardless of ingest transport: whatever
    the camera, the Jetson pipeline always outputs the same H.264
    profile, so MediaMTX/backend/frontend never handle per-camera
    compression differences directly — the live test vehicle's depth
    camera specifically streams its RGB output (not its depth data)
    through this same pipeline; confirmed no separate driver-facing
    camera is needed.
  - Start/stop and bitrate control are signaled over the reserved
    `video/control`/`video/status` MQTT topics (see Bot Message
    Architecture below) — actual video bytes never touch MQTT or the Node
    backend, matching the architecture doc's "video needs its own
    transport" note. Live viewing only this phase; recording to the
    reserved `media-video` MinIO bucket is deferred, not part of this
    phase.

## Repository Structure (monorepo, npm workspaces)

```
Code/                        <- repo root
  package.json                <- root workspace manifest
  package-lock.json
  backend/
    package.json
    src/
  frontend/
    package.json
    src/
  shared/                     <- shared TS types (MQTT/Protobuf payloads,
                                  API request/response contracts) — imported
                                  by both backend and frontend, never
                                  duplicated
    package.json
    src/
  docker/
    docker-compose.yml
    backend.Dockerfile
    frontend.Dockerfile
  CLAUDE.md
```

## Package Manager

npm. One install at the repo root covers all workspaces:

```
npm install
npm run dev --workspace=backend
npm run dev --workspace=frontend
npm run build --workspace=backend
npm run build --workspace=frontend
```

Local runtime dependencies (Postgres, Redis, MinIO, Mosquitto) run via
Docker Compose — see architecture doc Section 1 for the compose
conventions (volumes for certs and stateful data, no host networking
mode).

**Local dev vs. production port publishing** (Sep 2026): the base
`docker-compose.yml` no longer host-publishes Postgres/Redis/MinIO/
Mosquitto/backend ports at all — it's production-safe by default for a
cloud VM with a public IP. Local dev restores them via a gitignored,
per-machine `docker/docker-compose.override.yml` (see its own header
comment for the exact content). Because this project always invokes
Compose with an explicit `-f docker/docker-compose.yml` (not a bare
`docker compose up` from inside `docker/`), Compose's automatic
override-file discovery does **not** apply — the override must be passed
explicitly as a second `-f`:
- **Local dev**: `docker compose -f docker/docker-compose.yml -f docker/docker-compose.override.yml up`
- **VM/production** (no override file present): `docker compose -f docker/docker-compose.yml up`

## Key Libraries & Packages

### Decision rationale (finalized Aug 2026)

Web framework, ORM, and UI component library were evaluated against package
size, security, speed, support/maintainability, and fit for planned feature
growth (multi-vehicle scaling, live dashboard, on-prem delivery):

- **Fastify** over Express — ~3x throughput in current benchmarks, built-in
  JSON-schema request validation (fewer missed-validation routes than
  Express's bolt-on-middleware model), leaner plugin-based footprint,
  first-class native TypeScript support. Fits the "many concurrent
  MQTT/WebSocket connections + REST" workload directly.
- **Prisma** over TypeORM — the Nov 2025 rewrite (TS/WASM engine replacing
  the old Rust binary) cut bundle size ~90% and improved query speed;
  auto-generated migrations/types reduce manual-intervention risk as the
  schema grows; Accelerate (pooling) and Pulse (real-time DB events) map
  directly onto future multi-instance/live-dashboard needs. TypeORM remains
  fully open-source and more SQL-hands-on, but doesn't out-perform Prisma
  post-rewrite on any of the five criteria.
- **shadcn/ui** (on Radix primitives) over MUI/Mantine/Chakra — smallest
  bundle and smallest dependency/attack surface (component code lives in
  the repo, not a large opaque package tree — reduces npm supply-chain
  exposure), and composes directly with the already-chosen `recharts` +
  `react-hook-form` instead of introducing a second competing
  form/chart/table system. Ruled out MUI specifically because MUI X's
  advanced data-grid/chart tiers are paywalled, a poor fit for an on-prem
  client deliverable. Mantine was the closest runner-up (more turn-key,
  built-in charts/forms suite) if the team later prefers less DIY assembly.
  Trade-off to track: shadcn/ui components are owned/maintained in-repo, no
  free upstream bugfixes, so budget light ongoing upkeep for them.

### Backend

- **Web framework**: `fastify`
- **MQTT client**: `mqtt` (mqtt.js) — subscribes to Mosquitto over WSS
  (no client cert — see Security baseline); the standard async MQTT
  client for Node
- **Protobuf decode + shared types**: `ts-proto` — compiles `.proto`
  definitions into typed TS interfaces + encode/decode helpers, generated
  into `/shared` (`shared/proto/*.proto`, driven by `buf` —
  `npm run proto:gen --workspace=shared` — into `shared/src/generated/`,
  exported as `Proto*`-prefixed types from `@roshai/shared`). **Live on
  the wire (Aug 2026)** for handshake, heartbeat, telemetry, and command,
  plus (Sep 2026) stop-event — see "Bot message architecture" below for
  the full picture and each message's bot-team confirmation status. There
  are no remaining JSON+Zod placeholder bot messages.
- **WebSocket bridge to browser dashboards**: `socket.io` — built-in
  reconnection and per-vehicle "rooms," useful once multi-vehicle support
  lands (lighter alternative: plain `ws`, more manual wiring)
- **Runtime schema validation**: `zod` — validates every decoded
  bot-originated payload before it touches the DB (per the "never trust
  the edge device blindly" rule); also usable for REST request/response
  validation
- **ORM**: `prisma` — see decision rationale above
- **Auth / OIDC**: `openid-client` (spec-compliant OIDC client, configured
  entirely via env vars — issuer URL, client ID/secret, redirect URI — so
  the Entra→Google swap is config-only) + `jose` (JWT verify/sign) —
  do not use MSAL, it breaks the IdP-swap goal. No identity-broker
  service. **Implemented Aug 2026** (Entra ID as the first provider) —
  see the Security baseline section below for the route/schema details;
  password login (`auth-route.ts`) was kept alongside it rather than
  replaced.
- **File upload handling**: `@fastify/multipart` for the HTTPS multipart
  bulk-upload endpoint (CSV/JSON/JPG/WAV), also reused as-is (no `tus`) for
  the separate post-run PDF report upload — see "Post-run PDF test
  report" above
- **Object storage client**: `@aws-sdk/client-s3` — official AWS SDK v3,
  S3-API-compatible so it talks to MinIO now and real S3/Azure Blob later
  with no code change
- **Redis client**: `ioredis` — sorted sets/streams for the rolling
  live-telemetry window, plus pub/sub for cross-instance scaling
- **Logging**: `pino` — structured JSON logs, pairs with Fastify,
  low overhead, easy to ship to Loki/Grafana later
- **Upload integrity checksum**: Node's built-in `crypto` (SHA-256) — no
  extra package needed

### Frontend

- **REST data fetching/caching**: `@tanstack/react-query` (already decided)
- **Live telemetry state**: `zustand` (already decided)
- **WebSocket client**: `socket.io-client` (pairs with backend's socket.io)
- **Forms**: `react-hook-form` + `zod` — reuse the same `zod` schemas from
  `/shared` wherever frontend and backend validate the same shape (e.g.
  operator pass/fail verdicts, driver comments)
- **Charting** (live telemetry dashboard): `recharts` — fastest to build
  with for a pilot timeline (lower-level alternative: `visx`, if you need
  more custom chart behavior later)
- **Routing**: `react-router` — standard for a multi-page dashboard
  (vehicle list, session detail, admin views)
- **UI components**: `shadcn/ui` (built on Radix primitives) — see
  decision rationale above

### Shared (`/shared` workspace)

- TS types generated from `.proto` files via `ts-proto`
- `zod` schemas for payload/API contracts both sides validate against —
  shared validation logic, not just shared types

### Dev tooling (repo-root devDependencies)

- `typescript`
- `eslint` + `@typescript-eslint/*` + `eslint-config-prettier`
- `prettier`
- `husky` + `lint-staged` — runs lint/format on every commit; the
  stand-in for code review on this solo project (see Git workflow)

## Bot Message Architecture (MQTT)

**Multi-vehicle topic scheme (Sep 2026), superseding the single fixed
`robot/AUTO/...` convention below.** Real integration with the bot team
(Aug 2026) found the original placeholder topic guesses were wrong —
every bot topic settled on a fixed `robot/AUTO/...` path, not the
originally-guessed `vehicles/{vin}/...` wildcard pattern, with
per-vehicle identity carried in the payload (`vin_number`) instead of the
topic. That worked for a single pilot vehicle but not for a fleet: three
backend→bot messages (handshake response, command/e-stop, video control)
are *targeted* at one specific vehicle, and a shared topic meant every
bot received every one — most seriously, an e-stop meant for one vehicle
would reach all of them. Those three are now per-vehicle topics
(`robot/{vin}/...`); the other five (handshake request, heartbeat,
telemetry, stop-event, video status) stay fixed/shared — they were never
really vehicle-specific — just with the now-meaningless `AUTO` segment
dropped. Full contract (including the bot-team handoff) at
`docs/mqtt-multi-vehicle-topic-proposal.html`; topic builders live in
`shared/src/mqtt/topics.ts`. **There is no compatibility bridge** — the
real pilot bot (`vin_number: TEST-VIN-001`) goes dark on every channel
from the moment the backend cuts over until its firmware adopts the new
strings; this must be a coordinated deploy, not a silent release.

- **Handshake** (`shared/proto/session.proto`) — `robot/handshake/request`
  (bot → backend, fixed) / `robot/{vin}/handshake/response` (backend →
  bot, **per-vehicle**), both protobuf. **Bot-team confirmed** (topic
  string itself superseded Sep 2026, payload shape unchanged). The bot's
  first message after MQTT CONNECT — carries `vin_number`/`mac_id`/
  `session_id`; backend replies success/failure. **New firmware
  requirement**: the bot must subscribe to its own `robot/{vin}/handshake/
  response` before (or at the same moment as) publishing its request —
  MQTT won't redeliver a message to a late subscriber, and unlike the old
  shared-topic convention, the ack now only ever reaches the one bot
  subscribed to its own vin's topic. **New convention**: the bot must
  re-handshake after *any* MQTT reconnect, not only after power-on —
  lets the backend distinguish "the same session resuming" from unrelated
  data, since telemetry itself carries no session identifier. A successful
  handshake starts the heartbeat loop and registers the vehicle in the
  live "Connected vehicles" grid (below); a new handshake for a vin that
  already shows an active session force-closes the old one first (see
  `index.ts`'s `onMessage`), so an ungracefully-disconnected bot being
  swapped for another on the same vehicle doesn't leave a stale session
  dangling.
- **Heartbeat** (`shared/proto/heartbeat.proto`) — `robot/heartbeat`,
  backend → **all bots, fleet-wide broadcast** (deliberately not
  per-vehicle — the message carries no vehicle-specific content, and MQTT
  already fans a published message out to every subscriber independently,
  so each bot's own connectivity loss is detected correctly off one
  shared tick), protobuf, QoS 0, 500ms interval. **Our proposal, not yet
  bot-team-confirmed.** Business rule (client-confirmed): if the bot
  doesn't receive 3 consecutive heartbeats, it must self-stop and report
  why via stop-event (`cause: network-loss`). QoS 0 deliberately — the
  bot's own miss-tolerance already absorbs occasional loss, so no ack is
  needed.
- **Telemetry** (`shared/proto/telemetry.proto`) — `robot/telemetry`,
  bot → backend, fixed/shared, protobuf, 1Hz. **Our proposal, not yet
  bot-team-confirmed.** Many bots publishing to this one topic is fine —
  the backend demuxes every message by its own payload `vin_number`, not
  by topic or publish ordering. **`gps_status` (field 8, Oct 2026, our
  proposal, shared with the bot team)**: the bot must publish telemetry
  at 1Hz *even with no GPS fix* (e.g. indoors), setting `NO_FIX` with
  zeroed position — previously it went silent, and since telemetry is the
  stale-session watchdog's only liveness signal, an indoor bot was
  falsely marked `lost-contact`. An enum, not a bool, so firmware that
  omits the field (`UNSPECIFIED`) is treated as `FIX` — backward
  compatible. The backend strips position fields on `no-fix` before
  validation; the Live page shows "No GPS signal" instead of the map.
- **Command / e-stop** (`shared/proto/command.proto`) —
  `robot/{vin}/command`, backend → bot, **per-vehicle**, protobuf. **Our
  proposal, not yet bot-team-confirmed** (topic string superseded Sep
  2026 — see the multi-vehicle note above; this was the topic the
  original safety risk was about). Published by `POST
  /api/v1/vehicles/:vin/stop` (below). The bot's reaction to a stop
  command is to report back via the *existing* stop-event mechanism with
  `cause: operator` — no separate ack message — which is also what stops
  the heartbeat loop (any stop-event does, regardless of cause).
- **Video control / status** (`shared/proto/video.proto`, new Sep 2026) —
  `robot/{vin}/video/control` (backend → bot, **per-vehicle**,
  `VideoControlCommand`: `action` START/STOP/SET_BITRATE + target
  bitrate/resolution/fps + `ingest_url` — an `rtsp://...` URL as of the
  Sep 2026 RTSP-ingest decision, see Tech Stack above; was a WHIP
  `https://...` URL originally) and `robot/video/status` (bot → backend,
  fixed/shared, `VideoStatus`: STARTING/STREAMING/STOPPED/ERROR + current
  bitrate/resolution + `error_message`), both protobuf, **QoS 1** (unlike
  heartbeat/telemetry's QoS 0 — a dropped start/stop is a real problem,
  not tolerable periodic loss: the stream either never starts or never
  stops). **Our proposal, not yet bot-team-confirmed**, same status as
  heartbeat/telemetry/command. `command_id` on each message correlates a
  `VideoControlCommand` to its `VideoStatus` reply. Start is triggered
  when the first operator's browser subscribes to a vehicle's video feed;
  stop when the backend's per-vehicle viewer count returns to zero
  (tracked in `vehicle-registry.ts` alongside the existing session
  registry) — including on abrupt Socket.IO disconnects (closed tab,
  dropped network), the same "don't rely on a clean goodbye" principle
  already used for the bot's own missed-heartbeat self-stop, applied to
  viewers instead of the bot. Actual video media (H.264 over RTSP ingest /
  WHEP playback via MediaMTX — see Tech Stack above) never touches this
  MQTT channel or the Node backend. The MediaMTX ingest/WHEP path is now
  the vin (was a single fixed `AUTO` path).
- **Stop event** (`shared/proto/stop_event.proto`) —
  `robot/stop-event`, bot → backend, fixed/shared, protobuf, QoS 1.
  **Bot-team confirmed (Sep 2026)**, including a non-additive renumbering
  of `StopEventCause` and two new causes: `cause` is one of `operator` /
  `network-loss` / `error` / `manual-shutdown` / `unknown`. Every "vehicle
  stopped" scenario — operator e-stop, missed-heartbeat self-stop, a
  bot-detected error, a manual shutdown, or anything else — reports
  through this one message.

**Backend-side stale-session watchdog** (`vehicle-registry.ts`'s
`sweepStaleSessions`, run periodically from `index.ts`): covers the case
where a bot goes dark (hard crash, or sustained SIM/cellular loss — real
per client-confirmed "medium to very good," not guaranteed, coverage) and
never gets the chance to send its own stop-event, which would otherwise
leave that vin's session `active` indefinitely. Transitions a
telemetry-silent `active` session to a third status, **`lost-contact`**
— deliberately distinct from `ended`: `ended` means a confirmed stop-event
was received, `lost-contact` means the backend gave up waiting and the
vehicle's actual state is unknown (it may still be fully operational and
moving). The frontend grid renders these differently on purpose —
conflating them risks an operator believing a still-moving vehicle has
confirmed-stopped. The threshold (`STALE_SESSION_TIMEOUT_MS`, default
30s) is deliberately much longer than the bot's own 1.5s missed-heartbeat
tolerance — a pure backstop, not a competing faster mechanism.

**Record identity is the composite `(mac_id, vin, session_id)`, not
`session_id` alone** (`vehicle-registry.ts`, exposed on the wire as
`VehicleSession.compositeId`). A bot's own session counter is not
guaranteed globally unique across the vehicles it gets fitted to over
time, or across different bots fitted to the same vehicle — keying by
`session_id` alone (or `(vin, session_id)` alone) can silently collide
and overwrite a different real test run's record. The registry Map, the
frontend's React list keys/selection state, and the reports bucket's
object key (`{vin}/{mac_id}/{session-id}/report.pdf`, was `{vin}/
{session-id}/...`) all use this composite identity now. One accepted
limitation: the bot's real report-upload contract (`POST
/api/v1/vehicles/:vin/reports`) only sends vin + sessionId, not macId —
changing that would be a breaking change to that external contract, out
of scope here, so report attach/download resolves ambiguity (rare) by
picking the most recently started matching session and logging a
warning.

**Live "Connected vehicles" grid**: backed by an in-memory session
registry (`backend/src/lib/vehicle-registry.ts`), deliberately *not*
persisted to Postgres — resets on every backend restart/redeploy; revisit
if that trade-off stops being acceptable. Keyed by session ID, not VIN,
so the same vehicle shows multiple rows across repeated test runs (status
`active`/`ended`). New browser connections get a one-time snapshot on
socket connect (`'vehicle-list-snapshot'`), then live deltas via
`'vehicle-update'` — no REST endpoint for this, Socket.IO carries both.
Note: a separate `Vehicle` Prisma model also exists (see
`backend/prisma/schema.prisma`) but does *not* back this live grid — it's
reserved for a possible later persisted-history phase.

**E-stop control flow**: `POST /api/v1/vehicles/:vin/stop`
(`backend/src/routes/vehicles-route.ts`) — admin-only (`requireAdmin`,
the same guard used for `/admin`), validates `vin` against MQTT
topic-injection characters, publishes the command, then durably
audit-logs it to the `AdminActionAudit` Postgres table — **this is the
audit log the Security baseline below calls for, now actually
implemented**, not just a stated requirement. The audit write is
best-effort/non-blocking: a DB hiccup must never block the
safety-critical publish itself. Stop buttons exist both in the vehicle
grid (per-row) and on `LiveTelemetryPage` (immediate access while
watching one vehicle); both are admin-gated client-side too, but that's
defense in depth, not the real boundary — the server-side `requireAdmin`
check is.

**`tools/bot-simulator.ts`** stands in for real hardware for all of the
above — run via `npx tsx tools/bot-simulator.ts` from the repo root
(needs `npm run build --workspace=shared` first). It simulates the bot's
required deadman-switch behavior too (self-stop + report on 3 missed
heartbeats), so the whole loop is testable without hardware. It also
stands in for the camera pipeline: it subscribes to its per-VIN
`robot/{vin}/video/control`, and on START loops a mock video file to
MediaMTX over RTSP (`ffmpeg -stream_loop -1 -re -i <file> -c copy -f
rtsp <ingestUrl>`, ffmpeg resolved from `FFMPEG_PATH`/PATH/WinGet),
reporting `video/status` starting/streaming/stopped/error. The mock file
maps from the VIN (`BOT_VIDEO`/`MOCK_VIDEO_DIR` override):
`TEST-VIN-001`→`mock_vehicle.mp4`, `-002`→`mock_vehicle2.mp4`,
`-003`→`mock_vehicle3.mp4` in the in-repo `video-test` folder. Three bots
at once: `bash tools/simulate-fleet.sh`; N bots (count asked interactively):
`bash tools/simulate-n-bots.sh`
(N bots, each assigned a random `mock_vehicle*.mp4`, videos reused across bots);
on Windows prefer `tools/simulate-n-bots.ps1` (`-Count N` or interactive) —
running the .sh through WSL's bash silently drops the per-bot env vars
(BOT_VIN/BOT_MAC/BOT_VIDEO don't cross the WSL→Windows interop boundary),
collapsing every bot into the default TEST-VIN-001; local MediaMTX:
`bash tools/run-local-mediamtx.sh` (with `VIDEO_RTSP_BASE_URL=
rtsp://localhost:8554` in `docker/.env` and the Vite dev proxy for
`/webrtc`→:8889 in `frontend/vite.config.ts`). Passing
against the simulator only proves our own code does what we intend —
it does *not* prove a "not yet bot-team-confirmed" topic above is
correct, since the simulator is our own code and will pass regardless.

**`tools/load-test/run-load-test.mjs`** — protocol-correctness load-test
harness. Spawns N bot-simulators (same mechanism as `simulate-n-bots.ps1`
— node.exe + npx-cli.js directly, per-bot env), observes all MQTT traffic
with the same `@roshai/shared` protobuf decoders the backend uses, asserts
per-VIN protocol correctness across 6 checks (handshake success + latency,
heartbeat delivery + no network-loss events, telemetry integrity, session
registry state via socket.io, video control/status pairing, unexpected
stop-events), and writes three outputs: `load-test-report.json` (one entry
per bot, no aggregation hides a failing instance), `load-test-report.html`
(self-contained interactive dashboard — collapsible per-bot cards, SVG
comparison charts, no CDN), and a console table. Exit code 0 = all pass,
1 = any failure (CI-friendly). `--observe-only --vins` mode skips spawning
— connects to bots already running elsewhere (tailnet). See
`tools/load-test/README.md` for the full CLI reference and
`PROJECT_OVERVIEW.md §15` for the check-by-check criteria.

Why not k6/Artillery/emqtt_bench: those are raw-transport load generators
that measure msgs/sec and latency. They know nothing about this protocol.
"Did every VIN get its own handshake ack on its own per-VIN topic?" and
"does the session registry hold N distinct sessions?" require protobuf
decode + MQTT topic logic that can't meaningfully be expressed in k6's
restricted JS sandbox (no `mqtt` npm package, no `protobufjs`, no
`socket.io-client`). The Node harness uses the exact same library the
backend uses to decode these messages — byte for byte. If raw broker
capacity numbers are needed later, a 10-line `emqtt_bench pub` run is a
separate, optional phase (noted in README); it's not part of this harness.

**`video-quality/`** — Playwright WebRTC quality suite. `playwright.config.ts`
is parameterized via `TEST_VINS` (comma-separated VINs) and `WHEP_BASE_URL`
env vars; one Playwright project is generated per VIN, giving each bot its
own result row in `playwright-report/` and its own `webrtc-quality-results.json`
file consumed by `generate-report.mjs` → `quality-report.html`. Default
`TEST_VINS=vehicle1,vehicle2,vehicle3` covers the 3 local mock streams;
override for load-test runs. Use `npm run test:vins` (runs only
`chromium-test-vin-*` projects). Hold the load-test harness in `--video`
mode (streams up, printed `STREAMS READY`), then run Playwright in the
`video-quality/` directory for per-bot video quality measurement.

## Conventions

### Naming
- Files: kebab-case (`telemetry-service.ts`); React components: PascalCase
  (`VehicleDashboard.tsx`)
- Folders: kebab-case
- Variables/functions: camelCase; types/interfaces: PascalCase; constants:
  UPPER_SNAKE_CASE
- MQTT topics — see "Bot Message Architecture" above for the current,
  actual list and each topic's bot-team confirmation status; the
  original architecture doc's `vehicles/{vin}/...`-for-everything guess
  turned out wrong for most of them once tested against the real bot
- API routes: REST, versioned under `/api/v1/...`, resource-based nouns
  (e.g. `/api/v1/vehicles/:vin/runs`)

### TypeScript
- `strict: true` in every workspace's `tsconfig.json`
- No `any` without an inline comment justifying it
- Shared payload/contract types live in `/shared`, imported by both sides —
  never redefined independently in backend and frontend

### Code style & linting
- ESLint + Prettier, base config at the repo root, extended (not
  duplicated) by each workspace
- Prettier is the single source of truth for formatting — format on save,
  no manual style debate in review

### API responses
- REST responses use a `{ data, error }` envelope; `error: null` on success
- All bot-originated payloads are schema-validated before touching the DB —
  never trust the edge device blindly (per architecture doc Section 5)

### Environment & secrets
- No secrets or credentials committed to the repo, ever
- Local dev: `.env` per workspace (gitignored) + a committed `.env.example`
  as the template
- Production: Docker secrets / env vars injected at deploy time, never
  baked into images (per architecture doc Section 1)

### Testing
**TBD — not yet decided.** Do not scaffold a test framework unassisted;
ask before adding one, and update this section once a choice is made.

### Git workflow

**Branching model** (finalized Aug 2026): three-tier —
`main` → `dev` → short-lived `feature/*` branches. Chosen for a solo,
3–4 week build where a chunk of the code comes out of Claude Code
sessions: `feature/*` branches isolate one change at a time, `dev` is the
integration/quarantine layer where a batch of (often AI-assisted) work
gets reviewed and exercised together, and `main` only ever advances once
that batch is verified — so `main` always reflects what could be handed
to the client right now.
- `feature/<short-description>` branches off `dev`; merge back into `dev`
  once that one change works
- Once a few features on `dev` have been tested together, merge `dev`
  into `main`
- Tag meaningful points on `main` (e.g. `v0.1-demo`) instead of
  maintaining separate release branches — a full release-branch process
  isn't warranted for a solo project

**Commit style**: Conventional Commits (`feat:`, `fix:`, `chore:`,
`docs:`, `refactor:`) — cheap to follow, keeps history scannable, and
gives Claude Code a consistent format to follow when committing on your
behalf.

**Commit size**: small, focused commits over large batched ones — easier
to review a Claude Code diff, and easier to revert cleanly if one piece
is wrong without losing unrelated work.

**Pre-commit checks**: turn on `husky` + `lint-staged` (see Dev tooling)
to auto-run lint/format (and tests, once a framework is chosen) on every
commit — this is the stand-in for code review on a solo project, since
there's no second person catching mistakes otherwise.

### Security baseline (carried from architecture doc Section 5)
- TLS everywhere for transport encryption (Traefik/Mosquitto present
  server certificates as usual) — but see "Bot identity & the no-auth
  decision" immediately below for what this does *not* cover.
- OIDC/JWT session for interactive users, unaffected by the bot-auth
  decision — bots never use the operator OIDC flow regardless.
  **Implemented Aug 2026** (Entra ID as the first provider — see "Auth"
  above): `auth-oidc-route.ts` handles the redirect + PKCE authorization
  code exchange via `openid-client`/`jose`, then converges on the same
  `createSession`/`session_id` cookie the password path
  (`auth-route.ts`) already used — both login paths are equally real,
  neither is a fallback for the other. Role is deliberately never read
  from the OIDC token (see "Auth" above); a first-time OIDC login
  auto-provisions a `User` row with `role: OPERATOR`, linking by
  `oidcSubject` (the standard `sub` claim, not an Entra-specific one) or
  falling back to `email` so an existing password account merges instead
  of duplicating.
- RBAC enforced server-side on every action — especially the e-stop
  control. This governs the *operator* action that triggers a command
  publish; it's separate from bot-side auth. `requireAdmin`
  (`backend/src/lib/auth-guard.ts`) is used on three routes: `POST
  /api/v1/vehicles/:vin/stop` (see Bot Message Architecture above), and
  (Aug 2026) `GET /api/v1/admin/users` + `PATCH
  /api/v1/admin/users/:id/role` — the Role Management UI
  (`AdminPage.tsx`, no longer a placeholder), which lets any existing
  Admin promote/demote a user without DB access, blocks demoting the
  last remaining Admin, and re-checks the target's role live rather than
  trusting a cached session so a demotion takes effect immediately, not
  after the demoted user's session expires. Still not a general
  permission model beyond these three routes — don't extend "RBAC" to a
  new action without adding its own explicit `requireAdmin` check.
- Audit log for every stop event and admin action — note stop-event
  records are only as trustworthy as the VIN self-declared by whoever
  published them (see below). **Implemented for the admin side**: the
  `AdminActionAudit` Postgres table records every e-stop issuance
  (vin/action/issuedBy/issuedAt) and (Aug 2026) every Role Management UI
  change (targetEmail/action/issuedBy/issuedAt — a separate nullable
  `targetEmail` column from `vin` rather than overloading one column's
  meaning across the two admin-action kinds). Bot-originated stop-events
  themselves are not yet separately persisted to an audit table — only
  operational pino logs today.

#### Bot identity & the no-auth decision (client-confirmed Aug 2026)
The client has confirmed **bots implement no security of their own.** The
moment a bot connects it sends a signal (MQTT telemetry), and the only
identifier in that signal is the VIN — self-declared, not cryptographically
proven. This applies to both the MQTT channel and the bulk-upload channel.
It supersedes the earlier "mTLS for bot↔broker and bot↔upload" plan and
resolves the "mTLS certificate lifecycle" open item (not by answering
issuance/rotation, but by removing the need for bot-side certs entirely).
Mosquitto's mTLS capability remains available in the software; it's simply
unused for bot auth.
- **No bot-side credential of any kind** — no client certs, no shared API
  keys, no tokens. Identity is whatever VIN the payload/request declares.
  Keep the MQTT connection handling and the upload route structured so a
  credential check could be slotted in later without a redesign, per the
  client's own "leave space to introduce it later" framing.
- **One exception — the command-topic ACL**: bots only *subscribe* to
  `robot/AUTO/command` (fixed topic — see Bot Message Architecture above;
  the backend publishes to it after RBAC-checking an operator's e-stop
  action via `requireAdmin`). A Mosquitto ACL restricts *publish* on that
  topic to the backend's own authenticated connection (a plain
  username/password `password_file` credential is enough); anonymous/bot
  connections may publish telemetry/handshake/stop-event and subscribe to
  command/heartbeat, but may never publish to command. This adds zero
  burden on bots — they still connect anonymously — and exists
  specifically to prevent an unauthenticated client from injecting a
  forged e-stop/resume command to a physical vehicle, the highest-
  consequence surface in this system.
- **Residual risk, accepted by the client, not silently dropped**: any
  client that can reach the broker or upload endpoint can self-declare any
  VIN — telemetry/session/stop-event data can be spoofed or flooded, and
  uploaded files can be written under any VIN's storage key. Only the
  command-publish path is mitigated (above); broader spoofing/flooding of
  telemetry and uploads is accepted, unmitigated, by design.
- **Not affected**: ordinary server-side TLS (WSS still encrypts the
  transport) and the "server certificate source" open item (Traefik/
  Mosquitto's own TLS cert — public CA vs. client-managed private CA) —
  that's about the *server's* cert and stays open regardless of bot auth.

### Object storage layout
- **Bucket per data type**, not one shared bucket: `telemetry-logs`
  (CSV/JSON), `media-audio` (WAV), `media-images` (JPG), `reports` (the
  post-run PDF test report — see Key Libraries & Packages), and a reserved
  (unused today) `media-video` for Phase 2 — so adding video later
  doesn't require restructuring existing buckets.
- Object keys namespaced `{vin}/{session-id}/{filename}` within each
  bucket.
- Rationale: per-bucket lifecycle/retention rules are how S3-style
  storage is normally managed (audio is the largest cost per the
  client's own figures and may warrant a different retention window than
  lightweight telemetry logs) — this is what makes the storage retention
  policy (see Open Items) answerable later without a migration.

### Health checks
- Every service in `docker-compose.yml` gets a `HEALTHCHECK` — not just
  "is the process alive" (Docker's default crash-restart already covers
  that) but "is it actually working": Postgres via `pg_isready`, Redis
  via `redis-cli ping`, MinIO via its `/minio/health/live` endpoint,
  backend via a small `/health` route (checks it can reach Postgres/
  Redis), Mosquitto via a lightweight custom check (no built-in
  healthcheck shipped).
- Use `depends_on: condition: service_healthy` so the backend waits for
  Postgres to actually be ready, not just started — avoids cold-start
  race conditions.
- This is about knowing your *own* infrastructure is up, distinct from
  detecting a bot's connection dropping (per architecture doc Section 7).
- **A healthcheck must verify the right *thing*, not just that a file/
  process exists — found Sep 2026 via the `control-tower-dev` rename
  above.** `tailscale-cert-refresh`'s original healthcheck was `test -f
  /certs/cert.pem`; when the hostname changed, a stale cert left over
  from the *previous* hostname (the `tailscale-certs` volume isn't
  cleared on a rename) satisfied that check instantly, so `traefik`
  (which only waits on this healthcheck via `depends_on`) booted and
  loaded the wrong certificate before the real one had even been issued
  — a real "not secure" browser error, not a hypothetical one. Fixed by
  having the refresh loop write a marker file recording which hostname
  the on-disk cert is actually *for*, only on a successful `tailscale
  cert` call, and having the healthcheck compare that marker against the
  hostname this deployment is currently configured for — no `openssl` in
  the `tailscale/tailscale` image to parse the cert's CN directly, so
  this sidesteps needing it. General lesson: "file exists" is rarely the
  right healthcheck condition when the file's *content* is what actually
  matters downstream.

### Time synchronization (NTP)
- Both the on-prem server and the bot (Jetson Orin) run standard NTP
  clients (`chrony` / `systemd-timesyncd`) against a reliable time
  source — not something that needs client negotiation, just do it.
- Why it matters here specifically: heartbeat runs at 1Hz and the app
  must distinguish operator-triggered stops from network-loss-triggered
  stops (client-confirmed requirement) — both depend on trusting event
  ordering across bot and server, which clock drift silently breaks.

### Logging & error tracking

- **Library**: `pino` (already in Key Libraries) — fastest structured JSON
  logger for Node; supports async transport via worker threads so logging
  never blocks the event loop that's also handling MQTT/WebSocket traffic.
- **Log levels**:
  - `error` — unhandled exceptions, failed DB writes, broker disconnects
    past the retry threshold, bot payload validation failures, e-stop
    delivery failures, upload checksum mismatches, auth failures
  - `warn` — recoverable/degraded conditions: reconnect attempts, retried
    uploads, slow queries, expired tokens
  - `info` — lifecycle events: service start/stop, vehicle connect/
    disconnect, session start/end, e-stop issued
  - `debug` — verbose diagnostics, off by default in prod, enabled per
    service only while actively troubleshooting
  - **Never log**: raw high-frequency telemetry payloads, full bot payload
    bodies, secrets/tokens/certs — use pino's `redact` option, don't rely
    on remembering not to log them
- **Operational logs vs. the audit log are two different things — don't
  conflate them.** The audit log (every stop-event and admin action, per
  Security baseline) is a compliance record: its own append-only Postgres
  table, never sampled or dropped, indefinite retention. Operational/error
  logs (pino → stdout → aggregator) are for troubleshooting: can be rate-
  limited, sampled, and aged out without consequence.
- **Efficiency practices**:
  - Correlation/request ID on every log line (Fastify's built-in request
    id) so one failure's logs can be traced across the async chain
  - Rate-limit repetitive errors (e.g. a flapping bot connection) — log
    the first occurrence, then a periodic "still failing, N times in last
    60s" summary, not one line per retry
  - Ship via stdout (no in-app file rotation) to a lightweight aggregator
    (Loki — indexes labels, not full text) rather than a heavy full-text
    indexer (Elasticsearch/ELK)
- **Concrete instrumentation points**: Fastify global error handler;
  `mqtt.js` `error`/`close`/`reconnect` events (broker connectivity is
  safety-relevant — ties to heartbeat reliability); zod validation
  failures (log VIN/topic/reason, not the raw payload); upload checksum
  mismatches (always `error` — REQ-S2 data-integrity); Socket.IO
  disconnects (routine `info`/`warn`, not alarms); top-level uncaught-
  exception/unhandled-rejection handler (`error`, let Docker's restart
  policy handle recovery)

## Open Items — Parked (not blocking pilot start)

These are known gaps, deliberately deferred rather than decided. Claude
Code should not silently invent an approach for any of them — flag if
work touches one of these areas and ask first.

- ~~**mTLS certificate lifecycle**~~ — **RESOLVED Aug 2026**: the client
  confirmed bots implement no security of their own (see "Bot identity &
  the no-auth decision" under Security baseline), which removes the need
  for per-bot certs entirely rather than answering the issuance/rotation
  question. Kept here as a historical note so the reasoning isn't lost.
  The **server** certificate source (public CA vs. client-managed private
  CA, for Traefik/Mosquitto's own TLS cert) is a separate question and
  remains open — see the next bullet.
- ~~**Server TLS certificate source**~~ — **RESOLVED Aug 2026** by the
  Tailscale migration (see Networking, above): Traefik's cert now comes
  from `tailscale cert`, issued for the node's MagicDNS hostname, refreshed
  by a periodic sidecar service — neither a public CA nor a client-managed
  private CA is needed. Kept here as a historical note.
- **Docker runtime on the client's actual server** — Docker Desktop +
  WSL2 vs. Docker Engine vs. Podman. The Requirements Document gives
  interim build guidance (target Linux images; validate against both a
  Linux host and a Windows host running Docker Desktop/WSL2) but lists
  the client's IT-permitted runtime as still unconfirmed in Section 11.
  Build to the interim guidance; don't hard-code an assumption that
  would break if the client's IT policy turns out not to permit WSL2.
- **Object storage retention/lifecycle policy** — no policy yet for how
  long WAV/JPG/CSV/JSON (and later video) are retained in MinIO before
  archival or deletion. Not urgent at single-vehicle pilot data volumes,
  but worth deciding before the 30–40 bot scale materially grows storage
  costs. The bucket-per-data-type layout (see Object storage layout) is
  already set up so this is answerable later without a migration.
- **Full backup/DR strategy** — held for now (single-vehicle pilot,
  disproportionate to stand up redundant infra/tested restore drills at
  this scale). Recommended minimum in the meantime, cheap enough to just
  do: a scheduled `pg_dump` for Postgres and a periodic copy/sync of
  MinIO buckets to a separate location — insurance against accidental
  deletion or corruption, not full disaster recovery. The real risk
  isn't bot count, it's that session/media/audit data may already be
  operationally valuable and can't be regenerated by re-running a
  physical test.
- ~~**Command topic multi-vehicle re-scoping**~~ — **RESOLVED Sep 2026**:
  `command`, along with `video/control` and `handshake/response`, moved
  to per-vehicle topics (`robot/{vin}/...`, see Bot Message Architecture
  above and `docs/mqtt-multi-vehicle-topic-proposal.html`) — the broker
  now only ever delivers a targeted message to the bot subscribed to its
  own vin. Kept here as a historical note. Not yet bot-team-confirmed
  (see the next item) — the new topic strings are our proposal, pending
  their firmware adopting them.
- **Bot topics still unconfirmed** — heartbeat, telemetry, command,
  video control/status, and now the entire multi-vehicle topic rename
  (see Bot Message Architecture above) are all our proposal, not yet
  independently confirmed by the bot team. Only handshake and stop-event
  are bot-team confirmed, and only for their payload shape — the topic
  *strings* for even those two changed Sep 2026 and haven't been
  re-confirmed against real hardware yet. Passing tests against
  `tools/bot-simulator.ts` doesn't validate any of this — it's our own
  code exercising our own assumptions. Revisit each as the bot team
  confirms or corrects it; see the proposal doc's open questions
  (MQTT `retain` usage, whether `AUTO` was ever a firmware template).
- **Live video bot-side details pending bot-team confirmation** (new,
  Sep 2026) — the `video/control`/`video/status` topic contract (see Bot
  Message Architecture above) is proposed, not confirmed, same status as
  heartbeat/telemetry/command. One specific still needs bot-team
  confirmation before implementing: the exact depth camera model (to
  check GStreamer/driver support on the Jetson — some vendors plug
  straight into GStreamer, others need vendor-SDK bridging before frames
  reach the encode stage). The GStreamer-version question that used to be
  open here is resolved (not sidestepped) by the Sep 2026 switch to RTSP
  ingest (see Tech Stack above) — it's *why* that switch happened: the
  bot team confirmed their Jetson's Ubuntu/GStreamer version predates
  WHIP's GStreamer ≥1.22 requirement, and `rtspclientsink` doesn't carry
  that same requirement.
- **Vehicle discovery grid / session history is in-memory, not
  persisted** — resets on every backend restart/redeploy (see Bot Message
  Architecture above). Acceptable for now; revisit if operators need a
  durable history of past test-run sessions across restarts.
- **Bot-originated stop-events aren't separately audit-logged** — only
  the admin-issued e-stop side has a durable `AdminActionAudit` record
  today (see Security baseline above). A bot's own stop-event (e.g.
  network-loss self-stop) is only in operational pino logs, not a
  compliance-grade audit table.
- **Backend uses the MinIO root credential, not a scoped user** (new, Aug
  2026, added alongside the post-run PDF report feature) — `storage.ts`
  authenticates with `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` directly, a
  deliberate simplification since no bucket/IAM segregation exists for
  anything else yet either (`telemetry-logs`/`media-*` aren't built).
  Mosquitto, by contrast, already has a scoped-down backend-only account
  rather than a root one. Revisit (provision a backend-scoped MinIO user/
  policy, mirroring the Mosquitto pattern) once more bucket types actually
  get built and "one credential can touch every bucket" stops being an
  acceptable trade-off.
- **MinIO upstream is abandoned — `minio/minio:latest` gets no further
  security patches** (new, Sep 2026) — verified directly against GitHub
  and Docker Hub, not just secondary sources: MinIO Inc. froze the
  official Docker image at `RELEASE.2025-09-07` and archived the GitHub
  repo entirely on Apr 25, 2026 ("THIS REPOSITORY IS NO LONGER
  MAINTAINED"), redirecting users to the commercial AIStor product. A
  high-severity (CVSS 8.1) privilege-escalation bug, CVE-2025-62506, was
  patched only in a source-only release with no Docker image published —
  this exact tag is permanently unpatched against it, and will be against
  every future finding too. That specific CVE needs a restricted
  service-account/STS token to trigger, so today's root-credential setup
  (see the item above) happens not to be exposed to *this one* —
  incidental, not a fix, and means fixing the root-credential item
  without also addressing this one would newly expose the app to this
  class of bug. Running MinIO reachable only from the backend inside the
  Docker network (never from Traefik or the public internet) genuinely
  reduces external exploitability, but doesn't cover lateral movement if
  anything else is ever compromised, or the base OS layer aging unpatched
  indefinitely. Not urgent today — nothing here is being exploited — but
  flag if work touches object storage, and migrate before the fleet
  scale-up materially raises what's stored: either swap the image tag to
  an actively maintained fork (e.g. `pgsty/minio`) or move to real cloud
  object storage (S3/Blob/GCS), which `storage.ts` can already do with
  minimal change since it speaks the plain S3 API.
- **RBAC is three gates, not a system** (updated Aug 2026 — see Security
  baseline above for the current route list) — `requireAdmin` is
  correctly enforced server-side on e-stop and the Role Management UI's
  two routes, and `AdminPage.tsx` is now a real page, not the earlier
  placeholder stub. There's still no broader permission model beyond
  those three routes — don't extend "RBAC" or "admin-only" to any new
  action without adding its own explicit `requireAdmin`/`requireAuth`
  check.
- **Entra App Registration not yet created** (Aug 2026) — the OIDC
  sign-in code (`auth-oidc-route.ts`, `oidc-client.ts`) is implemented
  and degrades gracefully (logs loudly, 503s the two `/oidc/*` routes,
  doesn't block startup or password login) when `OIDC_ISSUER_URL`/
  `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` are unset — but no one has
  actually registered the app in RoshAI's Entra tenant yet. Someone with
  app-registration rights needs to do the Azure Portal setup (App
  Registration, redirect URI, client secret) before "Sign in with
  Microsoft" works anywhere. Not a code gap — a one-time operational step.
- **Entra IdP-side logout not implemented** (Aug 2026) — `/api/v1/auth/
  logout` still only revokes this app's own Redis session (real
  revocation, which is what matters for this app), but doesn't end
  Entra's own browser SSO session via its `end_session_endpoint`. Low
  priority for a single-tenant pilot; revisit if silent re-auth after
  "logout" becomes an actual complaint.

## What Claude Code should do automatically
- Follow the conventions above without re-confirming them each session
- Flag rather than silently assume when a decision is genuinely open —
  testing framework, and the parked items above (Docker runtime, storage
  retention policy, full backup/DR, the still-unconfirmed bot topics
  (including the new multi-vehicle topic rename), in-memory session
  history, bot-side audit logging, and RBAC being one gate rather than a
  system) — ask instead of picking one
- Keep backend/frontend/shared cleanly separated — no cross-importing
  except through `/shared`
