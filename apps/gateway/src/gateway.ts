import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { PairingRedeemRequestSchema } from "@clankie/protocol";
import {
  PUBLIC_GATEWAY_CONFIG_PATH,
  PUBLIC_GATEWAY_HEALTH_PATH,
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_HOST_PATH_PREFIX,
  PUBLIC_GATEWAY_IN_FLIGHT_MAX,
  PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX,
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PublicGatewayHostIdSchema,
  PublicGatewayInstallationIdSchema,
  PublicGatewayTunnelFrameSchema,
  derivePublicGatewayHostId,
  publicGatewayTargetFor,
  type PublicGatewayCapabilityHash,
  type PublicGatewayConfig,
  type PublicGatewayHttpHeader,
  type PublicGatewayRequestFrame,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol/public-gateway";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const PUBLIC_REQUEST_DEADLINE_MS = 60_000;
const PAIRING_ROUTE_FUTURE_MAX_MS = 15 * 60_000;
const HOST_HEARTBEAT_MS = 20_000;
const WEBSOCKET_PAYLOAD_BYTES_MAX = 2 * 1024 * 1024;
const RESPONSE_BYTES_MAX = 16 * 1024 * 1024;

const REQUEST_HEADER_ALLOWLIST = new Set(["accept", "authorization", "content-type"]);
const RESPONSE_HEADER_ALLOWLIST = new Set(["cache-control", "content-type", "retry-after"]);

export interface PublicGatewayLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface PublicGatewayOptions {
  readonly hostTokens: ReadonlyMap<string, string>;
  readonly accountConfig?: PublicGatewayConfig;
  readonly authenticateAccountToken?: PublicGatewayHostAuthenticator;
  readonly logger?: PublicGatewayLogger;
  readonly clock?: () => number;
  readonly requestIdFactory?: () => string;
}

type PublicGatewayHostAuthenticator = (
  token: string,
) => Promise<{ readonly accountId: string; readonly expiresAtMs: number }>;

export interface PublicGateway {
  readonly server: Server;
  close(): Promise<void>;
}

interface HostConnection {
  readonly hostId: string;
  readonly socket: WebSocket;
  readonly pendingRequestIds: Set<string>;
  readonly credentialDeadline?: ReturnType<typeof setTimeout>;
  alive: boolean;
}

interface PairingRoute {
  readonly hostId: string;
  readonly offerHash: PublicGatewayCapabilityHash;
  readonly codeHash: PublicGatewayCapabilityHash;
  readonly expiresAtMs: number;
}

interface PendingExchange {
  readonly requestId: string;
  readonly host: HostConnection;
  readonly response: ServerResponse;
  readonly startedAtMs: number;
  readonly deadline: ReturnType<typeof setTimeout>;
  started: boolean;
  nextSequence: number;
  responseBytes: number;
}

interface RoutedRequest {
  readonly host: HostConnection;
  readonly target: "control" | "relay";
  readonly path: string;
  readonly body: Buffer;
}

const silentLogger: PublicGatewayLogger = { info: () => undefined, warn: () => undefined };

export function createPublicGateway(options: PublicGatewayOptions): PublicGateway {
  const logger = options.logger ?? silentLogger;
  const clock = options.clock ?? Date.now;
  const requestIdFactory = options.requestIdFactory ?? (() => randomBytes(18).toString("base64url"));
  const hosts = new Map<string, HostConnection>();
  const pairingRoutes = new Map<PublicGatewayCapabilityHash, PairingRoute>();
  const pending = new Map<string, PendingExchange>();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: WEBSOCKET_PAYLOAD_BYTES_MAX });
  const server = createServer((request, response) => {
    void handlePublicRequest(request, response).catch((error: unknown) => {
      logger.warn({ error: errorName(error) }, "gateway request failed");
      sendJson(response, 500, { error: "gateway_internal_error" });
    });
  });

  server.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });

  const heartbeat = setInterval(() => {
    for (const connection of hosts.values()) {
      if (!connection.alive) {
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, HOST_HEARTBEAT_MS);
  heartbeat.unref();

  async function handlePublicRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === PUBLIC_GATEWAY_HEALTH_PATH) {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (
      request.method === "GET" &&
      request.url === PUBLIC_GATEWAY_CONFIG_PATH &&
      options.accountConfig !== undefined
    ) {
      sendJson(response, 200, options.accountConfig);
      return;
    }

    const routed = await routePublicRequest(request, response);
    if (routed === null) return;
    if (pending.size >= PUBLIC_GATEWAY_IN_FLIGHT_MAX) {
      sendJson(response, 503, { error: "gateway_busy" });
      return;
    }

    const requestId = requestIdFactory();
    const frame: PublicGatewayRequestFrame = {
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "request",
      requestId,
      target: routed.target,
      method: request.method === "GET" ? "GET" : "POST",
      path: routed.path,
      headers: publicRequestHeaders(request),
      ...(routed.body.byteLength === 0 ? {} : { bodyBase64: routed.body.toString("base64") }),
    };
    const validated = PublicGatewayTunnelFrameSchema.parse(frame);
    const deadline = setTimeout(() => {
      const exchange = pending.get(requestId);
      if (exchange === undefined) return;
      sendToHost(exchange.host, {
        schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
        kind: "cancel",
        requestId,
        reason: "deadline",
      });
      finishExchange(exchange, 504, "gateway_timeout");
    }, PUBLIC_REQUEST_DEADLINE_MS);
    deadline.unref();
    const exchange: PendingExchange = {
      requestId,
      host: routed.host,
      response,
      startedAtMs: clock(),
      deadline,
      started: false,
      nextSequence: 0,
      responseBytes: 0,
    };
    pending.set(requestId, exchange);
    routed.host.pendingRequestIds.add(requestId);
    response.once("close", () => {
      if (!pending.has(requestId)) return;
      sendToHost(routed.host, {
        schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
        kind: "cancel",
        requestId,
        reason: "client_closed",
      });
      removeExchange(exchange);
    });
    if (!sendToHost(routed.host, validated)) finishExchange(exchange, 503, "host_unavailable");
  }

  async function routePublicRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<RoutedRequest | null> {
    const url = requestUrl(request);
    if (url === null || request.url?.includes("?")) {
      sendJson(response, 404, { error: "route_not_found" });
      return null;
    }

    if (request.method === "POST" && url.pathname === "/v1/pairing/redeem") {
      const body = await readBody(request, response);
      if (body === null) return null;
      let parsed: ReturnType<typeof PairingRedeemRequestSchema.safeParse>;
      try {
        parsed = PairingRedeemRequestSchema.safeParse(JSON.parse(body.toString("utf8")));
      } catch {
        sendJson(response, 400, { error: "malformed" });
        return null;
      }
      if (!parsed.success) {
        sendJson(response, 400, { error: "malformed" });
        return null;
      }
      const capabilityHash = parsed.data.offerSecret
        ? hashCapability(parsed.data.offerSecret)
        : hashCapability(normalizePairingCode(parsed.data.code ?? ""));
      const route = claimPairingRoute(capabilityHash);
      if (route === null) {
        sendJson(response, 410, { error: "expired" });
        return null;
      }
      const host = hosts.get(route.hostId);
      if (host === undefined) {
        sendJson(response, 503, { error: "host_unavailable" });
        return null;
      }
      return { host, target: "control", path: url.pathname, body };
    }

    const hostRoute = parseHostRoute(url.pathname);
    if (hostRoute === null) {
      sendJson(response, 404, { error: "route_not_found" });
      return null;
    }
    const target =
      request.method === "GET" || request.method === "POST"
        ? publicGatewayTargetFor(request.method, hostRoute.path)
        : undefined;
    if (target === undefined) {
      sendJson(response, 404, { error: "route_not_found" });
      return null;
    }
    const host = hosts.get(hostRoute.hostId);
    if (host === undefined) {
      sendJson(response, 503, { error: "host_unavailable" });
      return null;
    }
    const body = request.method === "GET" ? Buffer.alloc(0) : await readBody(request, response);
    return body === null ? null : { host, target, path: hostRoute.path, body };
  }

  async function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = requestUrl(request);
    const hostId = url?.searchParams.get("hostId");
    const token = bearerToken(request.headers.authorization);
    if (
      url?.pathname !== PUBLIC_GATEWAY_HOST_CONNECT_PATH ||
      hostId === null ||
      hostId === undefined ||
      !PublicGatewayHostIdSchema.safeParse(hostId).success ||
      token === null
    ) {
      denyUpgrade(socket);
      return;
    }

    let expiresAtMs: number | undefined;
    const staticToken = options.hostTokens.get(hostId);
    const staticAccepted =
      url.searchParams.size === 1 && staticToken !== undefined && constantTimeEqual(token, staticToken);
    if (!staticAccepted) {
      const installationId = url.searchParams.get("installationId");
      if (
        url.searchParams.size !== 2 ||
        installationId === null ||
        !PublicGatewayInstallationIdSchema.safeParse(installationId).success ||
        options.accountConfig === undefined ||
        options.authenticateAccountToken === undefined
      ) {
        denyUpgrade(socket);
        return;
      }
      try {
        const principal = await options.authenticateAccountToken(token);
        if (!constantTimeEqual(hostId, derivePublicGatewayHostId(principal.accountId, installationId))) {
          denyUpgrade(socket);
          return;
        }
        expiresAtMs = principal.expiresAtMs;
      } catch {
        denyUpgrade(socket);
        return;
      }
    }

    webSockets.handleUpgrade(request, socket, head, (webSocket) =>
      attachHost(hostId, webSocket, expiresAtMs),
    );
  }

  function attachHost(hostId: string, socket: WebSocket, expiresAtMs?: number): void {
    const prior = hosts.get(hostId);
    if (prior !== undefined) {
      for (const requestId of prior.pendingRequestIds) {
        const exchange = pending.get(requestId);
        if (exchange !== undefined) finishExchange(exchange, 503, "host_unavailable");
      }
      prior.socket.close(1012, "host connection replaced");
    }
    const credentialDeadline =
      expiresAtMs === undefined
        ? undefined
        : setTimeout(() => socket.close(4001, "host credential expired"), Math.max(0, expiresAtMs - clock()));
    credentialDeadline?.unref();
    const connection: HostConnection = {
      hostId,
      socket,
      pendingRequestIds: new Set(),
      ...(credentialDeadline === undefined ? {} : { credentialDeadline }),
      alive: true,
    };
    hosts.set(hostId, connection);
    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data, isBinary) => handleHostMessage(connection, data, isBinary));
    socket.once("close", () => detachHost(connection));
    socket.once("error", () => undefined);
    logger.info({ hostId }, "gateway host connected");
  }

  function handleHostMessage(connection: HostConnection, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      connection.socket.close(1003, "binary frames are unsupported");
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      connection.socket.close(1007, "invalid json");
      return;
    }
    const parsed = PublicGatewayTunnelFrameSchema.safeParse(raw);
    if (!parsed.success) {
      connection.socket.close(1008, "invalid gateway frame");
      return;
    }
    const frame = parsed.data;
    if (frame.kind === "pairing_route") {
      registerPairingRoute(connection, frame);
      return;
    }
    if (frame.kind === "response_start" || frame.kind === "response_chunk" || frame.kind === "response_end") {
      handleHostResponse(connection, frame);
      return;
    }
    if (frame.kind === "cancel") {
      const exchange = pending.get(frame.requestId);
      if (exchange?.host === connection) finishExchange(exchange, 502, "host_cancelled");
      return;
    }
    connection.socket.close(1008, "host sent a gateway-owned frame");
  }

  function registerPairingRoute(
    connection: HostConnection,
    frame: Extract<PublicGatewayTunnelFrame, { readonly kind: "pairing_route" }>,
  ): void {
    prunePairingRoutes();
    const expiresAtMs = Date.parse(frame.expiresAt);
    const now = clock();
    if (expiresAtMs <= now || expiresAtMs > now + PAIRING_ROUTE_FUTURE_MAX_MS) {
      connection.socket.close(1008, "pairing route expiry is outside the accepted window");
      return;
    }
    const route: PairingRoute = {
      hostId: connection.hostId,
      offerHash: frame.offerHash,
      codeHash: frame.codeHash,
      expiresAtMs,
    };
    pairingRoutes.set(route.offerHash, route);
    pairingRoutes.set(route.codeHash, route);
    logger.info(
      { hostId: connection.hostId, expiresAt: frame.expiresAt },
      "gateway pairing route registered",
    );
    sendToHost(connection, {
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "pairing_route_ready",
      offerHash: frame.offerHash,
    });
  }

  function handleHostResponse(
    connection: HostConnection,
    frame: Extract<
      PublicGatewayTunnelFrame,
      { readonly kind: "response_start" | "response_chunk" | "response_end" }
    >,
  ): void {
    const exchange = pending.get(frame.requestId);
    if (exchange === undefined || exchange.host !== connection) {
      connection.socket.close(1008, "response does not name a live host exchange");
      return;
    }
    if (frame.kind === "response_start") {
      if (exchange.started) {
        connection.socket.close(1008, "duplicate response start");
        return;
      }
      exchange.started = true;
      exchange.response.statusCode = frame.status;
      for (const header of frame.headers) {
        if (RESPONSE_HEADER_ALLOWLIST.has(header.name))
          exchange.response.setHeader(header.name, header.value);
      }
      exchange.response.flushHeaders();
      return;
    }
    if (!exchange.started) {
      connection.socket.close(1008, "response body arrived before response start");
      return;
    }
    if (frame.kind === "response_chunk") {
      if (frame.sequence !== exchange.nextSequence) {
        connection.socket.close(1008, "response chunk sequence is not contiguous");
        return;
      }
      const chunk = Buffer.from(frame.bodyBase64, "base64");
      exchange.responseBytes += chunk.byteLength;
      if (exchange.responseBytes > RESPONSE_BYTES_MAX) {
        sendToHost(connection, {
          schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
          kind: "cancel",
          requestId: exchange.requestId,
          reason: "protocol_error",
        });
        exchange.response.destroy(new Error("gateway response limit exceeded"));
        removeExchange(exchange);
        return;
      }
      exchange.nextSequence += 1;
      // ponytail: one trusted host and a 16 MiB response ceiling bound buffering;
      // add per-exchange flow-control frames before multi-tenant deployment.
      exchange.response.write(chunk);
      return;
    }
    removeExchange(exchange);
    exchange.response.end();
    logger.info(
      {
        hostId: connection.hostId,
        requestId: exchange.requestId,
        status: exchange.response.statusCode,
        responseBytes: exchange.responseBytes,
        durationMs: clock() - exchange.startedAtMs,
      },
      "gateway exchange completed",
    );
  }

  function claimPairingRoute(hash: PublicGatewayCapabilityHash): PairingRoute | null {
    prunePairingRoutes();
    const route = pairingRoutes.get(hash);
    if (route === undefined) return null;
    pairingRoutes.delete(route.offerHash);
    pairingRoutes.delete(route.codeHash);
    return route;
  }

  function prunePairingRoutes(): void {
    const now = clock();
    for (const route of new Set(pairingRoutes.values())) {
      if (route.expiresAtMs > now) continue;
      pairingRoutes.delete(route.offerHash);
      pairingRoutes.delete(route.codeHash);
    }
  }

  function detachHost(connection: HostConnection): void {
    if (hosts.get(connection.hostId) !== connection) return;
    hosts.delete(connection.hostId);
    if (connection.credentialDeadline !== undefined) clearTimeout(connection.credentialDeadline);
    for (const requestId of connection.pendingRequestIds) {
      const exchange = pending.get(requestId);
      if (exchange !== undefined) finishExchange(exchange, 503, "host_unavailable");
    }
    for (const route of new Set(pairingRoutes.values())) {
      if (route.hostId !== connection.hostId) continue;
      pairingRoutes.delete(route.offerHash);
      pairingRoutes.delete(route.codeHash);
    }
    logger.warn({ hostId: connection.hostId }, "gateway host disconnected");
  }

  function finishExchange(exchange: PendingExchange, status: number, error: string): void {
    removeExchange(exchange);
    if (exchange.response.headersSent) {
      exchange.response.destroy();
      return;
    }
    sendJson(exchange.response, status, { error });
  }

  function removeExchange(exchange: PendingExchange): void {
    if (pending.get(exchange.requestId) !== exchange) return;
    pending.delete(exchange.requestId);
    exchange.host.pendingRequestIds.delete(exchange.requestId);
    clearTimeout(exchange.deadline);
  }

  return {
    server,
    async close() {
      clearInterval(heartbeat);
      for (const connection of hosts.values()) {
        if (connection.credentialDeadline !== undefined) clearTimeout(connection.credentialDeadline);
        connection.socket.close(1001, "gateway shutting down");
      }
      webSockets.close();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function parseHostTokensJson(raw: string): ReadonlyMap<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("CLANKIE_GATEWAY_HOST_TOKENS_JSON must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CLANKIE_GATEWAY_HOST_TOKENS_JSON must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error("At least one gateway host credential is required");
  const tokens = new Map<string, string>();
  for (const [hostId, token] of entries) {
    if (
      !PublicGatewayHostIdSchema.safeParse(hostId).success ||
      typeof token !== "string" ||
      token.length < 32
    ) {
      throw new Error(
        "Gateway host credentials require a valid host id and a token of at least 32 characters",
      );
    }
    tokens.set(hostId, token);
  }
  return tokens;
}

export function loadHostTokens(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, string> {
  const file = env.CLANKIE_GATEWAY_HOST_TOKENS_FILE?.trim();
  const inline = env.CLANKIE_GATEWAY_HOST_TOKENS_JSON?.trim();
  if (file !== undefined && file.length > 0 && inline !== undefined && inline.length > 0) {
    throw new Error("Configure gateway host tokens by file or JSON, not both");
  }
  const raw = file === undefined || file.length === 0 ? inline : readFileSync(file, "utf8");
  return raw === undefined || raw.length === 0 ? new Map() : parseHostTokensJson(raw);
}

function parseHostRoute(pathname: string): { readonly hostId: string; readonly path: string } | null {
  const prefix = `${PUBLIC_GATEWAY_HOST_PATH_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return null;
  const separator = pathname.indexOf("/", prefix.length);
  if (separator < 0) return null;
  const hostId = pathname.slice(prefix.length, separator);
  const path = pathname.slice(separator);
  if (!PublicGatewayHostIdSchema.safeParse(hostId).success) return null;
  return { hostId, path };
}

async function readBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.byteLength;
      if (length > PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX) {
        sendJson(response, 413, { error: "request_too_large" });
        request.destroy();
        return null;
      }
      chunks.push(buffer);
    }
  } catch {
    if (!response.headersSent) sendJson(response, 400, { error: "request_incomplete" });
    return null;
  }
  return Buffer.concat(chunks, length);
}

function publicRequestHeaders(request: IncomingMessage): PublicGatewayHttpHeader[] {
  const headers: PublicGatewayHttpHeader[] = [];
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = request.headers[name];
    if (typeof value === "string") headers.push({ name, value });
  }
  return headers;
}

function sendToHost(connection: HostConnection, frame: PublicGatewayTunnelFrame): boolean {
  if (connection.socket.readyState !== WebSocket.OPEN) return false;
  connection.socket.send(JSON.stringify(frame));
  return true;
}

function requestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "", "http://gateway.invalid");
  } catch {
    return null;
  }
}

function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([^\s]+)$/u.exec(header ?? "");
  return match?.[1] ?? null;
}

function denyUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  socket.destroy();
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}

function hashCapability(value: string): PublicGatewayCapabilityHash {
  return createHash("sha256").update(value).digest("hex") as PublicGatewayCapabilityHash;
}

function sendJson(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
