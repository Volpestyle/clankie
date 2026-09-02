import { createHash } from "node:crypto";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_IN_FLIGHT_MAX,
  PUBLIC_GATEWAY_RESPONSE_CHUNK_BYTES_MAX,
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PublicGatewayHostIdSchema,
  PublicGatewayInstallationIdSchema,
  PublicGatewayTunnelFrameSchema,
  publicGatewayTargetFor,
  type PublicGatewayPairingRouteFrame,
  type PublicGatewayRequestFrame,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol";
import { WebSocket, type RawData } from "ws";

const CONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const TOKEN_REFRESH_WINDOW_MS = 5 * 60_000;
const RESPONSE_BYTES_MAX = 16 * 1024 * 1024;
const WEBSOCKET_PAYLOAD_BYTES_MAX = 2 * 1024 * 1024;
const REQUEST_HEADER_ALLOWLIST = new Set(["accept", "authorization", "content-type"]);
const RESPONSE_HEADER_ALLOWLIST = new Set(["cache-control", "content-type", "retry-after"]);

export interface PublicGatewayConnectorLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface PublicGatewayConnectorOptions {
  readonly gatewayUrl: string;
  readonly hostId: string;
  readonly hostToken?: string;
  readonly installationId?: string;
  readonly resolveHostToken?: () => Promise<{ readonly token: string; readonly expiresAt: number }>;
  readonly controlPlaneUrl: string;
  readonly relayUrl: string;
  readonly logger?: PublicGatewayConnectorLogger;
  readonly fetch?: typeof globalThis.fetch;
  readonly reconnectMinimumMs?: number;
  readonly reconnectMaximumMs?: number;
}

export interface PublicGatewayPairingOffer {
  readonly offerSecret: string;
  readonly code: string;
  readonly expiresAt: string;
}

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

const silentLogger: PublicGatewayConnectorLogger = { info: () => undefined, warn: () => undefined };

export class PublicGatewayConnector {
  public readonly hostBaseUrl: string;

  private readonly connectUrl: string;
  private readonly hostId: string;
  private readonly hostToken: string | undefined;
  private readonly resolveHostToken:
    | (() => Promise<{ readonly token: string; readonly expiresAt: number }>)
    | undefined;
  private readonly controlPlaneUrl: string;
  private readonly relayUrl: string;
  private readonly logger: PublicGatewayConnectorLogger;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly reconnectMinimumMs: number;
  private readonly reconnectMaximumMs: number;
  private readonly pairingRoutes = new Map<string, PublicGatewayPairingRouteFrame>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private readonly pairingRouteWaiters = new Map<string, PairingRouteWaiter>();
  private socket: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private tokenRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs: number;
  private connecting = false;
  private started = false;

  public constructor(options: PublicGatewayConnectorOptions) {
    const gatewayOrigin = requireHttpOrigin(options.gatewayUrl, "Gateway URL");
    this.hostId = PublicGatewayHostIdSchema.parse(options.hostId);
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
    this.controlPlaneUrl = requireHttpOrigin(options.controlPlaneUrl, "Control-plane URL");
    this.relayUrl = requireHttpOrigin(options.relayUrl, "Relay URL");
    this.logger = options.logger ?? silentLogger;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.reconnectMinimumMs = options.reconnectMinimumMs ?? RECONNECT_MIN_MS;
    this.reconnectMaximumMs = options.reconnectMaximumMs ?? RECONNECT_MAX_MS;
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

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  public async publishPairingOffer(offer: PublicGatewayPairingOffer): Promise<void> {
    const frame: PublicGatewayPairingRouteFrame = {
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "pairing_route",
      offerHash: hashCapability(offer.offerSecret),
      codeHash: hashCapability(normalizePairingCode(offer.code)),
      expiresAt: offer.expiresAt,
    };
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

  public close(): void {
    if (!this.started) return;
    this.started = false;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.tokenRefreshTimer !== undefined) clearTimeout(this.tokenRefreshTimer);
    this.reconnectTimer = undefined;
    this.tokenRefreshTimer = undefined;
    for (const controller of this.inFlight.values()) controller.abort("gateway connector closed");
    this.inFlight.clear();
    this.socket?.close(1001, "connector shutting down");
    this.socket = undefined;
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.deadline);
      waiter.reject(new Error("Gateway connector closed"));
    }
    this.connectionWaiters.clear();
    this.rejectPairingRouteWaiters("Gateway connector closed");
  }

  private connect(): void {
    if (!this.started || this.socket !== undefined || this.connecting) return;
    this.connecting = true;
    void this.openSocket().finally(() => {
      this.connecting = false;
    });
  }

  private async openSocket(): Promise<void> {
    let credential: { readonly token: string; readonly expiresAt?: number };
    try {
      credential =
        this.resolveHostToken === undefined ? { token: this.hostToken ?? "" } : await this.resolveHostToken();
    } catch (error) {
      this.logger.warn(
        { hostId: this.hostId, error: errorName(error) },
        "public gateway credential refresh failed",
      );
      this.scheduleReconnect();
      return;
    }
    if (!this.started || this.socket !== undefined) return;
    const socket = new WebSocket(this.connectUrl, {
      headers: { authorization: `Bearer ${credential.token}` },
      handshakeTimeout: CONNECT_TIMEOUT_MS,
      maxPayload: WEBSOCKET_PAYLOAD_BYTES_MAX,
    });
    this.socket = socket;
    socket.once("open", () => {
      if (this.socket !== socket) return;
      this.reconnectDelayMs = this.reconnectMinimumMs;
      for (const waiter of this.connectionWaiters) {
        clearTimeout(waiter.deadline);
        waiter.resolve(socket);
      }
      this.connectionWaiters.clear();
      if (credential.expiresAt !== undefined) {
        const refreshInMs = Math.max(0, credential.expiresAt - Date.now() - TOKEN_REFRESH_WINDOW_MS);
        this.tokenRefreshTimer = setTimeout(() => {
          this.tokenRefreshTimer = undefined;
          if (this.socket === socket) socket.close(4000, "refreshing host credential");
        }, refreshInMs);
        this.tokenRefreshTimer.unref();
      }
      void this.replayPairingRoutes(socket);
      this.logger.info({ hostId: this.hostId }, "public gateway connected");
    });
    socket.on("message", (data, isBinary) => this.handleMessage(socket, data, isBinary));
    socket.once("error", (error) => {
      this.logger.warn({ hostId: this.hostId, error: error.name }, "public gateway connection error");
    });
    socket.once("close", () => this.disconnected(socket));
  }

  private disconnected(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    if (this.tokenRefreshTimer !== undefined) clearTimeout(this.tokenRefreshTimer);
    this.tokenRefreshTimer = undefined;
    for (const controller of this.inFlight.values()) controller.abort("public gateway disconnected");
    this.inFlight.clear();
    this.rejectPairingRouteWaiters("Public gateway disconnected before acknowledging the pairing route");
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
    if (frame.kind === "cancel") {
      this.inFlight.get(frame.requestId)?.abort(frame.reason);
      return;
    }
    if (frame.kind !== "request") {
      socket.close(1008, "gateway sent a host-owned frame");
      return;
    }
    if (
      this.inFlight.size >= PUBLIC_GATEWAY_IN_FLIGHT_MAX ||
      this.inFlight.has(frame.requestId) ||
      publicGatewayTargetFor(frame.method, frame.path) !== frame.target
    ) {
      socket.close(1008, "gateway request is outside the public contract");
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
    const body = frame.bodyBase64 === undefined ? undefined : Buffer.from(frame.bodyBase64, "base64");
    try {
      const response = await this.fetcher(new URL(frame.path, baseUrl), {
        method: frame.method,
        headers,
        signal: abort.signal,
        ...(body === undefined ? {} : { body }),
      });
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
          if (responseBytes > RESPONSE_BYTES_MAX)
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

function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

function hashCapability(value: string): `${string}` {
  return createHash("sha256").update(value).digest("hex");
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

async function sendJsonError(socket: WebSocket, requestId: string, error: string): Promise<void> {
  const body = Buffer.from(JSON.stringify({ error }));
  await sendFrame(socket, {
    schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
    kind: "response_start",
    requestId,
    status: 502,
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
