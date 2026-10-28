import mqtt, { type MqttClient } from 'mqtt';
import {
  telemetryPayloadSchema,
  sessionPayloadSchema,
  sessionAckPayloadSchema,
  stopEventPayloadSchema,
  commandPayloadSchema,
  videoControlCommandSchema,
  videoStatusSchema,
  MQTT_TOPICS_INBOUND,
  commandTopic,
  videoControlTopic,
  handshakeResponseTopic,
  vinTopicSegmentSchema,
  ProtoSessionPayload,
  ProtoSessionAckPayload,
  ProtoTelemetryPayload,
  ProtoCommandPayload,
  ProtoStopEventPayload,
  ProtoVideoControlCommand,
  ProtoVideoStatus,
  SessionEventType,
  CommandAction,
  StopEventCause,
  GpsStatus,
  VideoAction,
  VideoState,
  type BotTopicKind,
  type CommandPayload,
  type SessionAckPayload,
  type VideoControlCommand
} from '@roshai/shared';
import { logger } from './logger.js';
import { createRateLimitedLogger } from './rate-limited-logger.js';

export type BotMessageHandler = (vin: string, kind: BotTopicKind, payload: unknown) => void;

function protoEventTypeToApp(
  eventType: SessionEventType
): 'session-start' | 'session-end' | undefined {
  switch (eventType) {
    case SessionEventType.SESSION_EVENT_TYPE_SESSION_START:
      return 'session-start';
    case SessionEventType.SESSION_EVENT_TYPE_SESSION_END:
      return 'session-end';
    default:
      return undefined;
  }
}

function appCommandActionToProto(action: 'e-stop' | 'resume'): CommandAction {
  switch (action) {
    case 'e-stop':
      return CommandAction.COMMAND_ACTION_E_STOP;
    case 'resume':
      return CommandAction.COMMAND_ACTION_RESUME;
  }
}

// Deliberately total, not partial: returning `undefined` for any cause
// (including STOP_EVENT_CAUSE_UNSPECIFIED=0 — the proto3 default when a
// bot omits the field — or a future enum value ts-proto decodes as
// UNRECOGNIZED=-1) fails stopEventPayloadSchema's required `cause` field,
// which drops the ENTIRE stop-event message (only a warn log, no session
// update) rather than just mislabeling it. That's what happened with
// STOP_EVENT_CAUSE_UNSPECIFIED: the session never ended, Stop/Watch
// stayed enabled, even though the bot's independent HTTP report upload
// still succeeded. Every path — known, newly-added-but-unmapped, or
// genuinely unrecognized — must still end the session; 'unknown' is the
// safe fallback label rather than silently dropping the message.
function protoStopEventCauseToApp(
  cause: StopEventCause
): 'operator' | 'network-loss' | 'error' | 'manual-shutdown' | 'unknown' {
  switch (cause) {
    case StopEventCause.STOP_EVENT_CAUSE_OPERATOR:
      return 'operator';
    case StopEventCause.STOP_EVENT_CAUSE_NETWORK_LOSS:
      return 'network-loss';
    case StopEventCause.STOP_EVENT_CAUSE_ERROR:
      return 'error';
    case StopEventCause.STOP_EVENT_CAUSE_MANUAL_SHUTDOWN:
      return 'manual-shutdown';
    case StopEventCause.STOP_EVENT_CAUSE_UNKNOWN:
    case StopEventCause.STOP_EVENT_CAUSE_UNSPECIFIED:
    default:
      return 'unknown';
  }
}

// UNSPECIFIED (field omitted — firmware that predates gps_status) maps to
// 'fix' so existing bots keep showing their position exactly as before;
// only an explicit NO_FIX hides it. An unrecognized future value is also
// treated as 'no-fix' — safer to hide a position we can't vouch for than
// to plot one that might be a placeholder.
function protoGpsStatusToApp(status: GpsStatus): 'fix' | 'no-fix' {
  switch (status) {
    case GpsStatus.GPS_STATUS_FIX:
    case GpsStatus.GPS_STATUS_UNSPECIFIED:
      return 'fix';
    case GpsStatus.GPS_STATUS_NO_FIX:
    default:
      return 'no-fix';
  }
}

// Last-seen GPS status per vin, only so fix<->no-fix transitions are
// logged once at info rather than on every 1Hz message.
const lastGpsStatusByVin = new Map<string, 'fix' | 'no-fix'>();

function appVideoActionToProto(action: 'start' | 'stop' | 'set-bitrate'): VideoAction {
  switch (action) {
    case 'start':
      return VideoAction.VIDEO_ACTION_START;
    case 'stop':
      return VideoAction.VIDEO_ACTION_STOP;
    case 'set-bitrate':
      return VideoAction.VIDEO_ACTION_SET_BITRATE;
  }
}

function protoVideoStateToApp(
  state: VideoState
): 'starting' | 'streaming' | 'stopped' | 'error' | undefined {
  switch (state) {
    case VideoState.VIDEO_STATE_STARTING:
      return 'starting';
    case VideoState.VIDEO_STATE_STREAMING:
      return 'streaming';
    case VideoState.VIDEO_STATE_STOPPED:
      return 'stopped';
    case VideoState.VIDEO_STATE_ERROR:
      return 'error';
    default:
      return undefined;
  }
}

// vin is a required, separate parameter now that handshake-response is a
// per-vin topic (see publishSessionAck) — the ack payload itself carries
// no vin field (mirrors the bot team's real HandshakeResponse shape).
// Ack delivery is skipped (logged only) when vin isn't usable as a topic
// segment — there's no route back to a bot whose vin we don't reliably
// know, unlike the old shared-topic convention where a best-effort
// broadcast nack was at least possible (if not especially useful, since
// every other bot would've ignored it anyway on sessionId mismatch).
function sendSessionAck(client: MqttClient, vin: string, payload: SessionAckPayload): void {
  const vinResult = vinTopicSegmentSchema.safeParse(vin);
  if (!vinResult.success) {
    logger.warn({ vin }, 'cannot deliver session ack: vin unusable as a topic segment');
    return;
  }
  publishSessionAck(client, vinResult.data, payload).catch((err: unknown) =>
    logger.error({ err, vin }, 'session ack publish failed')
  );
}

// Handles the handshake request/response pair. Everything arriving here
// is by definition a handshake attempt (it's the topic's sole purpose).
function handleHandshakeRequest(
  client: MqttClient,
  payloadBuffer: Buffer,
  onMessage: BotMessageHandler
): void {
  let decoded: ReturnType<typeof ProtoSessionPayload.decode>;
  try {
    decoded = ProtoSessionPayload.decode(payloadBuffer);
  } catch (err) {
    // No vin at all in this branch (decode itself failed) — nothing to
    // build a per-vin response topic from, so there's no ack to send.
    logger.warn({ err }, 'handshake payload protobuf decode failed');
    return;
  }

  const result = sessionPayloadSchema.safeParse({
    vinNumber: decoded.vinNumber,
    macId: decoded.macId || undefined,
    sessionId: decoded.sessionId,
    timestamp: decoded.timestamp,
    eventType: protoEventTypeToApp(
      decoded.eventType ?? SessionEventType.SESSION_EVENT_TYPE_UNSPECIFIED
    )
  });

  if (!result.success) {
    const reason = result.error.issues.map((i) => i.message).join('; ');
    logger.warn({ vin: decoded.vinNumber, reason }, 'handshake payload validation failed');
    if (
      decoded.eventType !== SessionEventType.SESSION_EVENT_TYPE_SESSION_END &&
      decoded.vinNumber
    ) {
      sendSessionAck(client, decoded.vinNumber, {
        success: false,
        message: reason,
        sessionId: decoded.sessionId ?? ''
      });
    }
    return;
  }

  const session = result.data;
  if (!session.timestamp) session.timestamp = new Date().toISOString();

  // Validated once here, at the point vin first enters application state
  // (the registry, and from there the RTSP ingest path and every per-vin
  // MQTT topic built from a session's vin) — cheaper and more reliable
  // than re-checking at every downstream use site. sessionPayloadSchema
  // above only requires a non-empty string; this is the MQTT-topic-and-
  // URL-path-safe subset of that.
  const vinResult = vinTopicSegmentSchema.safeParse(session.vinNumber);
  if (!vinResult.success) {
    logger.warn(
      { vin: session.vinNumber },
      'handshake rejected: vin unusable as a topic/path segment'
    );
    return;
  }

  // macId is mandatory for a session-start specifically (not for
  // session-end, which doesn't need it — see sessionPayloadSchema's own
  // comment on why macId stays .optional() there). This is what lets
  // VehicleSession.macId be a plain non-nullable string downstream,
  // closing the composite-identity NULL-semantics gap for the dominant
  // path (see vehicle-registry.ts / VehicleSessionHistory's composite
  // unique constraint). Not a new requirement on the bot — mac_id was
  // already part of the bot-team-confirmed handshake shape.
  if (session.eventType === 'session-start' && !session.macId) {
    logger.warn(
      { vin: session.vinNumber },
      'handshake rejected: macId required to start a session'
    );
    return;
  }

  logger.debug({ vin: session.vinNumber }, 'handshake payload bridged');
  onMessage(session.vinNumber, 'session', session);

  if (session.eventType === 'session-start') {
    sendSessionAck(client, session.vinNumber, {
      success: true,
      message: 'handshake accepted',
      sessionId: session.sessionId
    });
    // Heartbeat is no longer started here — it's a single fleet-wide
    // broadcast started once, unconditionally, at backend startup (see
    // index.ts and heartbeat-service.ts's own doc comment for why).
  }
}

// Stays one-directional and fire-and-forget, matching its prior
// behavior — no ack.
function handleTelemetry(payloadBuffer: Buffer, onMessage: BotMessageHandler): void {
  let decoded: ReturnType<typeof ProtoTelemetryPayload.decode>;
  try {
    decoded = ProtoTelemetryPayload.decode(payloadBuffer);
  } catch (err) {
    logger.warn({ err }, 'telemetry payload protobuf decode failed');
    return;
  }

  const gpsStatus = protoGpsStatusToApp(decoded.gpsStatus ?? GpsStatus.GPS_STATUS_UNSPECIFIED);
  const { latitude, longitude, altitude, ...rest } = decoded;
  // On no-fix, drop the position fields entirely (the bot sends 0
  // placeholders) so downstream code can't mistake them for a real position.
  const candidate =
    gpsStatus === 'fix'
      ? { ...rest, gpsStatus, latitude, longitude, altitude }
      : { ...rest, gpsStatus };

  const result = telemetryPayloadSchema.safeParse(candidate);
  if (!result.success) {
    logger.warn(
      { vin: decoded.vinNumber, reason: result.error.issues.map((i) => i.message).join('; ') },
      'telemetry payload validation failed'
    );
    return;
  }

  const vin = result.data.vinNumber;
  const previousGpsStatus = lastGpsStatusByVin.get(vin);
  if (previousGpsStatus !== gpsStatus) {
    lastGpsStatusByVin.set(vin, gpsStatus);
    // Skip the very first message per vin when it's a fix — that's the
    // normal case, not a transition worth logging.
    if (previousGpsStatus !== undefined || gpsStatus === 'no-fix') {
      logger.info({ vin, gpsStatus }, 'vehicle GPS status changed');
    }
  }

  logger.debug({ vin }, 'telemetry payload bridged');
  onMessage(result.data.vinNumber, 'telemetry', result.data);
}

// Every "vehicle stopped" scenario reports through this one message. No
// longer stops heartbeat here — heartbeat is a single fleet-wide
// broadcast, and stopping it because one vehicle's session ended used to
// silently cut heartbeat for every other still-active vehicle too (see
// heartbeat-service.ts's doc comment for the full story).
function handleStopEvent(payloadBuffer: Buffer, onMessage: BotMessageHandler): void {
  let decoded: ReturnType<typeof ProtoStopEventPayload.decode>;
  try {
    decoded = ProtoStopEventPayload.decode(payloadBuffer);
  } catch (err) {
    logger.warn({ err }, 'stop-event payload protobuf decode failed');
    return;
  }

  const result = stopEventPayloadSchema.safeParse({
    vinNumber: decoded.vinNumber,
    timestampMs: decoded.timestampMs,
    cause: protoStopEventCauseToApp(decoded.cause ?? StopEventCause.STOP_EVENT_CAUSE_UNSPECIFIED),
    reason: decoded.reason || undefined
  });

  if (!result.success) {
    logger.warn(
      {
        vin: decoded.vinNumber,
        reason: result.error.issues.map((i) => i.message).join('; ')
      },
      'stop-event payload validation failed'
    );
    return;
  }

  logger.debug({ vin: result.data.vinNumber }, 'stop-event payload bridged');
  onMessage(result.data.vinNumber, 'stop-event', result.data);
}

// Bot's report of actual video pipeline state after a VideoControlCommand
// (see shared/proto/video.proto) — reported here so the backend/UI
// reflect reality rather than just "we sent a command." Stays
// one-directional and fire-and-forget like telemetry, no ack.
function handleVideoStatus(payloadBuffer: Buffer, onMessage: BotMessageHandler): void {
  let decoded: ReturnType<typeof ProtoVideoStatus.decode>;
  try {
    decoded = ProtoVideoStatus.decode(payloadBuffer);
  } catch (err) {
    logger.warn({ err }, 'video-status payload protobuf decode failed');
    return;
  }

  const result = videoStatusSchema.safeParse({
    vinNumber: decoded.vinNumber,
    sessionId: decoded.sessionId,
    commandId: decoded.commandId,
    state: protoVideoStateToApp(decoded.state ?? VideoState.VIDEO_STATE_UNSPECIFIED),
    currentBitrateKbps: decoded.currentBitrateKbps || undefined,
    currentWidth: decoded.currentWidth || undefined,
    currentHeight: decoded.currentHeight || undefined,
    errorMessage: decoded.errorMessage || undefined,
    reportedAtMs: decoded.reportedAtMs
  });

  if (!result.success) {
    logger.warn(
      { vin: decoded.vinNumber, reason: result.error.issues.map((i) => i.message).join('; ') },
      'video-status payload validation failed'
    );
    return;
  }

  logger.debug({ vin: result.data.vinNumber, state: result.data.state }, 'video-status bridged');
  onMessage(result.data.vinNumber, 'video-status', result.data);
}

// Indefinite reconnect (mqtt.js's default) is kept deliberately, not
// capped — a persistent broker connection is the recognized exception to
// "never retry indefinitely": unlike a one-shot API call, the whole point
// is maintaining an always-on connection through network blips.
export function connectMqtt(onMessage: BotMessageHandler): MqttClient {
  const url = process.env.MQTT_BROKER_URL ?? 'mqtt://localhost:1883';
  const client = mqtt.connect(url, {
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clientId: `backend-service-${process.pid}`,
    connectTimeout: 10_000,
    reconnectPeriod: 2_000
  });

  const rateLimited = createRateLimitedLogger(logger, 60_000);

  client.on('connect', () => {
    logger.info({ brokerUrl: url }, 'mqtt connected');
    // Bot->backend topics are still fixed/shared (see
    // shared/src/mqtt/topics.ts's MQTT_TOPICS_INBOUND) — many bots
    // publishing to the same topic works fine, since the backend demuxes
    // every message by its own payload vin_number, not by topic.
    // command/videoControl/handshakeResponse are NOT subscribed here —
    // those are now per-vin topics the backend only ever publishes to
    // (bots are the subscriber). Per-topic QoS: telemetry is QoS 0 —
    // spec-agreed loss-tolerant (a missed reading is fine, just move to
    // the next), same reasoning as the heartbeat's QoS 0. Handshake and
    // stop-event stay QoS 1 — each is a discrete event where silently
    // losing one matters. video-status is QoS 1 too, same reasoning (see
    // shared/proto/video.proto).
    const subscriptions = {
      [MQTT_TOPICS_INBOUND.handshakeRequest]: { qos: 1 as const },
      [MQTT_TOPICS_INBOUND.telemetry]: { qos: 0 as const },
      [MQTT_TOPICS_INBOUND.stopEvent]: { qos: 1 as const },
      [MQTT_TOPICS_INBOUND.videoStatus]: { qos: 1 as const }
    };
    client.subscribe(subscriptions, (err) => {
      if (err) logger.error({ err }, 'mqtt subscribe failed');
      else logger.info({ topics: Object.keys(subscriptions) }, 'mqtt subscribed');
    });
  });

  client.on('message', (topic, payloadBuffer) => {
    if (topic === MQTT_TOPICS_INBOUND.handshakeRequest) {
      handleHandshakeRequest(client, payloadBuffer, onMessage);
      return;
    }

    if (topic === MQTT_TOPICS_INBOUND.telemetry) {
      handleTelemetry(payloadBuffer, onMessage);
      return;
    }

    if (topic === MQTT_TOPICS_INBOUND.stopEvent) {
      handleStopEvent(payloadBuffer, onMessage);
      return;
    }

    if (topic === MQTT_TOPICS_INBOUND.videoStatus) {
      handleVideoStatus(payloadBuffer, onMessage);
      return;
    }

    logger.warn({ topic }, 'mqtt message on unexpected topic');
  });

  client.on('error', (err) => rateLimited('error', 'mqtt client error', { err: err.message }));
  client.on('close', () => rateLimited('warn', 'mqtt connection closed'));
  client.on('reconnect', () => rateLimited('warn', 'mqtt reconnecting'));

  return client;
}

// Per-vin topic (robot/{vin}/command) — the broker only delivers to the
// bot subscribed to its own vin, so an e-stop for one vehicle cannot
// reach another. vin is validated through vinTopicSegmentSchema before
// being interpolated into the topic string: payload.vinNumber can
// originate from an unauthenticated bot-published handshake/telemetry
// message (see mqtt-client.ts's decode handlers), so it must never be
// trusted verbatim as a topic segment — an unvalidated vin here would be
// a topic-injection surface that didn't exist under the old fixed-topic
// convention.
export function publishCommand(client: MqttClient, payload: CommandPayload): Promise<void> {
  const validated = commandPayloadSchema.parse(payload);
  const vin = vinTopicSegmentSchema.parse(validated.vinNumber);
  const bytes = ProtoCommandPayload.encode(
    ProtoCommandPayload.fromPartial({
      vinNumber: validated.vinNumber,
      action: appCommandActionToProto(validated.action),
      issuedAt: validated.issuedAt,
      issuedBy: validated.issuedBy
    })
  ).finish();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mqtt command publish timed out')), 5_000);
    client.publish(commandTopic(vin), Buffer.from(bytes), { qos: 1 }, (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

// Per-vin topic (robot/{vin}/video/control), same vin-validation
// requirement and reasoning as publishCommand above.
export function publishVideoControl(
  client: MqttClient,
  payload: VideoControlCommand
): Promise<void> {
  const validated = videoControlCommandSchema.parse(payload);
  const vin = vinTopicSegmentSchema.parse(validated.vinNumber);
  const bytes = ProtoVideoControlCommand.encode(
    ProtoVideoControlCommand.fromPartial({
      vinNumber: validated.vinNumber,
      sessionId: validated.sessionId,
      commandId: validated.commandId,
      action: appVideoActionToProto(validated.action),
      targetBitrateKbps: validated.targetBitrateKbps,
      targetWidth: validated.targetWidth,
      targetHeight: validated.targetHeight,
      targetFps: validated.targetFps,
      ingestUrl: validated.ingestUrl,
      issuedAtMs: validated.issuedAtMs
    })
  ).finish();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('mqtt video control publish timed out')),
      5_000
    );
    client.publish(videoControlTopic(vin), Buffer.from(bytes), { qos: 1 }, (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

// Per-vin topic (robot/{vin}/handshake/response). vin is a separate
// parameter, not part of SessionAckPayload — the ack payload itself
// carries no vin field (mirrors the bot team's real HandshakeResponse
// shape), so the caller must supply and validate it (see
// sendSessionAck's vinTopicSegmentSchema check above). The bot must
// already be subscribed to its own vin's response topic before it
// publishes its request (see
// docs/mqtt-multi-vehicle-topic-proposal.html) — unlike the old
// shared-response-topic convention, subscribe timing now matters.
export function publishSessionAck(
  client: MqttClient,
  vin: string,
  payload: SessionAckPayload
): Promise<void> {
  const validated = sessionAckPayloadSchema.parse(payload);
  const bytes = ProtoSessionAckPayload.encode(
    ProtoSessionAckPayload.fromPartial(validated)
  ).finish();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mqtt session ack publish timed out')), 5_000);
    client.publish(handshakeResponseTopic(vin), Buffer.from(bytes), { qos: 1 }, (err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

export function closeMqtt(client: MqttClient, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mqtt graceful close timed out')), timeoutMs);
    client.end(false, {}, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
