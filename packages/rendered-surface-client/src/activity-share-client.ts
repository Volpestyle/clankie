import {
  ACTIVITY_SHARE_MAX_BUFFERED_BYTES,
  type ActivityShareAudio,
  type ActivityShareFrame,
  type ActivityShareGrant,
  ActivityShareGrantSchema,
  type ActivityShareOverlay,
  type ActivityShareProducerMessage,
  ActivityShareScopeSchema,
  type ActivityShareSession,
  ActivityShareSessionSchema,
  type ActivityShareSource,
  ActivityShareSourceSchema,
  ActivityShareStartResultSchema,
  type ActivityShareStatus,
} from "@clankie/interactive-environment";
import { WebSocket } from "ws";
import type { ActivityFrameSocket } from "./activity-frame-sink.ts";

// Client frames include masking and length fields: reserve the maximum 14-byte header.
const MAX_CLIENT_FRAME_HEADER_BYTES = 14;

export interface ActivityShareSink {
  publishFrame(frame: ActivityShareFrame): void;
  publishAudio(audio: ActivityShareAudio): void;
  publishOverlay(overlay: ActivityShareOverlay): void;
  publishStatus(status: ActivityShareStatus): void;
  readonly connected: boolean;
  readonly droppedFrameCount: number;
  readonly droppedAudioPacketCount: number;
  /** Every dropped envelope, including bounded overlay and status updates. */
  readonly droppedMessageCount: number;
  close(): void;
}

export interface ActivityShareSinkOptions {
  url: string;
  token: string;
  session: ActivityShareSession;
  maxBufferedBytes?: number;
  connect?: (url: string, token: string) => ActivityFrameSocket;
  onClosed?: () => void;
}

/**
 * A generation owns one producer connection. Its loss ends that generation;
 * reconnecting automatically could resurrect stopped or replaced media.
 */
export function createActivityShareSink(options: ActivityShareSinkOptions): ActivityShareSink {
  const session = ActivityShareSessionSchema.parse(options.session);
  const maxBufferedBytes = checkedBufferLimit(options.maxBufferedBytes);
  const socket = (options.connect ?? defaultConnect)(options.url, options.token);
  let closed = false;
  let droppedFrames = 0;
  let droppedAudioPackets = 0;
  let droppedMessages = 0;
  const ended = (): void => {
    if (closed) return;
    closed = true;
    options.onClosed?.();
  };
  socket.on("close", () => {
    ended();
  });
  socket.on("error", () => {
    ended();
    socket.close();
  });

  const send = (message: ActivityShareProducerMessage): void => {
    const dropped = (): void => {
      droppedMessages += 1;
      if (message.kind === "frame") droppedFrames += 1;
      if (message.kind === "audio") droppedAudioPackets += 1;
    };
    if (closed || socket.readyState !== WebSocket.OPEN) {
      dropped();
      return;
    }
    const payload = JSON.stringify(message);
    if (
      (socket.bufferedAmount ?? 0) + Buffer.byteLength(payload) + MAX_CLIENT_FRAME_HEADER_BYTES >
      maxBufferedBytes
    ) {
      dropped();
      return;
    }
    try {
      socket.send(payload);
    } catch {
      dropped();
    }
  };
  const fence = { shareId: session.shareId, generation: session.generation };
  return {
    publishFrame(frame) {
      send({ kind: "frame", ...fence, frame });
    },
    publishAudio(audio) {
      send({ kind: "audio", ...fence, audio });
    },
    publishOverlay(overlay) {
      send({ kind: "overlay", ...fence, overlay });
    },
    publishStatus(status) {
      send({ kind: "status", ...fence, status });
    },
    get connected() {
      return !closed && socket.readyState === WebSocket.OPEN;
    },
    get droppedFrameCount() {
      return droppedFrames;
    },
    get droppedAudioPacketCount() {
      return droppedAudioPackets;
    },
    get droppedMessageCount() {
      return droppedMessages;
    },
    close() {
      if (closed) return;
      ended();
      socket.close();
    },
  };
}

export interface ActivityShareClientOptions {
  /** Private loopback management listener; never the public viewer origin. */
  url: string;
  token: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  /** Bounds retained producer capabilities, including shares not yet attached. */
  maxCachedShares?: number;
}

export interface ActivityShareClient {
  start(input: {
    scope: ActivityShareSession["scope"];
    source: ActivityShareSource;
    ttlMs?: number;
  }): Promise<ActivityShareSession>;
  switchSource(session: ActivityShareSession, source: ActivityShareSource): Promise<ActivityShareSession>;
  stop(session: ActivityShareSession): Promise<void>;
  grant(session: ActivityShareSession, ttlMs?: number): Promise<ActivityShareGrant>;
  status(): Promise<ActivityShareSession[]>;
  /** Only a session returned by this client's start/switch can publish. */
  sink(session: ActivityShareSession): ActivityShareSink;
  close(): void;
}

type Operation = "start" | "switch" | "stop" | "grant" | "status";

/** Failed effects are never retried automatically, including a lost response. */
export class ActivityShareRequestError extends Error {
  override readonly name = "ActivityShareRequestError";
  readonly operation: Operation;
  readonly outcome: "refused" | "uncertain";
  readonly shareId: string | undefined;
  readonly generation: number | undefined;
  constructor(
    message: string,
    operation: Operation,
    outcome: "refused" | "uncertain",
    shareId?: string,
    generation?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.operation = operation;
    this.outcome = outcome;
    this.shareId = shareId;
    this.generation = generation;
  }
}

export function createActivityShareClient(options: ActivityShareClientOptions): ActivityShareClient {
  const base = privateBaseUrl(options.url);
  const requestFetch = options.fetch ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Activity share request timeout must be a positive integer");
  }
  const maxCachedShares = options.maxCachedShares ?? 128;
  if (!Number.isSafeInteger(maxCachedShares) || maxCachedShares <= 0 || maxCachedShares > 128) {
    throw new RangeError("Activity share capability cache limit must be between 1 and 128");
  }
  let closed = false;
  let pendingCapabilities = 0;
  const mutations = new Set<string>();
  const records = new Map<
    string,
    { session: ActivityShareSession; producerToken: string; sink?: ActivityShareSink }
  >();

  const ensureOpen = (operation: Operation, session?: ActivityShareSession): void => {
    if (closed) {
      throw new ActivityShareRequestError(
        "Activity share client is closed; request was not dispatched",
        operation,
        "refused",
        session?.shareId,
        session?.generation,
      );
    }
  };

  const request = async (
    operation: Operation,
    path: string,
    body?: unknown,
    session?: ActivityShareSession,
  ): Promise<unknown> => {
    ensureOpen(operation, session);
    let response: Response;
    try {
      response = await requestFetch(new URL(path, base), {
        method: operation === "status" ? "GET" : "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
    } catch (cause) {
      throw new ActivityShareRequestError(
        "Activity share response was lost; do not replay the request",
        operation,
        "uncertain",
        session?.shareId,
        session?.generation,
        { cause },
      );
    }
    if (!response.ok) {
      throw new ActivityShareRequestError(
        `Activity share ${operation} returned HTTP ${response.status}`,
        operation,
        response.status >= 500 ? "uncertain" : "refused",
        session?.shareId,
        session?.generation,
      );
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new ActivityShareRequestError(
        "Activity share returned an unreadable response; do not replay the request",
        operation,
        "uncertain",
        session?.shareId,
        session?.generation,
        { cause },
      );
    }
  };

  const parseResponse = <T>(
    parse: (value: unknown) => T,
    value: unknown,
    operation: Operation,
    session?: ActivityShareSession,
  ): T => {
    try {
      return parse(value);
    } catch (cause) {
      throw new ActivityShareRequestError(
        "Activity share returned an invalid response; do not replay the request",
        operation,
        "uncertain",
        session?.shareId,
        session?.generation,
        { cause },
      );
    }
  };
  const prune = (): void => {
    for (const [id, record] of records) {
      if (Date.parse(record.session.expiresAt) <= Date.now()) {
        record.sink?.close();
        records.delete(id);
      }
    }
  };
  const remember = (
    value: unknown,
    operation: "start" | "switch",
    expected: Pick<ActivityShareSession, "scope" | "source">,
    previous?: ActivityShareSession,
  ) => {
    const result = parseResponse(
      (response) => {
        const parsed = ActivityShareStartResultSchema.parse(response);
        if (
          JSON.stringify(parsed.session.scope) !== JSON.stringify(expected.scope) ||
          JSON.stringify(parsed.session.source) !== JSON.stringify(expected.source) ||
          (previous !== undefined &&
            (parsed.session.shareId !== previous.shareId ||
              parsed.session.generation !== previous.generation + 1))
        ) {
          throw new Error("Activity share response does not match the requested scope and generation");
        }
        return parsed;
      },
      value,
      operation,
      previous,
    );
    const current = records.get(result.session.shareId);
    if (closed || (current !== undefined && current.session.generation > result.session.generation)) {
      throw new ActivityShareRequestError(
        "Activity share response arrived after this client closed or replaced the generation; do not replay",
        operation,
        "uncertain",
        result.session.shareId,
        result.session.generation,
      );
    }
    prune();
    records.get(result.session.shareId)?.sink?.close();
    records.set(result.session.shareId, structuredClone(result));
    return structuredClone(result.session);
  };
  const fence = (session: ActivityShareSession): ActivityShareSession =>
    ActivityShareSessionSchema.parse(session);
  const invalidate = (session: ActivityShareSession): void => {
    const record = records.get(session.shareId);
    if (record?.session.generation === session.generation) {
      record.sink?.close();
      records.delete(session.shareId);
    }
  };

  const reserveCapability = (operation: "start" | "switch", session?: ActivityShareSession): (() => void) => {
    prune();
    if (session !== undefined && records.has(session.shareId)) return () => undefined;
    if (records.size + pendingCapabilities >= maxCachedShares) {
      throw new ActivityShareRequestError(
        "Activity share capability cache is full; request was not dispatched",
        operation,
        "refused",
        session?.shareId,
        session?.generation,
      );
    }
    pendingCapabilities += 1;
    return () => {
      pendingCapabilities -= 1;
    };
  };
  const beginMutation = (operation: "switch" | "stop", session: ActivityShareSession): (() => void) => {
    ensureOpen(operation, session);
    if (mutations.has(session.shareId) || mutations.size >= maxCachedShares) {
      throw new ActivityShareRequestError(
        "An Activity share mutation is already in flight; request was not dispatched",
        operation,
        "refused",
        session.shareId,
        session.generation,
      );
    }
    mutations.add(session.shareId);
    return () => mutations.delete(session.shareId);
  };

  return {
    async start(input) {
      ensureOpen("start");
      const body = {
        scope: ActivityShareScopeSchema.parse(input.scope),
        source: ActivityShareSourceSchema.parse(input.source),
        ...optionalTtl(input.ttlMs),
      };
      const release = reserveCapability("start");
      try {
        return remember(await request("start", "/shares", body), "start", body);
      } finally {
        release();
      }
    },
    async switchSource(inputSession, inputSource) {
      const session = fence(inputSession);
      const source = ActivityShareSourceSchema.parse(inputSource);
      const finish = beginMutation("switch", session);
      let release: (() => void) | undefined;
      try {
        release = reserveCapability("switch", session);
        const result = await request(
          "switch",
          `/shares/${session.shareId}/switch`,
          { generation: session.generation, source },
          session,
        );
        return remember(result, "switch", { scope: session.scope, source }, session);
      } catch (error) {
        invalidate(session);
        throw error;
      } finally {
        release?.();
        finish();
      }
    },
    async stop(inputSession) {
      const session = fence(inputSession);
      const finish = beginMutation("stop", session);
      try {
        const result = await request(
          "stop",
          `/shares/${session.shareId}/stop`,
          { generation: session.generation },
          session,
        );
        parseResponse(
          (value) => {
            if (
              typeof value !== "object" ||
              value === null ||
              !Object.hasOwn(value, "stopped") ||
              (value as { stopped: unknown }).stopped !== true ||
              Object.keys(value).length !== 1
            ) {
              throw new Error("Invalid stopped response");
            }
          },
          result,
          "stop",
          session,
        );
      } finally {
        invalidate(session);
        finish();
      }
    },
    async grant(inputSession, ttlMs) {
      const session = fence(inputSession);
      return parseResponse(
        ActivityShareGrantSchema.parse,
        await request(
          "grant",
          `/shares/${session.shareId}/grant`,
          { generation: session.generation, ...optionalTtl(ttlMs) },
          session,
        ),
        "grant",
        session,
      );
    },
    async status() {
      prune();
      const sessions = parseResponse(
        (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            !Object.hasOwn(value, "sessions") ||
            Object.keys(value).length !== 1
          ) {
            throw new Error("Invalid sessions response");
          }
          return ActivityShareSessionSchema.array().parse((value as { sessions: unknown }).sessions);
        },
        await request("status", "/shares"),
        "status",
      );
      // Reconcile stale, never-attached capabilities after a server-side stop
      // without evicting an operation whose response is still in flight.
      const live = new Map(sessions.map((session) => [session.shareId, session.generation]));
      for (const record of records.values()) {
        if (
          !mutations.has(record.session.shareId) &&
          live.get(record.session.shareId) !== record.session.generation
        ) {
          invalidate(record.session);
        }
      }
      return sessions;
    },
    sink(inputSession) {
      ensureOpen("start", inputSession);
      prune();
      const session = fence(inputSession);
      const record = records.get(session.shareId);
      if (record === undefined || JSON.stringify(record.session) !== JSON.stringify(session)) {
        throw new Error("Activity share session is foreign, expired, or replaced");
      }
      if (record.sink !== undefined) return record.sink;
      const producerUrl = new URL(`/shares/${session.shareId}/producer`, base);
      producerUrl.protocol = "ws:";
      record.sink = createActivityShareSink({
        session,
        url: producerUrl.href,
        token: record.producerToken,
        onClosed() {
          if (records.get(session.shareId)?.session.generation === session.generation) {
            records.delete(session.shareId);
          }
        },
      });
      return record.sink;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const record of records.values()) record.sink?.close();
      records.clear();
    },
  };
}

function optionalTtl(ttlMs: number | undefined): { ttlMs?: number } {
  if (ttlMs === undefined) return {};
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError("Activity share TTL must be a positive integer");
  }
  return { ttlMs };
}

function checkedBufferLimit(value: number | undefined): number {
  const limit = value ?? ACTIVITY_SHARE_MAX_BUFFERED_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > ACTIVITY_SHARE_MAX_BUFFERED_BYTES) {
    throw new RangeError("Activity share buffer limit exceeds its bounded transport budget");
  }
  return limit;
}

function privateBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    throw new Error("Activity share management must use a private loopback HTTP origin");
  }
  return url;
}

function defaultConnect(url: string, token: string): ActivityFrameSocket {
  return new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
}
