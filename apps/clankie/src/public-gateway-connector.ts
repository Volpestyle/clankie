import { isMachineJoinTransportRoute } from "@clankie/protocol/machine-join";
import { DISCORD_INGRESS_PATH } from "@clankie/protocol/discord-ingress";
import { HOSTED_OPERATOR_PATH } from "@clankie/protocol/hosted-operator";
import { HOSTED_SUPPORT_PATH } from "@clankie/protocol/support-access";
import { HostedDiscordEnvelopeSchema } from "@clankie/protocol/hosted-discord";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_IN_FLIGHT_MAX,
  PUBLIC_GATEWAY_REQUEST_HEADER_ALLOWLIST,
  PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX,
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PUBLIC_GATEWAY_STREAMS_HEADER,
  PUBLIC_GATEWAY_STREAMS_MAX,
  PublicGatewayHostIdSchema,
  PublicGatewayInstallationIdSchema,
  PublicGatewayTunnelFrameSchema,
  publicGatewayTargetFor,
  type PublicGatewayDoorwayState,
  type PublicGatewayPairingRouteFrame,
  type PublicGatewayRequestFrame,
  type PublicGatewayStreamOpenFrame,
  type PublicGatewayTunnelFrame,
  type PublicGatewayRoute,
} from "@clankie/protocol/public-gateway";
import type { PublicGatewayPushWakeFrame } from "@clankie/protocol";
import { WebSocket, type RawData } from "ws";
import {
  GATEWAY_STREAM_RECORD_BINARY,
  GATEWAY_STREAM_RECORD_BYTES_MAX,
  GATEWAY_STREAM_RECORD_START,
  GATEWAY_STREAM_RECORD_TEXT,
} from "@clankie/protocol/gateway-encryption";
import { VOICE_CALL_PATH } from "@clankie/protocol";
import { GatewayEncryptionHost, type GatewayStream } from "./gateway-encryption.ts";
import { validateRuntimeGatewayRoutes } from "./runtime-provider.ts";
import { pairingOfferWire, type StoredPairingOffer } from "./pairing.ts";
import type { PairingOfferWire } from "@clankie/protocol";
import { hashPairingCode, hashPairingSecret } from "./pairing.ts";
import type { PushWakeRequest, PushWakeStatus } from "./push.ts";

/** Set on every request this connector forwards to the local service. */
const GATEWAY_FORWARDED_HEADER = "x-clankie-gateway";

const CONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;
const RESPONSE_BYTES_MAX = 32 * 1024 * 1024;
const WEBSOCKET_PAYLOAD_BYTES_MAX = 4 * 1024 * 1024;
const REQUEST_HEADER_ALLOWLIST = new Set(PUBLIC_GATEWAY_REQUEST_HEADER_ALLOWLIST);
const RESPONSE_HEADER_ALLOWLIST = new Set(["cache-control", "content-type", "retry-after"]);

export interface PublicGatewayConnectorLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface PublicGatewayConnectorOptions {
  readonly gatewayUrl: string;
  readonly hostId: string;
  readonly hostToken?: string;
  readonly encryptionKey?: Uint8Array;
  /** Work classification only; decrypted request content stays inside the public body. */
  readonly onAuthenticatedRequest?: (isWork: boolean) => void;
  readonly gatewayRoutes?: readonly PublicGatewayRoute[];
  /** Managed bodies stop after a forbidden host upgrade as well as a failed renewal. */
  readonly onHostRejected?: () => void;
  readonly installationId?: string;
  readonly resolveHostToken?: () => Promise<{
    readonly token: string;
    readonly expiresAt: number;
    readonly refreshAt?: number;
  }>;
  /** Names the token failures no reconnect can clear; the doorway parks instead of looping. */
  readonly tokenErrorIsTerminal?: (error: unknown) => boolean;
  readonly controlPlaneUrl: string;
  readonly relayUrl: string;
  readonly logger?: PublicGatewayConnectorLogger;
  readonly fetch?: typeof globalThis.fetch;
  readonly reconnectMinimumMs?: number;
  readonly reconnectMaximumMs?: number;
  /** Each doorway transition, for the hosted body's telemetry. Metadata only. */
  readonly onDoorwayChange?: (change: PublicGatewayDoorwayChange) => void;
}

export type PublicGatewayDoorwayChange =
  | { readonly state: "connected" | "sign_in_required" }
  | { readonly state: "disconnected"; readonly retryInMs: number; readonly closeCode?: number };

export interface PublicGatewayPairingOffer {
  readonly offerSecret: string;
  readonly code: string;
  readonly expiresAt: string;
}

/** A route as the gateway keys it: hashes only. */
export interface PublicGatewayPairingRoute {
  readonly offerHash: string;
  readonly codeHash: string;
  readonly expiresAt: string;
}

/**
 * A device's sealed stream (VUH-2761), carried to the relay's call route over
 * loopback. `up` and `down` are the next record sequence each way.
 */
interface LocalStream {
  readonly id: string;
  readonly abort: AbortController;
  stream?: GatewayStream;
  relay?: WebSocket;
  started: boolean;
  up: number;
  down: number;
}

/** Sealed records hold the kind byte and the AES-GCM IV and tag beside the payload. */
const STREAM_PAYLOAD_BYTES_MAX = GATEWAY_STREAM_RECORD_BYTES_MAX - 29;

interface ConnectionWaiter {
  readonly resolve: (socket: WebSocket) => void;
  readonly reject: (error: Error) => void;
  readonly deadline: ReturnType<typeof setTimeout>;
}

interface PairingRouteWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly deadline: ReturnType<typeof setTimeout>;
}

/**
 * A wake never fails a caller: an unanswered, disconnected, or unconfigured
 * gateway resolves `unavailable`, because a device that missed a notification
 * catches up the moment it opens the thread.
 */
interface PushWakeWaiter {
  readonly settle: (status: PushWakeStatus) => void;
  readonly deadline: ReturnType<typeof setTimeout>;
}

const silentLogger: PublicGatewayConnectorLogger = { info: () => undefined, warn: () => undefined };

export class PublicGatewayConnector {
  public readonly hostBaseUrl: string;

  private readonly connectUrl: string;
  private readonly encryption: GatewayEncryptionHost | undefined;
  private readonly gatewayRoutes: readonly PublicGatewayRoute[];
  private readonly hostId: string;
  private readonly hostToken: string | undefined;
  private readonly resolveHostToken:
    | (() => Promise<{ readonly token: string; readonly expiresAt: number; readonly refreshAt?: number }>)
    | undefined;
  private readonly controlPlaneUrl: string;
  private readonly relayUrl: string;
  private readonly logger: PublicGatewayConnectorLogger;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly tokenErrorIsTerminal: (error: unknown) => boolean;
  private readonly reconnectMinimumMs: number;
  private readonly reconnectMaximumMs: number;
  private readonly onDoorwayChange: ((change: PublicGatewayDoorwayChange) => void) | undefined;
  private readonly onHostRejected: (() => void) | undefined;
  private lastCloseCode: number | undefined;
  private readonly pairingRoutes = new Map<string, PublicGatewayPairingRouteFrame>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly streams = new Map<string, LocalStream>();
  /** A credential refresh that waits for open calls to end; the gateway's own expiry still binds. */
  private refreshWhenIdle: WebSocket | undefined;
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private readonly pairingRouteWaiters = new Map<string, PairingRouteWaiter>();
  private readonly pushWakeWaiters = new Map<string, PushWakeWaiter>();
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs: number;
  private signInRequiredSince: string | undefined;
  private connecting = false;
  private started = false;

  public constructor(options: PublicGatewayConnectorOptions) {
    this.gatewayRoutes = validateRuntimeGatewayRoutes(options.gatewayRoutes);
    const gatewayOrigin = requireHttpOrigin(options.gatewayUrl, "Gateway URL");
    this.hostId = PublicGatewayHostIdSchema.parse(options.hostId);
    this.encryption =
      options.encryptionKey === undefined
        ? undefined
        : new GatewayEncryptionHost(
            this.hostId,
            options.encryptionKey,
            options.onAuthenticatedRequest,
            this.gatewayRoutes,
          );
    if ((options.hostToken === undefined) === (options.resolveHostToken === undefined)) {
      throw new Error("Configure one static or renewable gateway host token source");
    }
    if (options.hostToken !== undefined && options.hostToken.length < 32) {
      throw new Error("Gateway host token must contain at least 32 characters");
    }
    if ((options.installationId === undefined) !== (options.resolveHostToken === undefined)) {
      throw new Error("Renewable gateway credentials require an installation id");
    }
    this.hostToken = options.hostToken;
    this.resolveHostToken = options.resolveHostToken;
    this.tokenErrorIsTerminal = options.tokenErrorIsTerminal ?? (() => false);
    this.controlPlaneUrl = requireHttpOrigin(options.controlPlaneUrl, "Control-plane URL");
    this.relayUrl = requireHttpOrigin(options.relayUrl, "Relay URL");
    this.logger = options.logger ?? silentLogger;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.reconnectMinimumMs = options.reconnectMinimumMs ?? RECONNECT_MIN_MS;
    this.reconnectMaximumMs = options.reconnectMaximumMs ?? RECONNECT_MAX_MS;
    this.onDoorwayChange = options.onDoorwayChange;
    this.onHostRejected = options.onHostRejected;
    this.reconnectDelayMs = this.reconnectMinimumMs;
    this.hostBaseUrl = new URL(`/h/${this.hostId}`, gatewayOrigin).toString().replace(/\/$/u, "");
    const connect = new URL(PUBLIC_GATEWAY_HOST_CONNECT_PATH, gatewayOrigin);
    connect.protocol = connect.protocol === "https:" ? "wss:" : "ws:";
    connect.searchParams.set("hostId", this.hostId);
    if (options.installationId !== undefined) {
      connect.searchParams.set(
        "installationId",
        PublicGatewayInstallationIdSchema.parse(options.installationId),
      );
    }
    this.connectUrl = connect.toString();
  }

  public protectPairingOffer(offer: StoredPairingOffer): PairingOfferWire {
    if (this.encryption === undefined) throw new Error("Gateway encryption is unavailable");
    const credential = this.encryption.pairingCredential(offer);
    const wire = pairingOfferWire(offer);
    const fragment = new URLSearchParams(credential).toString();
    const deepLink = `${wire.deepLink}#${fragment}`;
    return { ...wire, deepLink, code: deepLink, gateway: true };
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /** What the doorway is doing right now, for `/health` and the cards that read it. */
  public get doorway(): PublicGatewayDoorwayState {
    if (this.signInRequiredSince !== undefined) {
      return { state: "sign_in_required", since: this.signInRequiredSince };
    }
    return this.socket?.readyState === WebSocket.OPEN ? { state: "connected" } : { state: "connecting" };
  }

  /**
   * Re-register a route rebuilt from the durable log (ADR 0154). No socket is
   * needed: `replayPairingRoutes` sends the map on every (re)connect.
   */
  public restorePairingRoute(route: PublicGatewayPairingRoute): void {
    this.pairingRoutes.set(route.offerHash, pairingRouteFrame(route));
  }

  public async publishPairingOffer(offer: PublicGatewayPairingOffer): Promise<void> {
    const frame = pairingRouteFrame({
      offerHash: hashPairingSecret(offer.offerSecret),
      codeHash: hashPairingCode(offer.code),
      expiresAt: offer.expiresAt,
    });
    const socket = await this.connectedSocket();
    this.pairingRoutes.set(frame.offerHash, frame);
    const ready = new Promise<void>((resolve, reject) => {
      const waiter: PairingRouteWaiter = {
        resolve,
        reject,
        deadline: setTimeout(() => {
          this.pairingRouteWaiters.delete(frame.offerHash);
          reject(new Error("Public gateway did not acknowledge the pairing route"));
        }, CONNECT_TIMEOUT_MS),
      };
      waiter.deadline.unref();
      this.pairingRouteWaiters.set(frame.offerHash, waiter);
    });
    try {
      await sendFrame(socket, frame);
      await ready;
    } catch (error) {
      this.pairingRoutes.delete(frame.offerHash);
      const waiter = this.pairingRouteWaiters.get(frame.offerHash);
      if (waiter !== undefined) clearTimeout(waiter.deadline);
      this.pairingRouteWaiters.delete(frame.offerHash);
      throw error;
    }
  }

  /**
   * Ask the gateway to wake one device about one conversation. The frame names
   * ids and the registration version only; the gateway supplies host identity
   * from this authenticated socket, and holds the token.
   */
  public async sendPushWake(request: PushWakeRequest): Promise<PushWakeStatus> {
    const frame: PublicGatewayPushWakeFrame = {
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "push_wake",
      wakeId: request.wakeId,
      deviceId: request.deviceId,
      conversationId: request.conversationId,
      registrationId: request.registrationId,
      sequence: request.sequence,
    };
    let socket: WebSocket;
    try {
      socket = await this.connectedSocket();
    } catch {
      return "unavailable";
    }
    const answered = new Promise<PushWakeStatus>((resolve) => {
      const waiter: PushWakeWaiter = {
        settle: resolve,
        deadline: setTimeout(() => {
          this.pushWakeWaiters.delete(frame.wakeId);
          resolve("unavailable");
        }, CONNECT_TIMEOUT_MS),
      };
      waiter.deadline.unref();
      this.pushWakeWaiters.set(frame.wakeId, waiter);
    });
    try {
      await sendFrame(socket, frame);
    } catch {
      this.settlePushWake(frame.wakeId, "unavailable");
      return "unavailable";
    }
    return await answered;
  }

  public close(): void {
    if (!this.started) return;
    this.started = false;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.tokenRefreshTimer !== undefined) clearTimeout(this.tokenRefreshTimer);
    this.reconnectTimer = undefined;
    this.tokenRefreshTimer = undefined;
    for (const controller of this.inFlight.values()) controller.abort("gateway connector closed");
    this.inFlight.clear();
    this.closeAllStreams();
    this.socket?.close(1001, "connector shutting down");
    this.socket = undefined;
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.deadline);
      waiter.reject(new Error("Gateway connector closed"));
    }
    this.connectionWaiters.clear();
    this.rejectPairingRouteWaiters("Gateway connector closed");
    this.settleAllPushWakes("unavailable");
  }

  private connect(): void {
    if (
      !this.started ||
      this.socket !== undefined ||
      this.connecting ||
      this.signInRequiredSince !== undefined
    )
      return;
    this.connecting = true;
    void this.openSocket().finally(() => {
      this.connecting = false;
    });
  }

  private async openSocket(): Promise<void> {
    let credential: { readonly token: string; readonly expiresAt?: number; readonly refreshAt?: number };
    try {
      credential =
        this.resolveHostToken === undefined ? { token: this.hostToken ?? "" } : await this.resolveHostToken();
    } catch (error) {
      if (!this.started) return;
      if (this.tokenErrorIsTerminal(error)) {
        // A rejected account credential outlives every retry, so the loop stops
        // here and says so once. `clankie gateway status` and `doctor` read it.
        this.signInRequiredSince ??= new Date().toISOString();
        this.logger.warn(
          { hostId: this.hostId, error: errorName(error), ...errorCode(error) },
          "public gateway needs this Mac signed in again",
        );
        this.onDoorwayChange?.({ state: "sign_in_required" });
        return;
      }
      this.logger.warn(
        { hostId: this.hostId, error: errorName(error), ...errorCode(error) },
        "public gateway credential refresh failed",
      );
      this.scheduleReconnect();
      return;
    }
    if (!this.started || this.socket !== undefined) return;
    const socket = new WebSocket(this.connectUrl, {
      headers: {
        authorization: `Bearer ${credential.token}`,
        // Only a Mac that can open a device's envelope carries its calls.
        ...(this.encryption === undefined ? {} : { [PUBLIC_GATEWAY_STREAMS_HEADER]: "1" }),
      },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: WEBSOCKET_PAYLOAD_BYTES_MAX,
    });
    this.socket = socket;
    if (this.onHostRejected !== undefined)
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        if (response.statusCode === 403) {
          this.signInRequiredSince ??= new Date().toISOString();
          this.close();
          this.onHostRejected?.();
          this.onDoorwayChange?.({ state: "sign_in_required" });
        } else socket.terminate();
      });
    socket.once("open", () => {
      if (this.socket !== socket) return;
      this.reconnectDelayMs = this.reconnectMinimumMs;
      this.signInRequiredSince = undefined;
      for (const waiter of this.connectionWaiters) {
        clearTimeout(waiter.deadline);
        waiter.resolve(socket);
      }
      this.connectionWaiters.clear();
      if (credential.expiresAt !== undefined) {
        const refreshInMs = Math.max(
          0,
          (credential.refreshAt ?? credential.expiresAt - TOKEN_REFRESH_WINDOW_MS) - Date.now(),
        );
        this.tokenRefreshTimer = setTimeout(() => {
          this.tokenRefreshTimer = undefined;
          if (this.socket !== socket) return;
          // Reconnecting would drop a call on this socket; refresh once the calls end.
          if (this.streams.size > 0) this.refreshWhenIdle = socket;
          else socket.close(4000, "refreshing host credential");
        }, refreshInMs);
        this.tokenRefreshTimer.unref();
      }
      void this.replayPairingRoutes(socket);
      this.logger.info({ hostId: this.hostId }, "public gateway connected");
      this.onDoorwayChange?.({ state: "connected" });
    });
    socket.on("message", (data, isBinary) => this.handleMessage(socket, data, isBinary));
    socket.once("error", (error) => {
      this.logger.warn({ hostId: this.hostId, error: error.name }, "public gateway connection error");
    });
    socket.once("close", (code) => {
      if (this.socket === socket) this.lastCloseCode = code;
      this.disconnected(socket);
    });
  }

  private disconnected(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    if (this.tokenRefreshTimer !== undefined) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = undefined;
    for (const controller of this.inFlight.values()) controller.abort("public gateway disconnected");
    this.inFlight.clear();
    this.closeAllStreams();
    this.refreshWhenIdle = undefined;
    this.rejectPairingRouteWaiters("Public gateway disconnected before acknowledging the pairing route");
    this.settleAllPushWakes("unavailable");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== undefined) return;
    const delayMs = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaximumMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref();
    this.logger.warn({ hostId: this.hostId, reconnectInMs: delayMs }, "public gateway disconnected");
    const closeCode = this.lastCloseCode;
    this.lastCloseCode = undefined;
    this.onDoorwayChange?.({
      state: "disconnected",
      retryInMs: delayMs,
      ...(closeCode === undefined ? {} : { closeCode }),
    });
  }

  private handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      socket.close(1003, "binary frames are unsupported");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      socket.close(1007, "invalid json");
      return;
    }
    const parsed = PublicGatewayTunnelFrameSchema.safeParse(raw);
    if (!parsed.success) {
      socket.close(1008, "invalid gateway frame");
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "pairing_route_ready") {
      const waiter = this.pairingRouteWaiters.get(frame.offerHash);
      if (waiter !== undefined) {
        clearTimeout(waiter.deadline);
        this.pairingRouteWaiters.delete(frame.offerHash);
        waiter.resolve();
      }
      return;
    }
    if (frame.kind === "push_wake_result") {
      this.settlePushWake(frame.wakeId, frame.status);
      return;
    }
    if (frame.kind === "cancel") {
      this.inFlight.get(frame.requestId)?.abort(frame.reason);
      return;
    }
    if (frame.kind === "stream_open") {
      this.openStream(socket, frame);
      return;
    }
    if (frame.kind === "stream_data") {
      this.streamRecord(frame.streamId, Buffer.from(frame.dataBase64, "base64"));
      return;
    }
    if (frame.kind === "stream_close") {
      // The device hung up or went away; a late close for a finished stream is nothing.
      this.endStream(frame.streamId, frame.code);
      return;
    }
    if (frame.kind !== "request") {
      socket.close(1008, "gateway sent a host-owned frame");
      return;
    }
    if (this.inFlight.size >= PUBLIC_GATEWAY_IN_FLIGHT_MAX || this.inFlight.has(frame.requestId)) {
      socket.close(1008, "gateway request is outside the public contract");
      return;
    }
    // A route this body doesn't serve (a newer gateway or fleet calling an
    // older body) is refused on its own: closing the tunnel would also drop
    // every other exchange in flight (VUH-1830).
    if (publicGatewayTargetFor(frame.method, frame.path, this.gatewayRoutes) !== frame.target) {
      void sendJsonError(socket, frame.requestId, "route_unavailable", 404).catch(() => undefined);
      return;
    }
    const abort = new AbortController();
    this.inFlight.set(frame.requestId, abort);
    void this.forwardRequest(socket, frame, abort).finally(() => {
      if (this.inFlight.get(frame.requestId) === abort) this.inFlight.delete(frame.requestId);
    });
  }

  private async forwardRequest(
    socket: WebSocket,
    frame: PublicGatewayRequestFrame,
    abort: AbortController,
  ): Promise<void> {
    const baseUrl = frame.target === "control" ? this.controlPlaneUrl : this.relayUrl;
    const headers = new Headers();
    for (const header of frame.headers) {
      if (REQUEST_HEADER_ALLOWLIST.has(header.name)) headers.set(header.name, header.value);
    }
    // Forwarded over loopback like a local client; the mark keeps gateway
    // traffic out of the same-Mac boundary (LocalCompanionBoundary).
    headers.set(GATEWAY_FORWARDED_HEADER, "1");
    const body = frame.bodyBase64 === undefined ? undefined : Buffer.from(frame.bodyBase64, "base64");
    try {
      let discordWebEnvelope = false;
      if (frame.path === HOSTED_OPERATOR_PATH) {
        try {
          discordWebEnvelope = HostedDiscordEnvelopeSchema.safeParse(
            JSON.parse(body?.toString("utf8") ?? "null"),
          ).success;
        } catch {
          /* Other envelopes remain on the ordinary encrypted transport. */
        }
      }
      const response =
        isMachineJoinTransportRoute(frame.method, frame.path) ||
        frame.path === "/v1/hooks/linear" ||
        frame.path === "/v1/hosted/pair-offer" ||
        frame.path === HOSTED_SUPPORT_PATH ||
        frame.path === DISCORD_INGRESS_PATH ||
        frame.path === "/v1/activity/viewer" ||
        discordWebEnvelope
          ? await this.fetcher(new URL(frame.path, baseUrl), {
              method: frame.method,
              headers,
              signal: abort.signal,
              ...(body === undefined ? {} : { body }),
            })
          : this.encryption === undefined
            ? Response.json({ error: "encryption_required" }, { status: 426 })
            : await this.encryption.handle(
                frame.path,
                body?.toString("utf8") ?? "",
                abort.signal,
                async (request) => {
                  const url = new URL(request.url);
                  const origin = url.hostname === "control" ? this.controlPlaneUrl : this.relayUrl;
                  const forwarded = new Request(new URL(`${url.pathname}${url.search}`, origin), request);
                  forwarded.headers.set(GATEWAY_FORWARDED_HEADER, "1");
                  return this.fetcher(forwarded);
                },
              );
      await sendFrame(socket, {
        schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
        kind: "response_start",
        requestId: frame.requestId,
        status: response.status,
        headers: publicResponseHeaders(response),
      });
      let sequence = 0;
      let responseBytes = 0;
      const reader = response.body?.getReader();
      while (reader !== undefined) {
        const item = await reader.read();
        if (item.done) break;
        for (
          let offset = 0;
          offset < item.value.byteLength;
          offset += PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX
        ) {
          const chunk = item.value.subarray(offset, offset + PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX);
          responseBytes += chunk.byteLength;
          if (responseBytes > (frame.path === "/v1/activity/viewer" ? 256 * 1024 * 1024 : RESPONSE_BYTES_MAX))
            throw new Error("Local gateway response exceeded its limit");
          await sendFrame(socket, {
            schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
            kind: "response_chunk",
            requestId: frame.requestId,
            sequence,
            bodyBase64: Buffer.from(chunk).toString("base64"),
          });
          sequence += 1;
        }
      }
      await sendFrame(socket, {
        schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
        kind: "response_end",
        requestId: frame.requestId,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      this.logger.warn(
        { hostId: this.hostId, requestId: frame.requestId, target: frame.target, error: errorName(error) },
        "public gateway local request failed",
      );
      await sendJsonError(socket, frame.requestId, "local_service_unavailable").catch(() => undefined);
    }
  }

  private openStream(socket: WebSocket, frame: PublicGatewayStreamOpenFrame): void {
    const id = frame.streamId;
    if (
      this.encryption === undefined ||
      this.streams.size >= PUBLIC_GATEWAY_STREAMS_MAX ||
      this.streams.has(id)
    ) {
      // 1013: try again later. The device's call ends as unreachable; nothing was opened.
      // allow-swallowed-rejection -- a send fails only on a closed socket, whose close ends every stream
      void sendStreamClose(socket, id, this.streams.has(id) ? 1008 : 1013).catch(() => undefined);
      return;
    }
    const local: LocalStream = { id, abort: new AbortController(), started: false, up: 0, down: 0 };
    this.streams.set(id, local);
    void this.encryption
      .openStream(frame.envelope, local.abort.signal, (request) => {
        const url = new URL(request.url);
        const forwarded = new Request(new URL(`${url.pathname}${url.search}`, this.controlPlaneUrl), request);
        forwarded.headers.set(GATEWAY_FORWARDED_HEADER, "1");
        return this.fetcher(forwarded);
      })
      .then(
        (stream) => {
          if (this.streams.get(id) !== local) return;
          local.stream = stream;
          if (stream.status !== 101 || stream.authorization === undefined) {
            this.startStream(socket, local, stream.status);
            this.endStream(id, 1000, true);
            return;
          }
          this.connectRelay(socket, local, stream.authorization);
        },
        () => {
          // Not a device's call envelope, or not this Mac's: refused unopened, with nothing to seal.
          if (this.streams.get(id) === local) this.endStream(id, 1008, true);
        },
      );
  }

  /** The relay authorizes the call exactly as it would a device on this network. */
  private connectRelay(socket: WebSocket, local: LocalStream, authorization: string): void {
    const url = new URL(VOICE_CALL_PATH, this.relayUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const relay = new WebSocket(url, {
      headers: { authorization, [GATEWAY_FORWARDED_HEADER]: "1" },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: STREAM_PAYLOAD_BYTES_MAX,
    });
    local.relay = relay;
    relay.once("unexpected-response", (_request, response) => {
      response.resume();
      this.startStream(socket, local, response.statusCode ?? 502);
      relay.terminate();
    });
    relay.once("open", () => this.startStream(socket, local, 101));
    relay.on("message", (data, isBinary) => {
      const payload = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      this.sendRecord(
        socket,
        local,
        isBinary ? GATEWAY_STREAM_RECORD_BINARY : GATEWAY_STREAM_RECORD_TEXT,
        payload,
      );
    });
    relay.once("error", () => undefined);
    relay.once("close", (code) => {
      if (this.streams.get(local.id) !== local) return;
      // A relay that never answered is a call that could not start.
      if (!local.started) this.startStream(socket, local, 502);
      this.endStream(
        local.id,
        code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1011,
        true,
      );
    });
  }

  private startStream(socket: WebSocket, local: LocalStream, status: number): void {
    if (local.started) return;
    local.started = true;
    this.sendRecord(socket, local, GATEWAY_STREAM_RECORD_START, Buffer.from(JSON.stringify({ status })));
  }

  private sendRecord(socket: WebSocket, local: LocalStream, kind: number, payload: Buffer): void {
    if (local.stream === undefined || this.streams.get(local.id) !== local) return;
    if (payload.byteLength > STREAM_PAYLOAD_BYTES_MAX) {
      this.endStream(local.id, 1009, true);
      return;
    }
    const frame: PublicGatewayTunnelFrame = {
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "stream_data",
      streamId: local.id,
      dataBase64: local.stream.seal(kind, payload, local.down++).toString("base64"),
    };
    // allow-swallowed-rejection -- a send fails only on a closed socket, whose close ends every stream
    void sendFrame(socket, frame).catch(() => undefined);
  }

  /** One record from the device: opened in sequence, or the stream ends. */
  private streamRecord(id: string, record: Buffer): void {
    const local = this.streams.get(id);
    if (local === undefined) return;
    const relay = local.relay;
    if (local.stream === undefined || relay?.readyState !== WebSocket.OPEN) {
      // The device speaks only after its start record; anything earlier is out of contract.
      this.endStream(id, 1008, true);
      return;
    }
    let opened: { readonly kind: number; readonly payload: Buffer };
    try {
      opened = local.stream.open(record, local.up);
    } catch {
      this.endStream(id, 1008, true);
      return;
    }
    local.up += 1;
    if (opened.kind === GATEWAY_STREAM_RECORD_BINARY) relay.send(opened.payload, { binary: true });
    else if (opened.kind === GATEWAY_STREAM_RECORD_TEXT) relay.send(opened.payload.toString("utf8"));
    else this.endStream(id, 1008, true);
  }

  private endStream(id: string, code: number, tellGateway = false): void {
    const local = this.streams.get(id);
    if (local === undefined) return;
    this.streams.delete(id);
    local.abort.abort("stream ended");
    const relay = local.relay;
    if (relay?.readyState === WebSocket.OPEN) relay.close(code === 1005 || code === 1006 ? 1000 : code);
    else relay?.terminate();
    const socket = this.socket;
    // allow-swallowed-rejection -- a send fails only on a closed socket, whose close ends every stream
    if (tellGateway && socket !== undefined) void sendStreamClose(socket, id, code).catch(() => undefined);
    if (this.streams.size === 0 && this.refreshWhenIdle !== undefined && this.refreshWhenIdle === socket) {
      this.refreshWhenIdle = undefined;
      socket.close(4000, "refreshing host credential");
    }
  }

  private closeAllStreams(): void {
    for (const id of Array.from(this.streams.keys())) this.endStream(id, 1001);
  }

  private async replayPairingRoutes(socket: WebSocket): Promise<void> {
    const now = Date.now();
    for (const [offerHash, frame] of this.pairingRoutes) {
      if (Date.parse(frame.expiresAt) <= now) {
        this.pairingRoutes.delete(offerHash);
        continue;
      }
      try {
        await sendFrame(socket, frame);
      } catch {
        return;
      }
    }
  }

  private connectedSocket(): Promise<WebSocket> {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    if (!this.started) throw new Error("Public gateway connector is not started");
    return new Promise<WebSocket>((resolve, reject) => {
      const waiter: ConnectionWaiter = {
        resolve,
        reject,
        deadline: setTimeout(() => {
          this.connectionWaiters.delete(waiter);
          reject(new Error("Public gateway is unavailable"));
        }, CONNECT_TIMEOUT_MS),
      };
      waiter.deadline.unref();
      this.connectionWaiters.add(waiter);
    });
  }

  private settlePushWake(wakeId: string, status: PushWakeStatus): void {
    const waiter = this.pushWakeWaiters.get(wakeId);
    if (waiter === undefined) return;
    clearTimeout(waiter.deadline);
    this.pushWakeWaiters.delete(wakeId);
    waiter.settle(status);
  }

  private settleAllPushWakes(status: PushWakeStatus): void {
    // Snapshot first: settling deletes from the map being read.
    const pending = Array.from(this.pushWakeWaiters.keys());
    for (const wakeId of pending) this.settlePushWake(wakeId, status);
  }

  private rejectPairingRouteWaiters(message: string): void {
    for (const waiter of this.pairingRouteWaiters.values()) {
      clearTimeout(waiter.deadline);
      waiter.reject(new Error(message));
    }
    this.pairingRouteWaiters.clear();
  }
}

function requireHttpOrigin(raw: string, name: string): string {
  const parsed = new URL(raw);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(`${name} must be an exact http(s) origin`);
  }
  return parsed.origin;
}

function pairingRouteFrame(route: PublicGatewayPairingRoute): PublicGatewayPairingRouteFrame {
  return {
    schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
    kind: "pairing_route",
    offerHash: route.offerHash,
    codeHash: route.codeHash,
    expiresAt: route.expiresAt,
  };
}

function publicResponseHeaders(response: Response): Array<{ readonly name: string; readonly value: string }> {
  const headers: Array<{ readonly name: string; readonly value: string }> = [];
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name);
    if (value !== null) headers.push({ name, value });
  }
  return headers;
}

function sendFrame(socket: WebSocket, frame: PublicGatewayTunnelFrame): Promise<void> {
  if (socket.readyState !== WebSocket.OPEN)
    return Promise.reject(new Error("Public gateway is disconnected"));
  return new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(frame), (error) => (error ? reject(error) : resolve()));
  });
}

function sendStreamClose(socket: WebSocket, streamId: string, code: number): Promise<void> {
  return sendFrame(socket, {
    schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
    kind: "stream_close",
    streamId,
    code,
  });
}

async function sendJsonError(
  socket: WebSocket,
  requestId: string,
  error: string,
  status = 502,
): Promise<void> {
  const body = Buffer.from(JSON.stringify({ error }));
  await sendFrame(socket, {
    schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
    kind: "response_start",
    requestId,
    status,
    headers: [{ name: "content-type", value: "application/json" }],
  });
  await sendFrame(socket, {
    schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
    kind: "response_chunk",
    requestId,
    sequence: 0,
    bodyBase64: body.toString("base64"),
  });
  await sendFrame(socket, {
    schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
    kind: "response_end",
    requestId,
  });
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/** The broker's own code, so a parked doorway says which failure parked it. */
function errorCode(error: unknown): { readonly code: string } | Record<never, never> {
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? { code } : {};
}
