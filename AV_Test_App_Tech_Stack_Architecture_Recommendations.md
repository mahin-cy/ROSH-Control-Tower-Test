# RoshAI Control Tower — Tech Stack & Architecture Recommendations

Technical recommendations for implementation planning. Based on requirements
in AV_Testing_Platform_Requirements, RoshAI-Control_Tower_Requirements_Document_v1.1,
AV_Protocol_Specification_v1.0, the Client Questions document, and the
architecture review conducted through this document's revision below.

**Revision note (Aug 2026):** this version supersedes the original draft.
Several choices below changed from the original recommendation after
re-validating against current (2026) license/maintenance status of the
underlying tools, and several previously-undecided items are now finalized.
Where a decision changed, the "Decided Aug 2026" note explains why. Items
still requiring a client answer are collected in Section 9 rather than left
implicit — see that section before assuming anything not listed there is
settled.

---

## 1. Containerization (Windows/Linux compatible, on-prem)

- **Use Linux-based container images exclusively**, orchestrated with
  **Docker Compose**. Linux images run natively on a Linux host and on a
  Windows host via Docker Desktop + WSL2 — this avoids maintaining two
  separate image sets. Native "Windows containers" are out of scope —
  Mosquitto and most parsing-agent base images are Linux-only.
- **Do not rely on host networking mode.** Windows Docker Desktop's
  networking model differs from native Linux bridge/host networking — use
  published ports with explicit bindings in the compose file so behavior
  is identical on both hosts.
- **Mount TLS certificates and secrets via Docker volumes or Docker
  secrets**, never baked into the image or referenced by an absolute host
  path — this lets certs rotate without rebuilding images, and keeps the
  same compose file portable across client environments. This covers
  Traefik/Mosquitto's own server-side TLS certificate; there are no
  per-bot client certificates to manage — see Section 5's "Bot identity &
  the no-auth decision."
- **Persist stateful data** (Postgres, object storage, broker) via named
  Docker volumes bound to host directories, so data survives container
  restarts/upgrades.
- **Line endings / permissions**: containerization repo and build scripts
  should be LF-normalized and not depend on Unix file permissions being
  preserved on checkout, since the client's engineering team may check the
  repo out on a Windows workstation before building or pushing images.
- Ship **one Docker Compose manifest** (plus an `.env` template) as the
  install artifact; validate it against both a native Linux host and a
  Windows host running Docker Desktop + WSL2 before delivery.
- **Open item — still requires client confirmation** (see Section 9):
  whether Docker Desktop/WSL2 is permitted on the client's nominated
  server, or whether Docker Engine (or Podman) is required directly. This
  affects install instructions, not the images themselves — build to the
  interim guidance above and don't hard-code an assumption.

## 2. Auth — MS Entra now, swappable to Google later (finalized)

- Standardize on **OpenID Connect (OIDC)** — both Microsoft Entra ID and
  Google Identity are standard OIDC/OAuth2 providers, so building against
  the OIDC spec (not an Entra-specific SDK) is what makes the swap easy
  later. Both expose standard `.well-known/openid-configuration` discovery
  documents.
- **Decided Aug 2026: use a generic OIDC client library
  (`openid-client` + `jose`), no Keycloak / identity-broker service.**
  This supersedes the original draft's Keycloak-first recommendation.
  Reasoning: with a generic client, swapping Entra → Google is an env-var
  change (issuer URL, client ID/secret, redirect URI) + restart — no code
  change, since the app was never written against Entra-specific
  behavior. Keycloak's actual value — LDAP/AD federation, multi-app SSO,
  admin-UI live swap without a redeploy — doesn't match a single-client
  pilot with a small dev team, and it would add a JVM-based service with
  its own operational/patching burden on top of an already multi-service
  stack (Postgres, Redis, MinIO, Mosquitto, backend, frontend).
  **Do not use MSAL** — it breaks the IdP-swap goal by coupling the app to
  Entra-specific behavior.
- **Revisit only if** RoshAI ends up deploying to many clients each
  needing self-service IdP swap without dev involvement. If that happens,
  evaluate **Zitadel** (Go-based, lighter footprint and simpler
  operationally than Keycloak) ahead of Keycloak itself.
- **Map IdP claims to the internal role model (admin/operator) at the
  boundary**, and issue your own app-level session/JWT after federation —
  so authorization logic never needs to change when the upstream IdP does.

## 3. Protocols & standards

- **Telemetry (bot → app) and heartbeat (app → bot)**: MQTT over
  WebSocket Secure (WSS) — TLS-encrypted transport only, no bot-side
  client certs (see Section 5's "Bot identity & the no-auth decision") —
  port 443, Protobuf-encoded payloads. Topic structure per vehicle:
  `vehicles/{vin}/telemetry`,
  `vehicles/{vin}/session`, `vehicles/{vin}/command`,
  `vehicles/{vin}/stop-event`. A `video/control` topic is reserved
  (namespace-planned, not implemented) for Phase 2 live video so its
  later addition doesn't require renumbering the Phase 1 topic set.
  Confirmed client-side: heartbeat runs at 1Hz, and the system must
  distinguish operator-triggered stops from network-loss-triggered stops
  — both depend on trustworthy event ordering across bot and server (see
  Section 7, time synchronization).
- **Broker — decided Aug 2026: Mosquitto (Eclipse Foundation, EPL/EDL)**,
  not EMQX. This supersedes the original draft's EMQX-as-default
  recommendation. Reasoning: EMQX moved to a Business Source License
  (BSL 1.1); its prior fully-open 5.8 branch reached end-of-life in
  Feb 2026 (no further security patches), and under the current BSL terms
  free production use is single-node only (clustering requires a paid
  license), with a "no bundling in a commercial product sold to others"
  term that's ambiguous for a client-delivered on-prem product. Mosquitto
  has a longer track record, a stable Eclipse-governed license with no
  BSL-style history, a much smaller footprint (edge-class hardware vs.
  EMQX wanting server-class hardware), and native WSS/mTLS support with
  nothing paywalled — mTLS remains available in the software even though
  it's unused for bot auth per the Aug 2026 decision in Section 5.
  Trade-off: no EMQX-style built-in automatic
  clustering or web dashboard — closing that gap means either bridging
  separate Mosquitto instances manually or adopting a commercial platform
  on top, and revisiting is warranted once clustering becomes a hard
  requirement (see client-confirmed scaling target below). Day-to-day
  broker visibility without EMQX's dashboard: `mosquitto_pub`/
  `mosquitto_sub` for CLI debugging, MQTT Explorer (free desktop app) for
  a visual tree view, and Mosquitto's own `$SYS/#` topic tree feeding
  into the Loki/Grafana observability stack (Section 7) if a dashboard is
  wanted.
- **Client-confirmed scaling target**: 5–6 bots by end of 2026, 30–40 by
  end of 2027. A single Mosquitto node comfortably handles this
  connection count and telemetry rate without clustering — the
  clustering/bridging question becomes relevant well beyond this range,
  or if hardware-failure redundancy becomes a hard requirement sooner.
- **Bulk post-run transfer (CSV/JSON/JPG/WAV) — decided Aug 2026: HTTPS
  resumable upload through the portal**, not SFTP/SSH (the Requirements
  Document v1.1 lists this as still "pending" client-side — this is an
  implementation detail that doesn't change what the client experiences,
  but flag the decision to them before finalizing). Reasoning: SFTP would
  mean standing up and securing a separate service (its own exposed port,
  typically 22) plus a bridge process to land files into MinIO with the
  right bucket/key structure. HTTPS uses no bot-side credential (see
  Section 5's "Bot identity & the no-auth decision" — the upload is
  identified by the VIN supplied in the request, same no-auth model as
  MQTT), the same single port-443 exposure via the reverse proxy
  (Section 7), and the already-chosen stack (`@fastify/multipart` +
  SHA-256 checksum verification + `@aws-sdk/client-s3`) — no new port, no
  new service, no bridge process. Resumability is a real requirement given
  client-confirmed cellular coverage is "medium to very good," not
  guaranteed — use the `tus` resumable-upload protocol rather than
  hand-rolled chunking.
- **Bot-facing endpoints require no credential** — decided Aug 2026, client-
  confirmed: bots implement no security of their own. The MQTT channel and
  upload endpoint identify the bot purely by the VIN it self-declares;
  there is no per-bot cert, token, or key, and never the operator OIDC
  flow either (the bot is not an interactive user regardless). The one
  exception is a broker-side ACL restricting *publish* on the `command`
  topic to the backend's own connection — see Section 5.
- **Live video (Phase 2, not Phase 1) — protocol decided Sep 2026: WebRTC
  playback via a self-hosted MediaMTX media server**, live viewing only
  (recording to the reserved `media-video` MinIO bucket remains
  deferred). Browser plays back via MediaMTX's WHEP output — WebRTC under
  the hood, so this needs no custom signaling server or SFU built
  in-house. Client-confirmed figures — 2,500–4,000 kbps at 30fps/720p,
  dynamically adjustable resolution if bandwidth drops — are met natively
  by WebRTC's built-in congestion control/adaptive bitrate on the
  playback leg. Bandwidth-separate from the MQTT control/telemetry
  channel as originally scoped: video media never touches MQTT or the
  Node backend, only a small `video/control`/`video/status` MQTT
  signaling pair (start/stop/bitrate) does — see CLAUDE.md's Bot Message
  Architecture section for the topic/payload contract, proposed and
  pending bot-team confirmation like heartbeat/telemetry/command.
  - **Bot ingest — decided (updated) Sep 2026: RTSP, not WHIP.**
    Supersedes the original WHIP-ingest design; the playback leg above is
    unaffected — MediaMTX bridges ingest and playback independently, so a
    protocol change on one side doesn't touch the other. Bot pushes H.264
    via `rtspclientsink`'s ANNOUNCE/RECORD flow to MediaMTX's own RTSP
    port, rather than `whipclientsink`'s WHIP push. **Why — bot-team-
    confirmed, not a proactive preference**: the bot team reported their
    Jetson runs an older Ubuntu version than assumed, whose bundled
    GStreamer predates `whipclientsink`'s GStreamer ≥1.22 requirement —
    WHIP was never viable against their real hardware once checked, this
    wasn't a design choice made ahead of that finding. RTSP push is
    available on far older GStreamer builds and is the protocol many
    IP/vendor camera SDKs already speak natively, so it was the direct
    substitute once WHIP was ruled out; it also closes the version-
    compatibility open item that existed under the WHIP-only design.
    **Trade-offs accepted knowingly**: RTSP has no WebRTC-style built-in
    adaptive bitrate on the
    ingest leg (not a practical loss — `SET_BITRATE` over MQTT is the
    throttling mechanism regardless of which ingest transport carries the
    media) and no mandatory encryption (mitigated here by the tailnet's
    own WireGuard encryption wrapping every hop regardless of the
    application-layer protocol). **Infra consequence**: like the WebRTC
    media port, RTSP isn't HTTP and can't ride Traefik's path-based
    routing — see the "MediaMTX shares the tailnet network namespace"
    entry in Section 7 for how it's actually made reachable (not a
    published port — that approach was tried first and found broken on
    this project's Windows dev host).
  - **Bot-side pipeline note, found via real testing**: GStreamer's
    `rtspclientsink` defaults to negotiating UDP for the RTP media itself
    (separate from the TCP control connection) — this dropped the session
    after ~10s over the tailnet. Forcing TCP-interleaved transport
    (`protocols=tcp`) fixed it immediately and reliably; passed to the bot
    team as a required pipeline flag.
  - **Why WebRTC over MJPEG/HLS for the playback leg**: MJPEG has no
    adaptive bitrate and would blow past the confirmed bandwidth target
    for comparable quality; HLS/DASH are segment-based with multi-second
    latency even in "low-latency" mode, a poor fit for anything
    safety-adjacent. Browsers don't speak RTSP natively either — that
    constraint is exactly why the ingest-side RTSP decision above doesn't
    extend to playback: RTSP still can't reach the browser directly, so
    WHEP remains the playback protocol regardless of what carries video
    into MediaMTX.
  - **Why this doesn't need a public-facing NAT-traversal story**: bot,
    server, and operator devices already share one private Tailscale
    tailnet (Section 7), so WebRTC's usual STUN/TURN complexity is largely
    moot — direct connectivity already exists on a flat private network.
  - **Why MediaMTX**: a single self-contained Go binary (MIT license), one
    more lightweight Docker service — the same small/self-hosted-tool bias
    already applied to Mosquitto-over-EMQX and Traefik-over-heavier
    platforms, rather than hand-building WebRTC signaling/fan-out
    in-house. Also chosen because it speaks both WHEP and RTSP natively,
    so the Sep 2026 ingest-protocol change needed no new service, only a
    config change.
  - **Different cameras, one contract**: rather than building
    codec/format flexibility into MediaMTX/backend/frontend, the Jetson
    pipeline normalizes to one fixed H.264 profile (hardware NVENC,
    `nvv4l2h264enc`) regardless of camera source — the rest of the system
    only ever handles one input format. The live test vehicle's depth
    camera specifically streams its RGB color output through this same
    pipeline, not its depth data (depth stays internal to the AV's
    perception stack); confirmed no separate driver-facing monitoring
    camera is needed.
- Expose only the minimum firewall surface needed — see reverse proxy
  note in Section 7; the client's IT team approves firewall access
  port-by-port on request, so minimizing the port count directly reduces
  that approval burden.

## 4. File storage (JPG, WAV, CSV, JSON — expandable to video)

- **Use an S3-compatible object/blob store, not the filesystem or DB
  blobs.** **MinIO** (kept — see Section 6 for the license/maintenance
  caveat now attached to this choice): S3 API-compatible (trivial
  migration path to AWS S3/Azure Blob if the client ever moves off-prem),
  runs well in Docker, content-type agnostic — adding video in Phase 2 is
  just another object type, no schema change.
- **Bucket per data type**, not one shared bucket: `telemetry-logs`
  (CSV/JSON), `media-audio` (WAV), `media-images` (JPG), and a reserved
  (unused today) `media-video` for Phase 2. Object keys namespaced
  `{vin}/{session-id}/{filename}` within each bucket. This is what makes
  a retention/lifecycle policy (still open, see Section 9) answerable
  later without a migration — S3-style lifecycle rules are normally set
  per bucket, and uncompressed WAV (48kHz/24-bit, client-confirmed) is
  the largest cost per the client's own figures (~1.3GB/hour per run) and
  will likely warrant a different retention window than lightweight
  telemetry logs.
- **Store only references in Postgres** — bucket, key, size, content-type,
  checksum — never raw bytes in the relational DB.
- **Verify integrity on upload** — SHA-256 checksum computed bot-side,
  checked server-side as part of the same HTTPS upload request — so
  "complete set received" is enforced, not assumed.
- **Retention/lifecycle policy — still open**, see Section 9.

## 5. Frontend & backend stack (IoT, live telemetry, security)

- **Backend: Node.js + TypeScript** — re-validated (not just carried
  forward). For this app's actual workload — MQTT ingestion, WebSocket
  fan-out to browser dashboards, REST API, mostly I/O-bound (decode,
  validate, store, relay) rather than CPU-bound — Node's event-loop model
  is a strong, well-trodden fit; `mqtt.js` + WebSocket/Socket.IO bridging
  a broker to browser clients is close to a canonical Node use case.
  Python/FastAPI remains a legitimate alternative (Pydantic gives
  runtime validation and type hints in one step, which Node's TypeScript
  + zod combination needs two libraries to achieve), and is the option to
  reach for specifically if a future phase adds ML/CV/audio analysis on
  the recorded media — as a separate microservice alongside the Node
  core, not a replacement for it, since Node's advantage here (shared
  TypeScript types with React, mature MQTT ecosystem) doesn't carry over
  to Python.
- **Web framework — decided Aug 2026: Fastify**, not Express. Built-in
  JSON-schema request validation, ~3x throughput in current benchmarks,
  leaner plugin-based footprint, first-class native TypeScript support —
  fits the "many concurrent MQTT/WebSocket connections + REST" workload
  directly.
- **Backend acts as the "parsing agent"**: subscribes to MQTT topics,
  decodes Protobuf, validates/normalizes payloads (via `zod` — never
  trust the edge device blindly), and re-publishes to connected browser
  dashboards over WebSocket (Socket.IO) as JSON. Browsers talk to the
  backend, not directly to the broker — one choke point for per-vehicle
  authorization, rate limiting, and format translation. Socket.IO's
  per-vehicle "rooms" mean an operator's browser only receives traffic
  for the vehicle(s) they're actually watching, which matters directly
  at the client-confirmed 30–40 bot scale.
- **Frontend: React + TypeScript** — re-validated. Component structure
  pays off once the dashboard shows multiple vehicles/sessions live
  (Phase 2). Data-fetching layer: `@tanstack/react-query`. Live telemetry
  state: `zustand`.
- **UI components — decided Aug 2026: shadcn/ui** (on Radix primitives),
  not MUI/Mantine/Chakra. Smallest bundle and smallest dependency/attack
  surface (component code lives in the repo, not a large opaque package
  tree — reduces npm supply-chain exposure), composes directly with
  `recharts` + `react-hook-form` rather than introducing a second,
  competing form/chart/table system. MUI ruled out specifically because
  MUI X's advanced data-grid/chart tiers are paywalled — a poor fit for
  an on-prem client deliverable. Mantine is the closest runner-up (more
  turn-key, built-in charts/forms suite) if less DIY assembly is
  preferred later. Trade-off to track: shadcn/ui components are
  owned/maintained in-repo, no free upstream bugfixes — budget light
  ongoing upkeep.
- **Security baseline**: TLS everywhere for transport encryption
  (server-side certs on Traefik/Mosquitto); OIDC/JWT session for
  interactive users; RBAC enforced server-side on every action (especially
  the e-stop control); strict schema validation (`zod`) on all
  bot-originated payloads before they touch the DB; secrets via Docker
  secrets/env, never hardcoded; audit log (separate from operational logs
  — see Section 7) for every stop event and admin action.
- **Bot identity & the no-auth decision (client-confirmed Aug 2026)**: the
  client has confirmed bots implement no security of their own. The moment
  a bot connects it sends a signal (MQTT telemetry), and the only
  identifier in that signal is the VIN — self-declared, not
  cryptographically proven. This applies to both the MQTT channel and the
  bulk-upload channel, supersedes the earlier "mTLS for bot↔broker and
  bot↔upload" plan, and resolves the "certificate lifecycle for per-bot
  mTLS" open item (Section 7/9) by removing the need for bot-side certs
  entirely rather than answering issuance/rotation. Mosquitto's mTLS
  capability remains available in the software; it's simply unused for bot
  auth. No bot-side credential of any kind is used — no client certs, no
  shared API keys, no tokens — and connection/upload handling should stay
  structured so a credential check could be added later without a
  redesign, per the client's own "leave space to introduce it later"
  framing. **One exception**: bots only *subscribe* to
  `vehicles/{vin}/command` (the backend publishes to it after RBAC-
  checking an operator's e-stop action); a Mosquitto ACL restricts
  *publish* on `vehicles/+/command` to the backend's own authenticated
  connection (a plain username/password credential suffices), so an
  anonymous client can never inject a forged e-stop/resume command — the
  highest-consequence surface in this system — while bots still connect
  with zero added burden. **Residual risk, accepted by the client**: any
  client reaching the broker or upload endpoint can self-declare any VIN;
  telemetry/session/stop-event spoofing and upload-channel abuse under a
  false VIN remain unmitigated by design outside the command-publish path.
  Not affected: ordinary server-side TLS, and the "server certificate
  source" open item (Section 9) — that's the *server's* own cert and stays
  open regardless of bot auth.

## 6. Databases

- **Relational: PostgreSQL, via Prisma — decided Aug 2026** (ORM was
  previously open between Prisma and TypeORM). Prisma's Nov 2025 rewrite
  (TS/WASM engine replacing the old Rust binary) cut bundle size ~90% and
  improved query speed; auto-generated migrations/types reduce
  manual-intervention risk as the schema grows; Accelerate (connection
  pooling) and Pulse (real-time DB events) map directly onto future
  multi-instance/live-dashboard needs at the client-confirmed 30–40 bot
  scale. Holds: users/roles, vehicles/bots, test sessions/runs,
  object-storage file references, parsed report/check data, operator
  pass/fail verdicts, driver comments, stop-event classification records,
  and the append-only audit log table (see Section 7).
- **Cache: Redis — kept, with a license caveat now attached.** Redis is
  currently triple-licensed (RSALv2/SSPLv1/AGPLv3); self-hosting for this
  product is free under current terms (the paid-license trigger is
  reselling Redis as a managed cloud service or building a competing
  database product, neither of which applies here), but the terms have
  changed three times in under two years — worth a periodic re-check
  rather than treating as permanently settled, and ideally a real legal
  read given this is bundled into a client-delivered product. Holds the
  rolling live-telemetry window (sorted set/stream per vehicle,
  TTL-expired) and doubles as the pub/sub layer for cross-instance
  scaling plus session/token caching. (Valkey — a BSD-3, Linux
  Foundation-governed, wire-compatible fork — remains the zero-ambiguity
  fallback if the license situation changes again; not adopted now per
  the team's preference to stay on the more battle-tested option.)
- **Object storage: MinIO — kept, with a maintenance caveat now
  attached.** MinIO's open-source Community Edition was archived in
  April 2026 (no further releases, patches, or official binaries) —
  continuing to run it means owning CVE/security-patch response
  in-house indefinitely. Accepted for now given the team's preference for
  proven tooling over newer alternatives (Garage, SeaweedFS); worth
  revisiting if the self-patching burden becomes real, or budgeting for
  MinIO's commercial AIStor tier (Free/Enterprise Lite/Enterprise —
  pricing is quote-based, and the Free tier's license explicitly
  restricts redistribution/resale, worth checking against how this
  product is delivered to the client).
- Both Postgres and Redis have official Docker images and are
  operationally simple to run on a single client-managed on-prem server —
  no managed cloud DB dependency, matching the deployment model.

## 7. Additional points not explicitly listed

- **Networking — decided Aug 2026: Tailscale tailnet, not public internet
  exposure.** The deployment model changed: the stack runs on a laptop at
  the client site on the client's own internet connection (no static IP,
  no dedicated hosting), and Tailscale (with MagicDNS) connects the
  laptop, every bot, and every operator device on one private tailnet
  instead of exposing anything publicly — removing the firewall-approval
  friction entirely rather than just minimizing it, per the "ideally just
  443" goal below. A `tailscale` sidecar container joins the tailnet; only
  Traefik moves onto its network namespace (`network_mode:
  service:tailscale`) — the rest of the stack is unchanged. Coordination
  plane is Tailscale's hosted SaaS, not self-hosted Headscale (consistent
  with this doc's Section 2 reasoning against adding self-hosted
  infrastructure with its own ops/patching burden); accepted trade-off is
  that new connections/handshakes (not already-established sessions) can
  be delayed during a Tailscale outage. Tailscale's free tier is
  non-commercial-use only — budget the Standard plan (~$8/user/month).
- **Reverse proxy — decided Aug 2026: Traefik**, in front of the whole
  stack. Single TLS termination point and single point of ingress (now the
  tailnet, not a public port — see Networking above), routing REST/
  WebSocket traffic to the backend, static assets to the frontend, and
  MQTT-over-WSS to Mosquitto. Traefik chosen over Nginx specifically for
  Docker-label-based auto-discovery (less hand-maintained config for a
  small team); Nginx remains a fine alternative if its wider
  documentation/familiarity is preferred. Originally justified by the
  "ideally just 443" goal — the client's IT team approves firewall access
  port-by-port, so consolidating behind one port minimized that ask; that
  goal is now moot under the tailnet model (nothing needs IT approval at
  all), but Traefik's path-based multiplexing behind one hostname was kept
  rather than replaced by Tailscale's own `tailscale serve`, to keep the
  migration's diff small — see CLAUDE.md's Networking note for the
  reasoning. TLS is now sourced via `tailscale cert` rather than a public
  or client-managed CA — see the Server TLS certificate source item below,
  now resolved.
- **MediaMTX shares the tailnet network namespace (decided, updated Sep
  2026, live video)** — everything else in this stack rides through
  Traefik's single tailnet-facing entrypoint, but two of MediaMTX's ports
  genuinely can't: the WebRTC media itself (RTP/RTCP over ICE, UDP, after
  the WHEP handshake) and the RTSP ingest listener (bot → MediaMTX, see
  Section 3's Live video entry). Neither is HTTP, so Traefik's path-based
  routing doesn't apply to either one. **The original plan — publish both
  directly on the host via Docker Compose `ports:` — was tried and found
  broken**: on this project's Windows/Docker-Desktop dev host, a
  `ports:`-published port turned out to only be reliably reachable via
  Windows' own `localhost`, never via any other host-side interface
  including the Tailscale virtual adapter, so a real, separate bot
  attempting to connect got refused outright, independent of whether the
  Tailscale ACL was correct. The fix actually shipped: MediaMTX now runs
  on `network_mode: service:tailscale`, the same mechanism Traefik already
  uses — sharing that container's network namespace directly rather than
  going through Windows' host networking layer at all. Consequence: no
  `ports:` section on MediaMTX any more (a container sharing another's
  namespace has no independent interface to publish from), and Traefik's
  WHEP route — previously auto-discovered via Docker labels, which don't
  reliably resolve an address for a namespace-sharing container — is now a
  static file-provider route (`docker/traefik/dynamic-mediamtx.yml`)
  pointing at `http://127.0.0.1:8889`, valid because Traefik and MediaMTX
  now share one loopback. This also resolves the residual "reachable from
  the same LAN, not just the tailnet" exposure a previous draft of this
  document flagged under the old `ports:`-based design — the tailnet
  namespace approach doesn't have that gap, since nothing is bound to a
  general host interface at all any more.
- ~~**Certificate lifecycle for per-bot mTLS — still open**~~ — **RESOLVED
  Aug 2026**: the client confirmed bots implement no security of their
  own (see Section 5's "Bot identity & the no-auth decision"), which
  removes per-bot mTLS as the mechanism entirely rather than answering the
  issuance/rotation/revocation questions that were open under it. Kept
  here as a historical note — this was a confirmed open item in the
  client's Requirements Document v1.1, Section 11, explicitly tied to the
  30–40 bot scaling target, and is now moot at any scale. The **server**
  certificate source (public CA vs. client-managed private CA, for
  Traefik/Mosquitto's own TLS cert) is unaffected and remains open — see
  Section 9.
- **Health checks — decided Aug 2026.** Every service in
  `docker-compose.yml` gets a Docker `HEALTHCHECK` — not just "is the
  process alive" (which Docker's default crash-restart already covers)
  but "is it actually working": Postgres via `pg_isready`, Redis via
  `redis-cli ping`, MinIO via its `/minio/health/live` endpoint, backend
  via a small `/health` route, Mosquitto via a lightweight custom check
  (no built-in healthcheck shipped). Use
  `depends_on: condition: service_healthy` so dependent services wait for
  real readiness, not just container start — avoids cold-start race
  conditions. This is about knowing your *own* infrastructure is up,
  distinct from detecting a bot's connection dropping.
- **Time synchronization (NTP) — decided Aug 2026.** Both the on-prem
  server and the bot (Jetson Orin) run standard NTP clients (`chrony` /
  `systemd-timesyncd`) against a reliable time source. Matters
  specifically because the heartbeat runs at 1Hz and the app must
  distinguish operator-triggered stops from network-loss-triggered stops
  (client-confirmed requirement) — both depend on trusting event
  ordering across bot and server, which clock drift silently breaks. Not
  a client-dependent decision — just needs implementing.
- **Observability / logging — decided Aug 2026.** `pino` for structured
  JSON application logs (fast, async transport, won't block the event
  loop handling MQTT/WebSocket traffic); log levels disciplined by what
  actually earns each one (error/warn/info/debug), with raw high-
  frequency telemetry and full bot payload bodies never logged. Shipped
  via stdout to a lightweight aggregator — **Loki** (indexes labels, not
  full text) rather than a heavy full-text indexer like Elasticsearch/
  ELK. **The operational log stream and the compliance audit log are
  architecturally separate**: the audit log (every stop-event and admin
  action) is its own append-only Postgres table, never sampled or
  dropped, indefinite retention; operational/error logs can be rate-
  limited, sampled, and aged out without consequence. Concrete
  instrumentation points: Fastify's global error handler; `mqtt.js`
  `error`/`close`/`reconnect` events (broker connectivity is safety-
  relevant, ties to heartbeat reliability); zod validation failures
  (log VIN/topic/reason, not the raw payload); upload checksum mismatches
  (always `error`); Socket.IO disconnects (routine, not alarms);
  top-level uncaught-exception/unhandled-rejection handler.
- **Backup/DR for Postgres and MinIO — partially open**, see Section 9.
  Full disaster-recovery infrastructure is disproportionate for
  single-vehicle pilot scale and is held for now; a minimal scheduled
  `pg_dump` plus periodic MinIO bucket sync to a separate location is
  recommended in the meantime as cheap insurance against accidental
  deletion or corruption (not full DR) — the risk isn't bot count, it's
  that session/media/audit data may already be operationally valuable
  and can't be regenerated by re-running a physical test.
- **A documented update/release process** for shipping new container
  images to the client's on-prem server, since RoshAI doesn't control
  that server directly (pull new images + `docker compose up` at
  minimum) — not yet written down, worth doing before the first
  post-pilot update ships.
- **Design with multi-vehicle scaling in mind, even though the pilot is
  single-vehicle** — now grounded in a client-confirmed number (5–6 bots
  by end of 2026, 30–40 by end of 2027) rather than a vague "someday."
  Concretely: Mosquitto's single-node free tier comfortably covers this
  range without clustering; Socket.IO rooms and MQTT topic wildcards
  (`vehicles/+/telemetry`) already isolate per-vehicle traffic cleanly at
  this scale; with per-bot mTLS no longer in the picture (Section 5), there
  is no cert-issuance process to scale — the residual VIN-spoofing risk
  accepted in Section 5 doesn't get materially worse with bot count the
  way manual cert issuance would have.

## 8. Development process & tooling

- **Repository**: monorepo with **npm workspaces** — `backend`,
  `frontend`, and `shared` (TypeScript types generated from `.proto` via
  `ts-proto`, plus `zod` schemas both sides validate against) as
  workspaces under one root `package.json`. One install, shared root-level
  lint/format config, and a natural home for the shared-types package
  that keeps backend and frontend from drifting out of sync on
  payload/API shapes.
- **Package manager**: npm.
- **Git workflow**: three-tier — `main` → `dev` → short-lived
  `feature/*` branches. Chosen for a solo, 3–4 week build where a chunk
  of the code comes from Claude Code sessions: `feature/*` branches
  isolate one change at a time, `dev` is the integration/quarantine layer
  where a batch of (often AI-assisted) work gets exercised together
  before promotion, and `main` only advances once that batch is
  verified — so `main` always reflects what could be handed to the
  client right now. Commit style: Conventional Commits (`feat:`, `fix:`,
  `chore:`, `docs:`, `refactor:`). `husky` + `lint-staged` run
  lint/format on every commit as the stand-in for code review on a solo
  project.
- **Testing framework — still open**, see Section 9. Given the short
  timeline and that this system includes e-stop control logic, this is
  arguably the highest-priority open item left — the current safety net
  (local pre-commit hooks) can be bypassed or skipped under deadline
  pressure, and there's no remote CI gate independent of that.

## 9. Open items requiring confirmation

Deliberately deferred, not silently decided. Do not assume an answer for
any of these without checking:

| Item | Why it matters | Owner |
|---|---|---|
| ~~Server certificate source — public CA vs. client-managed private CA~~ — **RESOLVED Aug 2026** | Superseded by the Tailscale migration: Traefik's cert now comes from `tailscale cert` for the node's MagicDNS hostname, refreshed by a periodic sidecar. Kept as a historical note. | — |
| Container runtime on the client's actual server — Docker Desktop/WSL2 vs. Docker Engine vs. Podman | Affects install instructions and Compose compatibility; not every client IT policy permits WSL2 | Client |
| Object storage retention/lifecycle policy | Uncompressed WAV (and later video) will grow storage fast; bucket-per-type layout is already set up to make this answerable without a migration | RoshAI, informed by client data-handling expectations |
| Full backup/DR strategy | Minimal interim mitigation recommended (Section 7); full DR infra held as disproportionate at pilot scale | RoshAI |
| Testing framework | No framework chosen yet; do not scaffold one unassisted | RoshAI |

---

*This is a planning-stage recommendation for internal use — not a
client-facing document, though several items above (server cert source,
container runtime, bulk-transfer protocol) do need a client-facing answer
before they can close. Decisions marked "Decided Aug 2026" above are
finalized for this build, including the bot no-auth decision in Section 5;
items in Section 9 are not — confirm before implementing anything that
depends on them.*
