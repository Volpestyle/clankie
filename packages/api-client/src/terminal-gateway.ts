import {
  TerminalClientMessageSchema,
  TerminalServerMessageSchema,
  classifyTerminalCapabilitiesRevision,
  classifyTerminalSequence,
  type TerminalClientAttribution,
  type TerminalDiscoverySession,
  type TerminalServerMessage,
  type TerminalSnapshotMessage,
  type TerminalSubscribedMessage,
} from "@clankie/terminal-protocol";

/**
 * Transport-neutral terminal host client for VUH-870.
 *
 * It carries the frozen VUH-867 terminal wire contract (pinned at
 * `cf07a66893992d35608068b0b70d1e1bb653ee10`) from a runner/relay gateway to an
 * app host shell, structurally usable as the app's `TerminalHostAdapter`. The
 * client owns strict cf07 validation, discovery/session mapping, resume/resync
 * ordering, capability revisions, duplicate/gap behavior, geometry-to-snapshot
 * recovery, and lifecycle-only closure convergence. Credentials, URL selection,
 * and abort wiring stay in the injected {@link TerminalJsonConnector}, so this
 * module imports no Node globals and is safe on React Native and browser-like
 * runtimes. This observe-only slice never sends input, resize, or lease frames.
 */

/** Effective client-visible capabilities. Observe-only: control paths stay false. */
export interface TerminalGatewayCapabilities {
  observe: true;
  control: boolean;
  input: boolean;
  resize: boolean;
}

/** A discovered terminal session, mapped from the wire discovery response. */
export interface TerminalGatewaySession {
  terminalId: string;
  label: string;
  source: "runner" | "herdr" | "mock";
  capabilities: TerminalGatewayCapabilities;
}

/** An observe request. `afterSequence` selects resume; its absence is a fresh observe. */
export interface TerminalGatewayObserveRequest {
  terminalId: string;
  afterSequence?: number;
  signal: AbortSignal;
}

/** A single app-facing stream event derived from validated wire frames. */
export type TerminalGatewayStreamEvent =
  | {
      type: "snapshot";
      snapshot: {
        terminalId: string;
        geometry: { columns: number; rows: number };
        boundary: { afterSequence: number; nextSequence: number };
        restoreBase64: string;
      };
    }
  | { type: "output"; frame: { terminalId: string; sequence: number; dataBase64: string } }
  | { type: "capabilities"; capabilities: TerminalGatewayCapabilities }
  | { type: "closed"; reason: string };

/**
 * A JSON message duplex over one transport connection. It carries already
 * JSON-decoded values; strict cf07 validation is owned by the client, not the
 * duplex. The connector binds `messages()` to the observe/list abort signal so
 * iteration ends on abort, and `close()` is idempotent.
 */
export interface TerminalJsonDuplex {
  send(message: unknown): void | Promise<void>;
  messages(): AsyncIterable<unknown>;
  close(): void | Promise<void>;
}

/** Establishes one fresh {@link TerminalJsonDuplex}. URL and credentials live here. */
export type TerminalJsonConnector = (signal: AbortSignal) => TerminalJsonDuplex | Promise<TerminalJsonDuplex>;

/** Construction options. Attribution comes from the authenticated host shell. */
export interface TerminalGatewayClientOptions {
  connect: TerminalJsonConnector;
  attribution: TerminalClientAttribution;
  /** Optional request-id source; defaults to an RN-safe monotonic counter. */
  newRequestId?: () => string;
}

export type TerminalGatewayClientErrorCode =
  | "malformed_server_message"
  | "unexpected_message"
  | "transport_closed"
  | "snapshot_required"
  | "resync_unavailable"
  | "gateway_error";

const STATIC_ERROR_MESSAGES: Record<TerminalGatewayClientErrorCode, string> = {
  malformed_server_message: "The terminal gateway sent a message that failed strict validation.",
  unexpected_message: "The terminal gateway sent a message that is invalid for the current stream state.",
  transport_closed: "The terminal gateway transport ended before the terminal closed.",
  snapshot_required: "The terminal gateway did not deliver the required snapshot before output.",
  resync_unavailable: "The terminal gateway could not resynchronize the stream.",
  gateway_error: "The terminal gateway reported an error.",
};

/**
 * A typed, static gateway-client error. Messages are fixed per code: they never
 * carry raw payloads, terminal bytes, titles, tokens, or exception content.
 */
export class TerminalGatewayClientError extends Error {
  public readonly code: TerminalGatewayClientErrorCode;

  public constructor(code: TerminalGatewayClientErrorCode) {
    super(STATIC_ERROR_MESSAGES[code]);
    this.name = "TerminalGatewayClientError";
    this.code = code;
  }
}

/** Internal sentinel: a deliberate abort tears down the duplex without failing the stream. */
class ObserveAborted {}

/** Bound on repeated resync-required responses before failing closed (never retry forever). */
const MAX_RESYNC_ATTEMPTS = 8;

export class TerminalGatewayClient {
  readonly #connect: TerminalJsonConnector;
  readonly #attribution: TerminalClientAttribution;
  readonly #newRequestId: () => string;

  public constructor(options: TerminalGatewayClientOptions) {
    this.#connect = options.connect;
    this.#attribution = options.attribution;
    this.#newRequestId = options.newRequestId ?? createRequestIdFactory();
  }

  /**
   * Deterministic discovery-only listing: connect, send one `terminal.discover`,
   * require the matching `terminal.discovery`, map sessions, and close.
   */
  public async listSessions(signal?: AbortSignal): Promise<TerminalGatewaySession[]> {
    const effectiveSignal = signal ?? new AbortController().signal;
    if (effectiveSignal.aborted) return [];
    const duplex = await this.#connect(effectiveSignal);
    try {
      const requestId = this.#newRequestId();
      await duplex.send(
        TerminalClientMessageSchema.parse({
          protocolVersion: 1,
          type: "terminal.discover",
          requestId,
          supportedProtocolVersions: [1],
          attribution: this.#attribution,
        }),
      );
      const inbound = duplex.messages()[Symbol.asyncIterator]();
      const result = await inbound.next();
      if (result.done) throw new TerminalGatewayClientError("transport_closed");
      const parsed = TerminalServerMessageSchema.safeParse(result.value);
      if (!parsed.success) throw new TerminalGatewayClientError("malformed_server_message");
      const message = parsed.data;
      if (message.type === "terminal.error") throw new TerminalGatewayClientError("gateway_error");
      if (message.type !== "terminal.discovery" || message.requestId !== requestId) {
        throw new TerminalGatewayClientError("unexpected_message");
      }
      // An observe-only client cannot proceed without the observe grant: reject a
      // correlated discovery whose granted scopes omit observe before mapping.
      if (!message.grantedScopes.includes("observe")) {
        throw new TerminalGatewayClientError("unexpected_message");
      }
      return message.sessions.map(mapSession);
    } finally {
      await safeClose(duplex);
    }
  }

  /**
   * Observe a terminal, yielding a capabilities baseline, snapshots, ordered
   * output, and exactly one close. Internal resync recovery is transparent.
   */
  public async *observe(request: TerminalGatewayObserveRequest): AsyncGenerator<TerminalGatewayStreamEvent> {
    if (request.signal.aborted) return;
    const duplex = await this.#connect(request.signal);
    try {
      yield* driveObserve(duplex, request, this.#attribution, this.#newRequestId);
    } catch (error) {
      if (error instanceof ObserveAborted) return;
      throw error;
    } finally {
      await safeClose(duplex);
    }
  }
}

async function* driveObserve(
  duplex: TerminalJsonDuplex,
  request: TerminalGatewayObserveRequest,
  attribution: TerminalClientAttribution,
  newRequestId: () => string,
): AsyncGenerator<TerminalGatewayStreamEvent> {
  const { terminalId, signal } = request;
  const inbound = duplex.messages()[Symbol.asyncIterator]();

  let subscriptionId: string | undefined;
  let expectedAckRequestId: string | undefined;
  let wireCursor = 0;
  let appliedRevision = 0; // revisions are positive; 0 means no baseline yet
  let closeEmitted = false;
  let pendingClose: { reason: string; sequence: number } | undefined;

  async function nextServerMessage(): Promise<TerminalServerMessage> {
    const result = await inbound.next();
    if (result.done) {
      if (signal.aborted) throw new ObserveAborted();
      throw new TerminalGatewayClientError("transport_closed");
    }
    const parsed = TerminalServerMessageSchema.safeParse(result.value);
    if (!parsed.success) throw new TerminalGatewayClientError("malformed_server_message");
    // A schema-valid terminal.error is a gateway failure in every phase — initial
    // subscribe, initial resume, resync ack, the required snapshot phase, and the
    // tail — so classify it once here rather than as a phase-specific surprise.
    if (parsed.data.type === "terminal.error") throw new TerminalGatewayClientError("gateway_error");
    return parsed.data;
  }

  async function send(message: unknown): Promise<void> {
    await duplex.send(TerminalClientMessageSchema.parse(message));
  }

  function requireStreamMatch(message: { terminalId: string; subscriptionId: string }): void {
    if (message.terminalId !== terminalId || message.subscriptionId !== subscriptionId) {
      throw new TerminalGatewayClientError("unexpected_message");
    }
  }

  // A resync-required notice must name the exact cursor the client resumed or
  // resynced from; a stale or mismatched cursor is rejected rather than acted on.
  function requireResyncNotice(
    notice: { terminalId: string; requestedAfterSequence: number },
    expectedCursor: number,
  ): void {
    if (notice.terminalId !== terminalId || notice.requestedAfterSequence !== expectedCursor) {
      throw new TerminalGatewayClientError("unexpected_message");
    }
  }

  function* applySubscribedAck(ack: TerminalSubscribedMessage): Generator<TerminalGatewayStreamEvent> {
    if (ack.terminalId !== terminalId || ack.requestId !== expectedAckRequestId) {
      throw new TerminalGatewayClientError("unexpected_message");
    }
    subscriptionId = ack.subscriptionId;
    const isFirstBaseline = appliedRevision === 0;
    if (
      isFirstBaseline ||
      classifyTerminalCapabilitiesRevision(appliedRevision, ack.capabilitiesRevision) === "apply"
    ) {
      appliedRevision = ack.capabilitiesRevision;
      yield { type: "capabilities", capabilities: observeOnlyCapabilities() };
    }
    if (ack.lifecycle.state === "closed") {
      pendingClose = { reason: ack.lifecycle.reason, sequence: ack.lifecycle.sequence };
    }
  }

  function* maybeEmitPendingClose(): Generator<TerminalGatewayStreamEvent> {
    if (closeEmitted || pendingClose === undefined) return;
    if (wireCursor >= pendingClose.sequence) {
      closeEmitted = true;
      yield { type: "closed", reason: pendingClose.reason };
    }
  }

  function* consumeSnapshotEvent(
    snapshot: TerminalSnapshotMessage,
    minAfterSequence?: number,
  ): Generator<TerminalGatewayStreamEvent> {
    requireStreamMatch(snapshot);
    if (minAfterSequence !== undefined && snapshot.boundary.afterSequence < minAfterSequence) {
      throw new TerminalGatewayClientError("unexpected_message");
    }
    wireCursor = snapshot.boundary.afterSequence;
    yield {
      type: "snapshot",
      snapshot: {
        terminalId: snapshot.terminalId,
        geometry: { columns: snapshot.geometry.columns, rows: snapshot.geometry.rows },
        boundary: {
          afterSequence: snapshot.boundary.afterSequence,
          nextSequence: snapshot.boundary.nextSequence,
        },
        restoreBase64: snapshot.restore.data,
      },
    };
    if (snapshot.lifecycle.state === "closed") {
      pendingClose = { reason: snapshot.lifecycle.reason, sequence: snapshot.lifecycle.sequence };
    }
    yield* maybeEmitPendingClose();
  }

  // Send resync from a cursor and consume the resulting subscribed(snapshot) +
  // snapshot. Internal recovery; a repeated resync_required is bounded so a
  // stale resume is never retried indefinitely.
  async function* recoverViaResync(
    cursorSequence: number,
    cause: "gap" | "manual" | "reconnect",
    minAfterSequence?: number,
  ): AsyncGenerator<TerminalGatewayStreamEvent> {
    for (let attempt = 0; attempt <= MAX_RESYNC_ATTEMPTS; attempt += 1) {
      const requestId = newRequestId();
      expectedAckRequestId = requestId;
      await send({
        protocolVersion: 1,
        type: "terminal.resync",
        requestId,
        terminalId,
        cursor: { sequence: cursorSequence },
        cause,
        attribution,
      });
      const message = await nextServerMessage();
      if (message.type === "terminal.subscribed") {
        if (message.initialDelivery !== "snapshot") {
          throw new TerminalGatewayClientError("unexpected_message");
        }
        yield* applySubscribedAck(message);
        const snapshot = await nextServerMessage();
        if (snapshot.type !== "terminal.snapshot") {
          throw new TerminalGatewayClientError("snapshot_required");
        }
        yield* consumeSnapshotEvent(snapshot, minAfterSequence);
        return;
      }
      if (message.type === "terminal.resync_required") {
        requireResyncNotice(message, cursorSequence);
        continue;
      }
      throw new TerminalGatewayClientError("unexpected_message");
    }
    throw new TerminalGatewayClientError("resync_unavailable");
  }

  // Initial attachment.
  if (request.afterSequence === undefined) {
    const requestId = newRequestId();
    expectedAckRequestId = requestId;
    await send({ protocolVersion: 1, type: "terminal.subscribe", requestId, terminalId, attribution });
    const ack = await nextServerMessage();
    if (ack.type !== "terminal.subscribed") throw new TerminalGatewayClientError("unexpected_message");
    if (ack.initialDelivery !== "snapshot") throw new TerminalGatewayClientError("unexpected_message");
    yield* applySubscribedAck(ack);
    const snapshot = await nextServerMessage();
    if (snapshot.type !== "terminal.snapshot") throw new TerminalGatewayClientError("snapshot_required");
    yield* consumeSnapshotEvent(snapshot);
  } else {
    const requestId = newRequestId();
    expectedAckRequestId = requestId;
    await send({
      protocolVersion: 1,
      type: "terminal.resume",
      requestId,
      terminalId,
      cursor: { sequence: request.afterSequence },
      attribution,
    });
    const first = await nextServerMessage();
    if (first.type === "terminal.subscribed") {
      yield* applySubscribedAck(first);
      if (first.initialDelivery === "snapshot") {
        const snapshot = await nextServerMessage();
        if (snapshot.type !== "terminal.snapshot") {
          throw new TerminalGatewayClientError("snapshot_required");
        }
        // Resume snapshot fence: a server-chosen snapshot must restore state at or
        // beyond the requested cursor N. A lower boundary regresses the app view to
        // a stale sequence, so require boundary.afterSequence >= N (same floor
        // mechanism as geometry resync).
        yield* consumeSnapshotEvent(snapshot, request.afterSequence);
      } else {
        // Retained replay/live must tail strictly after N: the acknowledged
        // cursor has to equal the requested resume cursor, or a lower cursor
        // re-yields applied frames and a higher cursor silently skips data.
        if (first.cursor.sequence !== request.afterSequence) {
          throw new TerminalGatewayClientError("unexpected_message");
        }
        wireCursor = first.cursor.sequence;
        yield* maybeEmitPendingClose();
      }
    } else if (first.type === "terminal.resync_required") {
      requireResyncNotice(first, request.afterSequence);
      yield* recoverViaResync(request.afterSequence, "reconnect");
    } else {
      throw new TerminalGatewayClientError("unexpected_message");
    }
  }

  // Tail.
  while (!closeEmitted) {
    const message = await nextServerMessage();
    switch (message.type) {
      case "terminal.output": {
        requireStreamMatch(message);
        const disposition = classifyTerminalSequence(wireCursor, message.sequence);
        if (disposition === "duplicate") break;
        if (disposition === "apply") {
          wireCursor = message.sequence;
          yield {
            type: "output",
            frame: { terminalId: message.terminalId, sequence: message.sequence, dataBase64: message.data },
          };
          yield* maybeEmitPendingClose();
          break;
        }
        yield* recoverViaResync(wireCursor, "gap");
        break;
      }
      case "terminal.geometry": {
        requireStreamMatch(message);
        if (message.sequence <= wireCursor) break;
        // Geometry is part of the wire cursor and cannot be applied incrementally:
        // pause without advancing the app cursor, resync from it, and require a
        // replacement snapshot whose boundary includes this geometry sequence.
        yield* recoverViaResync(wireCursor, "manual", message.sequence);
        break;
      }
      case "terminal.closed": {
        requireStreamMatch(message);
        const disposition = classifyTerminalSequence(wireCursor, message.sequence);
        if (disposition === "gap") {
          yield* recoverViaResync(wireCursor, "gap");
          break;
        }
        if (disposition === "apply") wireCursor = message.sequence;
        pendingClose = { reason: message.reason, sequence: message.sequence };
        yield* maybeEmitPendingClose();
        break;
      }
      case "terminal.capabilities_changed": {
        requireStreamMatch(message);
        if (classifyTerminalCapabilitiesRevision(appliedRevision, message.revision) === "apply") {
          appliedRevision = message.revision;
          yield { type: "capabilities", capabilities: observeOnlyCapabilities() };
        }
        break;
      }
      case "terminal.resync_required": {
        requireResyncNotice(message, wireCursor);
        yield* recoverViaResync(wireCursor, "reconnect");
        break;
      }
      default: {
        // terminal.error is already classified as gateway_error in nextServerMessage.
        throw new TerminalGatewayClientError("unexpected_message");
      }
    }
  }
}

function observeOnlyCapabilities(): TerminalGatewayCapabilities {
  return { observe: true, control: false, input: false, resize: false };
}

function mapSource(source: TerminalDiscoverySession["source"]): "runner" | "herdr" {
  return source === "herdr" ? "herdr" : "runner";
}

function mapSession(session: TerminalDiscoverySession): TerminalGatewaySession {
  return {
    terminalId: session.terminalId,
    label: session.title,
    source: mapSource(session.source),
    capabilities: observeOnlyCapabilities(),
  };
}

function createRequestIdFactory(): () => string {
  let counter = 0;
  return () => `tg-${(counter += 1)}`;
}

async function safeClose(duplex: TerminalJsonDuplex): Promise<void> {
  try {
    await duplex.close();
  } catch {
    // Transport teardown failures must not mask the stream result.
  }
}
