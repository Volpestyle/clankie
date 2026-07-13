import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { createLogger } from "@clankie/observability";
import {
  TerminalCapabilitiesMessageSchema,
  TerminalClientMessageSchema,
  TerminalDiscoveryResponseSchema,
  TerminalErrorMessageSchema,
  TerminalResyncRequiredMessageSchema,
  TerminalStreamMessageSchema,
  TerminalSubscribedMessageSchema,
  type TerminalCapabilities,
  type TerminalClientMessage,
  type TerminalDiscoverySession,
  type TerminalErrorMessage,
  type TerminalFrame,
  type TerminalLifecycle,
  type TerminalStreamMessage,
} from "@clankie/terminal-protocol";
import type { TerminalManager, TerminalObservation } from "./terminals.ts";
import type { TerminalAccessGrant, TerminalTokenVerifier } from "./terminal-access-authority.ts";

type Logger = ReturnType<typeof createLogger>;

export const TERMINAL_GATEWAY_DEFAULT_HOST = "127.0.0.1";
export const TERMINAL_GATEWAY_DEFAULT_PORT = 4312;
export const TERMINAL_GATEWAY_PATH = "/v1/terminals";

/** Observe-only effective capabilities: control/input/resize are always denied at this endpoint. */
const OBSERVE_ONLY_CAPABILITIES: TerminalCapabilities = {
  observe: true,
  resume: true,
  vtRestoreSnapshot: true,
  controlLease: false,
  input: false,
  resize: false,
};
const CAPABILITIES_REVISION = 1;
const PROTOCOL_VERSION = 1;

export interface TerminalGatewayRateLimit {
  /** Burst allowance: messages that may be accepted before the refill rate governs. */
  capacity?: number;
  /** Sustained accepted-message rate per second. */
  refillPerSecond?: number;
}

export interface TerminalGatewayConfig {
  host?: string;
  port?: number;
}

export interface TerminalGatewayOptions {
  manager: TerminalManager;
  authority: TerminalTokenVerifier;
  config?: TerminalGatewayConfig;
  logger?: Logger;
  /** Maximum accepted inbound frame size (bytes). Clients never send terminal data, so this stays small. */
  maxInboundMessageBytes?: number;
  /** Absolute lifetime backstop on inbound messages per connection. */
  maxInboundMessagesPerConnection?: number;
  /** Deterministic per-connection inbound rate limit (token bucket). */
  rateLimit?: TerminalGatewayRateLimit;
  /** Socket buffered-bytes ceiling before a slow consumer is deterministically terminated. */
  maxOutboundBufferedBytes?: number;
  /** Bounded wait for a quiescent snapshot boundary at or beyond a requested resync floor. */
  snapshotBoundaryWaitMs?: number;
  /** Injectable monotonic clock (milliseconds) for deterministic rate-limit tests. */
  now?: () => number;
}

export interface TerminalGateway {
  readonly address: { host: string; port: number };
  readonly connectionCount: number;
  close(): Promise<void>;
}

/** Only the exact numeric IPv4 loopback address is accepted; every other host fails closed. */
export function assertLoopbackHost(host: string): void {
  if (host !== TERMINAL_GATEWAY_DEFAULT_HOST) {
    throw new Error("terminal gateway must bind the exact loopback address 127.0.0.1");
  }
}

class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly now: () => number;
  private tokens: number;
  private last: number;
  public constructor(capacity: number, refillPerMs: number, now: () => number) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.now = now;
    this.tokens = capacity;
    this.last = now();
  }
  public take(): boolean {
    const current = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, current - this.last) * this.refillPerMs);
    this.last = current;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export async function createTerminalGateway(options: TerminalGatewayOptions): Promise<TerminalGateway> {
  const host = options.config?.host ?? TERMINAL_GATEWAY_DEFAULT_HOST;
  const port = options.config?.port ?? TERMINAL_GATEWAY_DEFAULT_PORT;
  assertLoopbackHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("terminal gateway port must be an integer in [0, 65535]");
  }
  const logger =
    options.logger ?? createLogger({ service: "clankie-runner-terminal-gateway", version: "0.1.0" });
  const now = options.now ?? Date.now;
  const maxInboundMessageBytes = options.maxInboundMessageBytes ?? 64 * 1024;
  const maxInboundMessagesPerConnection = options.maxInboundMessagesPerConnection ?? 100_000;
  const maxOutboundBufferedBytes = options.maxOutboundBufferedBytes ?? 8 * 1024 * 1024;
  const snapshotBoundaryWaitMs = options.snapshotBoundaryWaitMs ?? 2_000;
  const rateCapacity = options.rateLimit?.capacity ?? 32;
  const rateRefillPerMs = (options.rateLimit?.refillPerSecond ?? 16) / 1000;
  assertPositiveInteger(maxInboundMessageBytes, "maxInboundMessageBytes");
  assertPositiveInteger(maxInboundMessagesPerConnection, "maxInboundMessagesPerConnection");
  assertPositiveInteger(maxOutboundBufferedBytes, "maxOutboundBufferedBytes");
  assertPositiveInteger(snapshotBoundaryWaitMs, "snapshotBoundaryWaitMs");
  assertPositiveInteger(rateCapacity, "rateLimit.capacity");
  if (!Number.isFinite(rateRefillPerMs) || rateRefillPerMs <= 0) {
    throw new Error("rateLimit.refillPerSecond must be a positive finite number");
  }

  const server = createServer((_request, response) => {
    // No unauthenticated health or discovery route is exposed.
    response.statusCode = 404;
    response.end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxInboundMessageBytes });
  const connections = new Set<Connection>();

  server.on("upgrade", (request, socket, head) => {
    const decision = authorizeUpgrade(request, options.authority);
    if (!decision.ok) {
      rejectUpgrade(socket, decision.status);
      logger.info(
        { event: "terminal.gateway.upgrade.rejected", status: decision.status },
        "terminal gateway upgrade rejected",
      );
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const connection = new Connection({
        ws,
        grant: decision.grant,
        manager: options.manager,
        logger,
        rateBucket: new TokenBucket(rateCapacity, rateRefillPerMs, now),
        maxInboundMessagesPerConnection,
        maxOutboundBufferedBytes,
        snapshotBoundaryWaitMs,
        onClosed: (self) => connections.delete(self),
      });
      connections.add(connection);
      logger.info(
        { event: "terminal.gateway.connection.open", connections: connections.size },
        "terminal gateway connection opened",
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.removeListener("error", onError);
      resolve();
    });
  });
  const bound = server.address();
  const boundPort = typeof bound === "object" && bound ? bound.port : port;
  logger.info({ event: "terminal.gateway.listening", host, port: boundPort }, "terminal gateway listening");

  let closing: Promise<void> | undefined;
  return {
    address: { host, port: boundPort },
    get connectionCount() {
      return connections.size;
    },
    close() {
      // Idempotent: repeated calls await the same wind-down instead of racing.
      if (!closing) {
        closing = (async () => {
          await Promise.all(
            [...connections].map((connection) => connection.closeAndDrain("server_shutdown")),
          );
          await new Promise<void>((resolve) => wss.close(() => resolve()));
          await new Promise<void>((resolve) => server.close(() => resolve()));
        })();
      }
      return closing;
    },
  };
}

type UpgradeDecision =
  | { ok: true; grant: TerminalAccessGrant }
  | { ok: false; status: 401 | 403 | 404 | 405 };

function authorizeUpgrade(request: IncomingMessage, authority: TerminalTokenVerifier): UpgradeDecision {
  if ((request.method ?? "GET").toUpperCase() !== "GET") return { ok: false, status: 405 };
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== TERMINAL_GATEWAY_PATH) return { ok: false, status: 404 };
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return { ok: false, status: 401 };
  const verification = authority.verify(header.slice("Bearer ".length));
  if (!verification.ok) return { ok: false, status: 401 };
  // Effective observe-only endpoint: a valid token still needs the observe scope to attach.
  if (!verification.grant.scopes.includes("observe")) return { ok: false, status: 403 };
  return { ok: true, grant: verification.grant };
}

const HTTP_STATUS_TEXT: Record<number, string> = {
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
};

function rejectUpgrade(socket: Duplex, status: 401 | 403 | 404 | 405): void {
  const lines = [`HTTP/1.1 ${status} ${HTTP_STATUS_TEXT[status]}`, "Connection: close", "Content-Length: 0"];
  if (status === 401) lines.push('WWW-Authenticate: Bearer realm="clankie-terminal"');
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  socket.destroy();
}

interface ConnectionOptions {
  ws: WebSocket;
  grant: TerminalAccessGrant;
  manager: TerminalManager;
  logger: Logger;
  rateBucket: TokenBucket;
  maxInboundMessagesPerConnection: number;
  maxOutboundBufferedBytes: number;
  snapshotBoundaryWaitMs: number;
  onClosed: (connection: Connection) => void;
}

class Connection {
  public readonly id = `conn-${randomUUID()}`;
  private readonly ws: WebSocket;
  private readonly grant: TerminalAccessGrant;
  private readonly manager: TerminalManager;
  private readonly logger: Logger;
  private readonly rateBucket: TokenBucket;
  private readonly maxInboundMessages: number;
  private readonly maxOutboundBufferedBytes: number;
  private readonly snapshotBoundaryWaitMs: number;
  private readonly onClosed: (connection: Connection) => void;
  private inboundCount = 0;
  private closed = false;
  // Exactly one stream attachment per socket. A new subscribe/resume/resync aborts the
  // prior iterator and waits for it to wind down before the new ack, so no stale-subscription
  // frame can interleave after the new attachment is acknowledged.
  private attachAbort: AbortController | null = null;
  private windDown: Promise<void> = Promise.resolve();

  public constructor(options: ConnectionOptions) {
    this.ws = options.ws;
    this.grant = options.grant;
    this.manager = options.manager;
    this.logger = options.logger;
    this.rateBucket = options.rateBucket;
    this.maxInboundMessages = options.maxInboundMessagesPerConnection;
    this.maxOutboundBufferedBytes = options.maxOutboundBufferedBytes;
    this.snapshotBoundaryWaitMs = options.snapshotBoundaryWaitMs;
    this.onClosed = options.onClosed;
    this.ws.on("message", (data: Buffer, isBinary: boolean) => this.onMessage(data, isBinary));
    this.ws.on("close", () => this.finalize("client_closed"));
    this.ws.on("error", () => this.finalize("socket_error"));
  }

  public terminate(reason: string): void {
    this.finalize(reason);
  }

  /** Finalize then await the current attachment winding down so its observer is removed. */
  public async closeAndDrain(reason: string): Promise<void> {
    this.finalize(reason);
    await this.windDown.catch(() => {});
  }

  private finalize(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.attachAbort?.abort();
    try {
      this.ws.terminate();
    } catch {
      /* already destroyed */
    }
    this.logger.info(
      { event: "terminal.gateway.connection.close", reason },
      "terminal gateway connection closed",
    );
    this.onClosed(this);
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      this.sendError(null, null, "malformed_message", "binary frames are not accepted");
      this.finalize("binary_frame");
      return;
    }
    if (++this.inboundCount > this.maxInboundMessages) {
      this.finalize("lifetime_cap");
      return;
    }
    if (!this.rateBucket.take()) {
      this.sendError(null, null, "internal", "request rate exceeded");
      this.finalize("rate_limited");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      this.sendError(null, null, "malformed_message", "message is not valid JSON");
      this.finalize("malformed_json");
      return;
    }
    const version = (parsed as { protocolVersion?: unknown })?.protocolVersion;
    if (typeof version === "number" && version !== PROTOCOL_VERSION) {
      this.sendError(null, null, "unsupported_version", "unsupported protocol version");
      return;
    }
    const result = TerminalClientMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.sendError(null, null, "malformed_message", "message failed schema validation");
      return;
    }
    const message = result.data;
    if (
      message.attribution.principalId !== this.grant.principalId ||
      message.attribution.deviceId !== this.grant.deviceId
    ) {
      const terminalId = "terminalId" in message ? message.terminalId : null;
      this.sendError(
        message.requestId,
        terminalId,
        "attribution_mismatch",
        "attribution does not match token",
      );
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: TerminalClientMessage): void {
    switch (message.type) {
      case "terminal.discover":
        this.handleDiscover(message.requestId);
        return;
      case "terminal.subscribe":
        // Fresh subscribe has no replay floor.
        this.beginAttachment((signal) =>
          this.attachSnapshot(signal, message.terminalId, message.requestId, 0),
        );
        return;
      case "terminal.resume":
        this.beginAttachment((signal) =>
          this.attachResume(signal, message.terminalId, message.requestId, message.cursor.sequence),
        );
        return;
      case "terminal.resync":
        // Resync must not regress: never deliver a snapshot below the requested cursor floor.
        this.beginAttachment((signal) =>
          this.attachSnapshot(signal, message.terminalId, message.requestId, message.cursor.sequence),
        );
        return;
      case "terminal.capabilities.get":
        this.handleCapabilities(message.requestId, message.terminalId);
        return;
      case "terminal.sessions.list":
        // The frozen gateway listing path is discover-only; the alternate list request is refused.
        this.sendError(message.requestId, null, "capability_unavailable", "listing uses terminal.discover");
        return;
      case "terminal.lease.request":
      case "terminal.lease.renew":
      case "terminal.lease.release":
      case "terminal.input":
      case "terminal.resize":
        // Observe-only endpoint: control-plane operations are denied and never reach the manager.
        this.sendError(message.requestId, message.terminalId, "scope_denied", "endpoint is observe-only");
        return;
    }
  }

  /** Serialize attachments so a new one supersedes the prior with no interleaved stale frames. */
  private beginAttachment(run: (signal: AbortSignal) => Promise<void>): void {
    this.attachAbort?.abort();
    const abort = new AbortController();
    this.attachAbort = abort;
    const previous = this.windDown;
    const started = (async () => {
      await previous;
      if (abort.signal.aborted || this.closed) return;
      await run(abort.signal);
    })();
    this.windDown = started.catch(() => {
      this.logger.warn(
        { event: "terminal.gateway.attachment.error", reason: "attachment_failed" },
        "terminal gateway attachment ended in error",
      );
    });
  }

  private handleDiscover(requestId: string): void {
    let sessions: TerminalDiscoverySession[];
    try {
      sessions = this.manager.openObservations().map((observation) => ({
        terminalId: observation.terminalId,
        workerRunId: observation.workerRunId,
        title: observation.title,
        source: observation.source,
        geometry: { columns: observation.columns, rows: observation.rows },
        lastSequence: observation.lastSequence,
        lifecycle: { state: "open" as const },
        capabilities: OBSERVE_ONLY_CAPABILITIES,
        capabilitiesRevision: CAPABILITIES_REVISION,
      }));
    } catch {
      this.sendError(requestId, null, "internal", "discovery failed");
      return;
    }
    this.rawSend(TerminalDiscoveryResponseSchema, {
      protocolVersion: PROTOCOL_VERSION,
      type: "terminal.discovery",
      requestId,
      // Observe-only endpoint: never advertise control regardless of token claims.
      grantedScopes: ["observe"],
      sessions,
    });
  }

  private handleCapabilities(requestId: string, terminalId: string): void {
    try {
      this.manager.observation(terminalId);
    } catch {
      this.sendError(requestId, terminalId, "not_found", "terminal not found");
      return;
    }
    this.rawSend(TerminalCapabilitiesMessageSchema, {
      protocolVersion: PROTOCOL_VERSION,
      type: "terminal.capabilities",
      requestId,
      terminalId,
      revision: CAPABILITIES_REVISION,
      capabilities: OBSERVE_ONLY_CAPABILITIES,
    });
  }

  private observationOr(terminalId: string, requestId: string): TerminalObservation | null {
    try {
      return this.manager.observation(terminalId);
    } catch {
      this.sendError(requestId, terminalId, "not_found", "terminal not found");
      return null;
    }
  }

  /** Fresh subscribe or resync: subscribed(snapshot) then the authoritative snapshot before any output. */
  private async attachSnapshot(
    signal: AbortSignal,
    terminalId: string,
    requestId: string,
    minBoundary: number,
  ): Promise<void> {
    if (!this.observationOr(terminalId, requestId) || signal.aborted || this.closed) return;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.snapshotBoundaryWaitMs);
    const projectionSignal = AbortSignal.any([signal, timeout.signal]);
    const result = await this.manager.awaitSnapshotProjection(terminalId, minBoundary, projectionSignal);
    clearTimeout(timer);
    if (signal.aborted || this.closed) return;
    if (result.status !== "projected") {
      this.sendError(requestId, terminalId, "invalid_sequence", "requested snapshot boundary is unavailable");
      return;
    }
    const { projection } = result;
    const subscriptionId = `sub-${randomUUID()}`;
    const lifecycle = lifecycleFromProjection(projection);
    const acked = this.sendGuarded(signal, TerminalSubscribedMessageSchema, {
      protocolVersion: PROTOCOL_VERSION,
      type: "terminal.subscribed",
      requestId,
      terminalId,
      subscriptionId,
      cursor: { sequence: projection.sequence },
      initialDelivery: "snapshot",
      lifecycle,
      capabilities: OBSERVE_ONLY_CAPABILITIES,
      capabilitiesRevision: CAPABILITIES_REVISION,
    });
    if (!acked) return;
    const snapshotSent = this.sendGuarded(signal, TerminalStreamMessageSchema, {
      protocolVersion: PROTOCOL_VERSION,
      type: "terminal.snapshot",
      terminalId,
      subscriptionId,
      boundary: {
        afterSequence: projection.sequence,
        nextSequence: projection.sequence + 1,
        parserState: "quiescent",
      },
      geometry: { columns: projection.columns, rows: projection.rows },
      restore: { format: "vt_restore_v1", encoding: "base64", data: projection.data },
      lifecycle,
    });
    if (!snapshotSent || projection.closure) return;

    const iterator = this.manager.observe(terminalId, projection.sequence, signal)[Symbol.asyncIterator]();
    try {
      await this.drain(signal, terminalId, subscriptionId, iterator, projection.sequence);
    } finally {
      await iterator.return?.(undefined);
    }
  }

  /** Resume from cursor N: replay/live after N, or resync_required when N is no longer retained. */
  private async attachResume(
    signal: AbortSignal,
    terminalId: string,
    requestId: string,
    afterSequence: number,
  ): Promise<void> {
    const observation = this.observationOr(terminalId, requestId);
    if (!observation || signal.aborted || this.closed) return;
    const disposition = this.manager.resumeDisposition(terminalId, afterSequence);
    if (disposition === "unavailable") {
      this.sendGuarded(signal, TerminalResyncRequiredMessageSchema, {
        protocolVersion: PROTOCOL_VERSION,
        type: "terminal.resync_required",
        terminalId,
        subscriptionId: `sub-${randomUUID()}`,
        requestedAfterSequence: afterSequence,
        availableFromSequence: observation.retainedFromSequence,
        reason: "replay_unavailable",
        lifecycle: lifecycleAtCursor(observation, observation.lastSequence),
      });
      return;
    }
    const subscriptionId = `sub-${randomUUID()}`;
    const iterator = this.manager.observe(terminalId, afterSequence, signal)[Symbol.asyncIterator]();
    try {
      const acked = this.sendGuarded(signal, TerminalSubscribedMessageSchema, {
        protocolVersion: PROTOCOL_VERSION,
        type: "terminal.subscribed",
        requestId,
        terminalId,
        subscriptionId,
        cursor: { sequence: afterSequence },
        initialDelivery: disposition,
        lifecycle: lifecycleAtCursor(observation, afterSequence),
        capabilities: OBSERVE_ONLY_CAPABILITIES,
        capabilitiesRevision: CAPABILITIES_REVISION,
      });
      if (!acked) return;
      await this.drain(signal, terminalId, subscriptionId, iterator, afterSequence);
    } finally {
      await iterator.return?.(undefined);
    }
  }

  /** Pump manager frames to the socket until end/abort, then repair an evicted closure if needed. */
  private async drain(
    signal: AbortSignal,
    terminalId: string,
    subscriptionId: string,
    iterator: AsyncIterator<TerminalFrame>,
    startSequence: number,
  ): Promise<void> {
    let lastForwarded = startSequence;
    let sawClosed = false;
    while (!this.closed && !signal.aborted) {
      const next = await iterator.next();
      if (signal.aborted || this.closed) break;
      if (next.done) break;
      const frame = next.value;
      if (frame.type === "closed") sawClosed = true;
      if (frame.type !== "snapshot") lastForwarded = frame.sequence;
      if (!this.forward(signal, terminalId, subscriptionId, frame)) break;
    }
    if (this.closed || signal.aborted || sawClosed) return;
    // Defensive backstop: deliver closure if a closed frame was never in this stream. The closed
    // frame is the newest frame and is not evicted while the snapshot predates it, so this normally
    // does not fire; it guarantees exactly-once closed if that invariant ever fails.
    const closure = this.manager.observation(terminalId).closure;
    if (closure && closure.sequence > lastForwarded) {
      this.sendGuarded(signal, TerminalStreamMessageSchema, {
        protocolVersion: PROTOCOL_VERSION,
        type: "terminal.closed",
        terminalId,
        subscriptionId,
        sequence: closure.sequence,
        reason: closure.reason,
        exitCode: closure.exitCode,
        signal: closure.signal,
        closedAt: closure.closedAt,
      });
    }
  }

  /** Translate one manager frame to its cf07 stream message and send it. Returns false if the connection stops. */
  private forward(
    signal: AbortSignal,
    terminalId: string,
    subscriptionId: string,
    frame: TerminalFrame,
  ): boolean {
    if (signal.aborted || this.closed) return false;
    let message: TerminalStreamMessage;
    switch (frame.type) {
      case "snapshot":
        message = {
          protocolVersion: PROTOCOL_VERSION,
          type: "terminal.snapshot",
          terminalId,
          subscriptionId,
          boundary: {
            afterSequence: frame.sequence,
            nextSequence: frame.sequence + 1,
            parserState: "quiescent",
          },
          geometry: { columns: frame.columns, rows: frame.rows },
          restore: { format: "vt_restore_v1", encoding: "base64", data: frame.data },
          // Derive the snapshot lifecycle from the authoritative manager state at this boundary.
          lifecycle: lifecycleAtCursor(this.manager.observation(terminalId), frame.sequence),
        };
        break;
      case "output":
        message = {
          protocolVersion: PROTOCOL_VERSION,
          type: "terminal.output",
          terminalId,
          subscriptionId,
          sequence: frame.sequence,
          encoding: "base64",
          data: frame.data,
        };
        break;
      case "resized":
        message = {
          protocolVersion: PROTOCOL_VERSION,
          type: "terminal.geometry",
          terminalId,
          subscriptionId,
          sequence: frame.sequence,
          geometry: { columns: frame.columns, rows: frame.rows },
          cause: "pty",
        };
        break;
      case "closed": {
        const closure = this.manager.observation(terminalId).closure;
        message = {
          protocolVersion: PROTOCOL_VERSION,
          type: "terminal.closed",
          terminalId,
          subscriptionId,
          sequence: frame.sequence,
          reason: closure?.reason ?? (frame.exitCode === null ? "terminated" : "exited"),
          exitCode: frame.exitCode,
          signal: null,
          closedAt: closure?.closedAt ?? new Date().toISOString(),
        };
        break;
      }
    }
    return this.sendGuarded(signal, TerminalStreamMessageSchema, message);
  }

  private sendGuarded<T>(
    signal: AbortSignal,
    schema: { parse: (value: unknown) => T },
    message: unknown,
  ): boolean {
    if (signal.aborted) return false;
    return this.rawSend(schema, message);
  }

  private rawSend<T>(schema: { parse: (value: unknown) => T }, message: unknown): boolean {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return false;
    const validated = schema.parse(message);
    const encoded = JSON.stringify(validated);
    if (this.ws.bufferedAmount + Buffer.byteLength(encoded) > this.maxOutboundBufferedBytes) {
      this.finalize("slow_consumer");
      return false;
    }
    this.ws.send(encoded);
    if (this.ws.bufferedAmount > this.maxOutboundBufferedBytes) {
      this.finalize("slow_consumer");
      return false;
    }
    return true;
  }

  private sendError(
    requestId: string | null,
    terminalId: string | null,
    code: TerminalErrorMessage["code"],
    message: string,
  ): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    const error = TerminalErrorMessageSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      type: "terminal.error",
      requestId,
      terminalId,
      code,
      message,
      retryable: false,
    });
    this.ws.send(JSON.stringify(error));
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function lifecycleFromProjection(projection: { closure: TerminalObservation["closure"] }): TerminalLifecycle {
  const closure = projection.closure;
  if (!closure) return { state: "open" };
  return {
    state: "closed",
    sequence: closure.sequence,
    reason: closure.reason,
    exitCode: closure.exitCode,
    signal: closure.signal,
    closedAt: closure.closedAt,
  };
}

function lifecycleAtCursor(observation: TerminalObservation, sequence: number): TerminalLifecycle {
  const closure = observation.closure;
  if (closure && sequence >= closure.sequence) {
    return {
      state: "closed",
      sequence: closure.sequence,
      reason: closure.reason,
      exitCode: closure.exitCode,
      signal: closure.signal,
      closedAt: closure.closedAt,
    };
  }
  return { state: "open" };
}
