import { z } from "zod";
import {
  isMachineJoinTransportRoute,
  MACHINE_JOIN_START_PATH,
  MACHINE_JOIN_STATUS_PATH,
  MACHINE_JOIN_CHALLENGE_PATH,
  MACHINE_JOIN_CHANNEL_PATH,
  MachineJoinStartSchema,
  MachineJoinSecretSchema,
  MachineJoinIdSchema,
  JoinedMachineIdSchema,
  MachineJoinEnvelopeSchema,
} from "@clankie/protocol/machine-join";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  PUBLIC_GATEWAY_PUSH_REGISTRATIONS_PATH,
  PUBLIC_GATEWAY_PUSH_CLEAR_PATH,
  PublicGatewayPushRegistrationRequestSchema,
  PublicGatewayPushRegistrationResponseSchema,
  PublicGatewayPushClearRequestSchema,
  type PublicGatewayPushWakeFrame,
  type PublicGatewayPushWakeResultFrame,
} from "@clankie/protocol";
import {
  GATEWAY_CHALLENGE_PATH,
  GatewayPushIdentitySchema,
  GATEWAY_ENCRYPTED_PATH,
  GATEWAY_PUSH_AUTHORIZE_PATH,
  type GatewayEnvelope,
} from "@clankie/protocol/gateway-encryption";
import type { ApnsSender, ApnsResult } from "./apns.ts";
import { PushRegistrationError, type PushRegistrations } from "./push-registrations.ts";
import {
  PUBLIC_GATEWAY_CONFIG_PATH,
  PUBLIC_GATEWAY_HEALTH_PATH,
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_HOST_PATH_PREFIX,
  PUBLIC_GATEWAY_IN_FLIGHT_MAX,
  PUBLIC_GATEWAY_PAIRING_ROUTE_LIFETIME_MAX_MS,
  PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX,
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PublicGatewayHostIdSchema,
  PublicGatewayInstallationIdSchema,
  PublicGatewayTunnelFrameSchema,
  derivePublicGatewayHostId,
  PUBLIC_GATEWAY_REQUEST_HEADER_ALLOWLIST,
  PUBLIC_GATEWAY_RESPONSE_HEADER_ALLOWLIST,
  publicGatewayTargetFor,
  type PublicGatewayCapabilityHash,
  type PublicGatewayConfig,
  type PublicGatewayHttpHeader,
  type PublicGatewayRequestFrame,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol/public-gateway";
import {
  APP_TELEMETRY_BODY_BYTES_MAX,
  APP_TELEMETRY_PATH,
  AppTelemetryBatchSchema,
} from "@clankie/protocol/app-telemetry";
import {
  CONNECTOR_AUTHORIZATION_SERVER_PATH,
  CONNECTOR_AUTHORIZE_PATH,
  CONNECTOR_AUTHORIZE_STATUS_PATH,
  CONNECTOR_MCP_PATH,
  CONNECTOR_PROTECTED_RESOURCE_PATH,
  isConnectorRoute,
} from "@clankie/protocol/connector";
import { clientAddress, type TrustedProxy } from "./client-address.ts";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const JoinStatusRequestSchema = z.object({ joinId: MachineJoinIdSchema }).strict();
const JoinChallengeRequestSchema = z.object({ machineId: JoinedMachineIdSchema }).strict();
const MACHINE_JOIN_METADATA_BYTES_MAX = 16 * 1024;
const MACHINE_JOIN_CHANNEL_BYTES_MAX = 2 * 1024 * 1024;

const PUBLIC_REQUEST_DEADLINE_MS = 60_000;
const HOST_HEARTBEAT_MS = 20_000;
const WEBSOCKET_PAYLOAD_BYTES_MAX = 4 * 1024 * 1024;
const RESPONSE_BYTES_MAX = 32 * 1024 * 1024;
/** Wakes and registrations an authenticated account may spend per burst. */
const PUSH_ACCOUNT_BUDGET = 60;
/**
 * Registration and clear attempts one peer may make per burst, charged before the
 * body is read. Lower than the account budget because nothing has been proven yet.
 */
const PUSH_PEER_BUDGET = 30;
/**
 * App diagnostics are unauthenticated and sign-up is open, so every limit here
 * assumes a hostile caller. Behind the proxy all callers share one peer
 * address, so the shared budgets bound the whole route:
 * - requests (checked before the body is read): parsing work;
 * - events (charged per event after validation): log lines, and so the
 *   central store's ingestion cost — at most ~10 lines a second sustained;
 * - per host route: one app cannot starve the others (it sends at most once a
 *   minute).
 */
const TELEMETRY_REQUEST_BUDGET = { capacity: 100, perSecond: 5 } as const;
const TELEMETRY_EVENT_BUDGET = { capacity: 400, perSecond: 10 } as const;
const TELEMETRY_HOST_BUDGET = { capacity: 12, perSecond: 0.2 } as const;
/** Throttled telemetry is summarized at most once a minute, never logged per request. */
const TELEMETRY_THROTTLE_REPORT_MS = 60_000;
/** The response header naming a device exchange, so the app can report it (G3). */
const REQUEST_ID_HEADER = "x-clankie-request-id";

/**
 * The Claude connector (clankie ADR 0301) is plaintext through this doorway:
 * Claude speaks ordinary OAuth and MCP, and the Mac authenticates every call.
 * Claude's servers call from a few shared addresses, so tool calls, token and
 * registration calls are budgeted per host; the sign-in page a browser opens
 * is also budgeted per client.
 */
const CONNECTOR_HOST_BUDGET = { capacity: 240, perSecond: 8 } as const;
const CONNECTOR_SIGN_IN_PEER_BUDGET = { capacity: 60, perSecond: 2 } as const;

const REQUEST_HEADER_ALLOWLIST = new Set(PUBLIC_GATEWAY_REQUEST_HEADER_ALLOWLIST);
const RESPONSE_HEADER_ALLOWLIST = new Set(PUBLIC_GATEWAY_RESPONSE_HEADER_ALLOWLIST);

export interface PublicGatewayLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface PublicGatewayOptions {
  readonly hostTokens: ReadonlyMap<string, string>;
  readonly push?: { readonly registrations: PushRegistrations; readonly sender: ApnsSender };
  readonly accountConfig?: PublicGatewayConfig;
  readonly authenticateAccountToken?: PublicGatewayHostAuthenticator;
  readonly logger?: PublicGatewayLogger;
  /**
   * Optional: the reverse proxy in front (Caddy). Only from it is the last
   * X-Forwarded-For entry taken as the client, for per-client budgets.
   */
  readonly trustedProxy?: TrustedProxy;
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
  readonly connectedAtMs: number;
  readonly ownerId: string;
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

interface ExchangeDestination {
  start(status: number, headers: readonly PublicGatewayHttpHeader[]): void;
  chunk(buffer: Buffer): void;
  end(): void;
  fail(status: number, error: string): void;
}

interface PendingExchange {
  readonly requestId: string;
  readonly host: HostConnection;
  readonly destination: ExchangeDestination;
  readonly responseLimit: number;
  status: number;
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
  const pushBudgets = new Map<string, { tokens: number; at: number }>();
  /**
   * Separate namespace, same bucket: unauthenticated callers are metered by the
   * socket they actually arrived on, before anything they say is parsed. Keeping
   * it out of `pushBudgets` matters — a flood of peers must never fill the map
   * that holds accounts, and a junk claim must never spend a named victim's
   * wake allowance.
   */
  const peerBudgets = new Map<string, { tokens: number; at: number }>();
  const joinBudgets = new Map<string, { tokens: number; at: number }>();
  const connectorBudgets = new Map<string, { tokens: number; at: number }>();
  const telemetryBudgets = new Map<string, { tokens: number; at: number }>();
  const telemetryThrottled = { requests: 0, events: 0, host: 0, reportedAtMs: 0 };
  let pushesInFlight = 0;
  let closing = false;
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

  void options.trustedProxy?.refresh();
  const heartbeat = setInterval(() => {
    void options.trustedProxy?.refresh();
    reportTelemetryThrottles();
    for (const budgets of [pushBudgets, peerBudgets, telemetryBudgets, joinBudgets, connectorBudgets]) {
      for (const [key, budget] of budgets) {
        if (clock() - budget.at > 10 * 60_000) budgets.delete(key);
      }
    }
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

    if (request.method === "POST" && request.url === APP_TELEMETRY_PATH) {
      await handleAppTelemetry(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      (request.url === PUBLIC_GATEWAY_PUSH_REGISTRATIONS_PATH ||
        request.url === PUBLIC_GATEWAY_PUSH_CLEAR_PATH)
    ) {
      await handlePushRegistration(request, response);
      return;
    }
    const routed = await routePublicRequest(request, response);
    if (routed === null) return;
    relay(request, response, routed);
  }

  /** One bounded exchange with a host, streamed back to the caller. */
  function relay(request: IncomingMessage, response: ServerResponse, routed: RoutedRequest): void {
    if (pending.size >= PUBLIC_GATEWAY_IN_FLIGHT_MAX) {
      exchangeFailed({ hostId: routed.host.hostId, status: 503, code: "gateway_busy", durationMs: 0 });
      sendJson(response, 503, { error: "gateway_busy" });
      return;
    }

    const requestId = requestIdFactory();
    // Set before any outcome, so a failure the app sees still names its exchange.
    response.setHeader(REQUEST_ID_HEADER, requestId);
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
    const exchange = beginExchange(routed.host, frame, {
      start(status, headers) {
        response.statusCode = status;
        for (const header of headers) {
          if (RESPONSE_HEADER_ALLOWLIST.has(header.name)) response.setHeader(header.name, header.value);
        }
        response.flushHeaders();
      },
      chunk: (buffer) => {
        response.write(buffer);
      },
      end: () => {
        response.end();
      },
      fail(status, error) {
        if (response.headersSent) response.destroy();
        else sendJson(response, status, { error });
      },
    });
    if (exchange === undefined) return;
    response.once("close", () => {
      if (!pending.has(requestId)) return;
      sendToHost(routed.host, {
        schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
        kind: "cancel",
        requestId,
        reason: "client_closed",
      });
      removeExchange(exchange);
      exchangeFailed({
        hostId: routed.host.hostId,
        requestId,
        status: 499,
        code: "cancelled",
        durationMs: clock() - exchange.startedAtMs,
      });
    });
  }

  function beginExchange(
    host: HostConnection,
    frame: PublicGatewayRequestFrame,
    destination: ExchangeDestination,
    responseLimit = RESPONSE_BYTES_MAX,
    timeoutMs = PUBLIC_REQUEST_DEADLINE_MS,
  ): PendingExchange | undefined {
    if (closing || pending.size >= PUBLIC_GATEWAY_IN_FLIGHT_MAX) {
      exchangeFailed({
        hostId: host.hostId,
        requestId: frame.requestId,
        status: 503,
        code: "gateway_busy",
        durationMs: 0,
      });
      destination.fail(503, "gateway_busy");
      return undefined;
    }
    const validated = PublicGatewayTunnelFrameSchema.parse(frame);
    const requestId = frame.requestId;
    const deadline = setTimeout(() => {
      const exchange = pending.get(requestId);
      if (exchange === undefined) return;
      sendToHost(host, { schemaVersion: 1, kind: "cancel", requestId, reason: "deadline" });
      finishExchange(exchange, 504, "gateway_timeout");
    }, timeoutMs);
    deadline.unref();
    const exchange: PendingExchange = {
      requestId,
      host,
      destination,
      responseLimit,
      status: 0,
      startedAtMs: clock(),
      deadline,
      started: false,
      nextSequence: 0,
      responseBytes: 0,
    };
    pending.set(requestId, exchange);
    host.pendingRequestIds.add(requestId);
    if (!sendToHost(host, validated)) finishExchange(exchange, 503, "host_unavailable");
    return exchange;
  }

  // The device check shares sequencing, cancellation and connection ownership
  // with forwarded requests. No loopback HTTP or second tunnel RPC.
  function inspectDevice(
    host: HostConnection,
    proof: GatewayEnvelope,
  ): Promise<{ status: number; body: Buffer }> {
    return new Promise((resolve) => {
      let status = 0;
      const chunks: Buffer[] = [];
      beginExchange(
        host,
        {
          schemaVersion: 1,
          kind: "request",
          requestId: requestIdFactory(),
          target: "control",
          method: "POST",
          path: GATEWAY_PUSH_AUTHORIZE_PATH,
          headers: [],
          bodyBase64: Buffer.from(JSON.stringify(proof)).toString("base64"),
        },
        {
          start: (value) => {
            status = value;
          },
          chunk: (buffer) => {
            chunks.push(buffer);
          },
          end: () => {
            resolve({ status, body: Buffer.concat(chunks) });
          },
          fail: (value) => {
            resolve({ status: value, body: Buffer.alloc(0) });
          },
        },
        4096,
        5000,
      );
    });
  }

  async function handlePushRegistration(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const push = options.push;
    if (push === undefined || closing) {
      sendJson(response, 503, { error: "push_unavailable" });
      return;
    }
    // Before the body is read, before any row is touched, and before a named
    // host is asked to verify anything: an unauthenticated caller must not be
    // able to spend a host's tunnel or this process's parser for free.
    if (!takePeerBudget(request)) {
      // Refusing before the body is read leaves it unconsumed, which wedges a
      // keep-alive socket. Discard it without parsing and close the connection,
      // so a caller over budget cannot hold this one open either.
      request.resume();
      response.setHeader("connection", "close");
      sendJson(response, 429, { error: "push_throttled" });
      return;
    }
    const body = await readBody(request, response, 8192);
    if (body === null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString("utf8"));
    } catch {
      sendJson(response, 400, { error: "malformed" });
      return;
    }
    const clearing = request.url === PUBLIC_GATEWAY_PUSH_CLEAR_PATH;
    const parsed = clearing
      ? PublicGatewayPushClearRequestSchema.safeParse(raw)
      : PublicGatewayPushRegistrationRequestSchema.safeParse(raw);
    if (!parsed.success) {
      sendJson(response, 400, { error: "malformed" });
      return;
    }
    try {
      if (clearing) {
        try {
          sendJson(response, 200, { ...push.registrations.clear(parsed.data) });
          return;
        } catch (error) {
          // Existing rows clear with the app key even offline. Only allocation
          // of a new tombstone needs a live device, just like registration.
          //
          // A wrong key falls through to the same device authentication an
          // unknown registration needs, so an unauthenticated caller cannot tell
          // the two apart and learn which references exist. A caller that does
          // authenticate still gets the actionable conflict below.
          if (
            !(error instanceof PushRegistrationError) ||
            (error.reason !== "not_registered" && error.reason !== "mismatched_delivery_key")
          ) {
            throw error;
          }
        }
      }
      const host = parsed.data.hostId === undefined ? undefined : hosts.get(parsed.data.hostId);
      const proof = parsed.data.deviceAuthorization;
      if (proof === undefined || request.headers.authorization !== undefined) {
        sendJson(response, 401, { error: "device_auth_required" });
        return;
      }
      if (host === undefined) {
        sendJson(response, 503, { error: "host_unavailable" });
        return;
      }
      const inspected = await inspectDevice(host, proof);
      if (inspected.status !== 200) {
        sendJson(response, inspected.status === 401 || inspected.status === 403 ? 401 : 503, {
          error:
            inspected.status === 401 || inspected.status === 403
              ? "device_auth_required"
              : "host_unavailable",
        });
        return;
      }
      let device;
      try {
        device = GatewayPushIdentitySchema.parse(JSON.parse(inspected.body.toString("utf8")));
      } catch {
        sendJson(response, 502, { error: "invalid_device_response" });
        return;
      }
      if (!PublicGatewayPushRegistrationResponseSchema.shape.deviceId.safeParse(device.deviceId).success) {
        sendJson(response, 502, { error: "invalid_device_response" });
        return;
      }
      if (!device.grants.chat || Date.parse(device.sessionExpiresAt) <= clock()) {
        sendJson(response, 403, { error: "device_chat_required" });
        return;
      }
      if (!takePushBudget(host.ownerId)) {
        sendJson(response, 429, { error: "push_throttled" });
        return;
      }
      if (closing || hosts.get(host.hostId) !== host) {
        sendJson(response, 503, { error: "host_unavailable" });
        return;
      }
      if (clearing) {
        sendJson(response, 200, { ...push.registrations.clear(parsed.data, host.ownerId) });
      } else {
        const registration = PublicGatewayPushRegistrationRequestSchema.parse(parsed.data);
        sendJson(response, 200, {
          ...push.registrations.register(registration, device.deviceId, host.ownerId),
          deviceId: device.deviceId,
        });
      }
    } catch (error) {
      if (!(error instanceof PushRegistrationError)) throw error;
      sendJson(response, error.reason === "registration_limit" ? 429 : 409, { error: error.reason });
    }
  }

  /** One token bucket, refilling at one token per second, used by both namespaces. */
  function takeBudget(
    budgets: Map<string, { tokens: number; at: number }>,
    key: string,
    capacity: number,
    perSecond = 1,
    cost = 1,
  ): boolean {
    const now = clock();
    const previous = budgets.get(key);
    if (previous === undefined && budgets.size >= 4096) return false;
    const available = Math.min(
      capacity,
      (previous?.tokens ?? capacity) + (Math.max(0, now - (previous?.at ?? now)) / 1000) * perSecond,
    );
    // Only an admitted request spends a token. A denial keeps the credit it has
    // accrued so far — clamping it to zero would let a caller that retries
    // faster than the refill rate discard every fraction of a second and stay
    // empty for as long as it keeps knocking.
    const admitted = available >= cost;
    budgets.set(key, { tokens: admitted ? available - cost : available, at: now });
    return admitted;
  }

  /** Charged only once a device session has been proven, so junk cannot drain it. */
  function takePushBudget(ownerId: string): boolean {
    return takeBudget(pushBudgets, ownerId, PUSH_ACCOUNT_BUDGET);
  }

  /**
   * The connecting socket, never a forwarding header a caller can write. Behind a
   * reverse proxy every request shares the proxy's address, so this is a
   * conservative shared ingress budget rather than per-device fair scheduling.
   */
  function takePeerBudget(request: IncomingMessage): boolean {
    // Per client, not per socket peer: behind Caddy the peer is always Caddy.
    return takeBudget(peerBudgets, `peer:${clientAddress(request, options.trustedProxy)}`, PUSH_PEER_BUDGET);
  }

  async function handlePushWake(host: HostConnection, frame: PublicGatewayPushWakeFrame): Promise<void> {
    const reply = (status: PublicGatewayPushWakeResultFrame["status"]): void => {
      sendToHost(host, { schemaVersion: 1, kind: "push_wake_result", wakeId: frame.wakeId, status });
    };
    const push = options.push;
    if (closing || push === undefined) {
      reply("unavailable");
      return;
    }
    if (hosts.get(host.hostId) !== host) {
      reply("superseded");
      return;
    }
    if (pushesInFlight >= 32 || !takePushBudget(host.ownerId)) {
      reply("throttled");
      return;
    }
    const delivery = push.registrations.delivery(host.hostId, frame.deviceId, frame);
    if (typeof delivery === "string") {
      reply(delivery);
      return;
    }
    pushesInFlight += 1;
    try {
      const result: ApnsResult = await push.sender.send({
        ...delivery,
        conversationId: frame.conversationId,
        wakeId: frame.wakeId,
      });
      if (closing) return;
      if (result.status === "unregistered") {
        const invalidated = push.registrations.invalidate(delivery, result.timestampMs);
        reply(invalidated ? "unregistered" : "unavailable");
      } else if (result.status === "failed") reply("unavailable");
      else if (result.status === "refused") reply("rejected");
      else reply(result.status);
    } catch {
      reply("unavailable");
    } finally {
      pushesInFlight -= 1;
    }
  }

  async function routePublicRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<RoutedRequest | null> {
    const url = requestUrl(request);
    if (url === null) {
      sendJson(response, 404, { error: "route_not_found" });
      return null;
    }

    if (url.pathname === "/v1/pairing/redeem") {
      sendJson(response, 426, { error: "secure_pairing_required" });
      return null;
    }

    const hostRoute = parseHostRoute(url.pathname) ?? parseWellKnownHostRoute(url.pathname);
    // Only the connector's sign-in link carries a query: OAuth puts the request there.
    const query = request.url?.includes("?") === true;
    if (
      hostRoute === null ||
      (query && !(request.method === "GET" && hostRoute.path === CONNECTOR_AUTHORIZE_PATH))
    ) {
      sendJson(response, 404, { error: "route_not_found" });
      return null;
    }
    const path = query ? `${hostRoute.path}${url.search}` : hostRoute.path;
    const target =
      request.method === "GET" || request.method === "POST"
        ? publicGatewayTargetFor(request.method, path)
        : undefined;
    if (target === undefined) {
      sendJson(response, 404, { error: "route_not_found" });
      return null;
    }
    const machineJoin = isMachineJoinTransportRoute(request.method ?? "", hostRoute.path);
    const connector = isConnectorRoute(request.method ?? "", path);
    if (
      !machineJoin &&
      !connector &&
      ![GATEWAY_CHALLENGE_PATH, GATEWAY_ENCRYPTED_PATH, "/v1/hooks/linear"].includes(hostRoute.path)
    ) {
      sendJson(response, 426, { error: "encryption_required" });
      return null;
    }
    // A status claim can retrieve only the sealed lease, never authorize work.
    // Every other join route carries no bearer; approve keeps device encryption.
    if (hostRoute.path === MACHINE_JOIN_STATUS_PATH) {
      const claim = bearerToken(request.headers.authorization);
      if (!MachineJoinSecretSchema.safeParse(claim).success) {
        sendJson(response, 400, { error: "invalid_join_claim" });
        return null;
      }
    } else if (
      hostRoute.path !== "/v1/hooks/linear" &&
      hostRoute.path !== CONNECTOR_MCP_PATH &&
      request.headers.authorization !== undefined
    ) {
      sendJson(response, 400, { error: "plaintext_authorization_forbidden" });
      return null;
    }
    if (machineJoin) {
      // Before parsing or creating a tunnel exchange. These are admission limits,
      // not proof of machine identity; the body's registry verifies the envelope.
      // 256/s sustains both challenge and poll for the body's 63-machine limit.
      const bootstrap = hostRoute.path === MACHINE_JOIN_START_PATH;
      const category = bootstrap ? "start" : "transport";
      const capacity = bootstrap ? 32 : 512;
      const perSecond = bootstrap ? 0.2 : 256;
      const peer = clientAddress(request, options.trustedProxy);
      if (
        !takeBudget(joinBudgets, `${category}:peer:${peer}`, capacity, perSecond) ||
        !takeBudget(joinBudgets, `${category}:host:${hostRoute.hostId}`, capacity, perSecond)
      ) {
        response.setHeader("retry-after", bootstrap ? "5" : "1");
        sendJson(response, 429, { error: "machine_join_rate_limited" });
        return null;
      }
    }
    const host = hosts.get(hostRoute.hostId);
    if (host === undefined) {
      exchangeFailed({ hostId: hostRoute.hostId, status: 503, code: "host_unavailable", durationMs: 0 });
      sendJson(response, 503, { error: "host_unavailable" });
      return null;
    }
    // After the host check, so made-up host ids never take a budget slot.
    if (connector) {
      const signInPage =
        hostRoute.path === CONNECTOR_AUTHORIZE_PATH || hostRoute.path === CONNECTOR_AUTHORIZE_STATUS_PATH;
      const { capacity, perSecond } = CONNECTOR_HOST_BUDGET;
      if (
        !takeBudget(connectorBudgets, `host:${hostRoute.hostId}`, capacity, perSecond) ||
        (signInPage &&
          !takeBudget(
            connectorBudgets,
            `sign-in:peer:${clientAddress(request, options.trustedProxy)}`,
            CONNECTOR_SIGN_IN_PEER_BUDGET.capacity,
            CONNECTOR_SIGN_IN_PEER_BUDGET.perSecond,
          ))
      ) {
        response.setHeader("retry-after", "2");
        sendJson(response, 429, { error: "connector_rate_limited" });
        return null;
      }
    }
    const maxBytes = machineJoin
      ? hostRoute.path === MACHINE_JOIN_CHANNEL_PATH
        ? MACHINE_JOIN_CHANNEL_BYTES_MAX
        : MACHINE_JOIN_METADATA_BYTES_MAX
      : PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX;
    const declaredBytes = request.headers["content-length"];
    if (machineJoin && typeof declaredBytes === "string" && Number(declaredBytes) > maxBytes) {
      sendJson(response, 413, { error: "request_too_large" });
      request.resume();
      return null;
    }
    const body = request.method === "GET" ? Buffer.alloc(0) : await readBody(request, response, maxBytes);
    if (body === null) return null;
    if (machineJoin) {
      const schema =
        hostRoute.path === MACHINE_JOIN_START_PATH
          ? MachineJoinStartSchema
          : hostRoute.path === MACHINE_JOIN_STATUS_PATH
            ? JoinStatusRequestSchema
            : hostRoute.path === MACHINE_JOIN_CHALLENGE_PATH
              ? JoinChallengeRequestSchema
              : MachineJoinEnvelopeSchema;
      try {
        if (!schema.safeParse(JSON.parse(body.toString("utf8"))).success)
          throw new Error("invalid_join_request");
      } catch {
        sendJson(response, 400, { error: "invalid_join_request" });
        return null;
      }
    }
    // Keep the original bytes and sealed response opaque.
    return { host, target, path, body };
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
    let ownerId = `static:${hostId}`;
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
        ownerId = `account:${principal.accountId}`;
      } catch {
        denyUpgrade(socket);
        return;
      }
    }

    webSockets.handleUpgrade(request, socket, head, (webSocket) =>
      attachHost(hostId, ownerId, webSocket, expiresAtMs),
    );
  }

  function attachHost(hostId: string, ownerId: string, socket: WebSocket, expiresAtMs?: number): void {
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
      connectedAtMs: clock(),
      ownerId,
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
    socket.once("close", (code) => detachHost(connection, code));
    socket.once("error", () => undefined);
    logger.info({ event: "gateway.host.connected", hostId }, "gateway host connected");
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
    if (frame.kind === "push_wake") {
      void handlePushWake(connection, frame).catch(() => {
        sendToHost(connection, {
          schemaVersion: 1,
          kind: "push_wake_result",
          wakeId: frame.wakeId,
          status: "unavailable",
        });
      });
      return;
    }
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
    if (expiresAtMs <= now || expiresAtMs > now + PUBLIC_GATEWAY_PAIRING_ROUTE_LIFETIME_MAX_MS) {
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
    // Cancellation and a response can cross on the wire. A retired request has
    // no destination; discard its late frames without dropping unrelated work.
    if (exchange === undefined) return;
    if (exchange.host !== connection) {
      connection.socket.close(1008, "response does not name a live host exchange");
      return;
    }
    if (frame.kind === "response_start") {
      if (exchange.started) {
        connection.socket.close(1008, "duplicate response start");
        return;
      }
      exchange.started = true;
      exchange.status = frame.status;
      exchange.destination.start(frame.status, frame.headers);
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
      if (exchange.responseBytes > exchange.responseLimit) {
        sendToHost(connection, {
          schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
          kind: "cancel",
          requestId: exchange.requestId,
          reason: "protocol_error",
        });
        finishExchange(exchange, 502, "gateway_response_limit");
        return;
      }
      exchange.nextSequence += 1;
      // ponytail: one trusted host and a 16 MiB response ceiling bound buffering;
      // add per-exchange flow-control frames before multi-tenant deployment.
      exchange.destination.chunk(chunk);
      return;
    }
    removeExchange(exchange);
    exchange.destination.end();
    logger.info(
      {
        event: "gateway.exchange.completed",
        hostId: connection.hostId,
        requestId: exchange.requestId,
        status: exchange.status,
        responseBytes: exchange.responseBytes,
        durationMs: clock() - exchange.startedAtMs,
      },
      "gateway exchange completed",
    );
  }

  function prunePairingRoutes(): void {
    const now = clock();
    for (const route of new Set(pairingRoutes.values())) {
      if (route.expiresAtMs > now) continue;
      pairingRoutes.delete(route.offerHash);
      pairingRoutes.delete(route.codeHash);
    }
  }

  function detachHost(connection: HostConnection, closeCode?: number): void {
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
    logger.warn(
      {
        event: "gateway.host.disconnected",
        hostId: connection.hostId,
        ...(closeCode === undefined ? {} : { closeCode }),
        connectedMs: clock() - connection.connectedAtMs,
      },
      "gateway host disconnected",
    );
  }

  function finishExchange(exchange: PendingExchange, status: number, error: string): void {
    removeExchange(exchange);
    exchangeFailed({
      hostId: exchange.host.hostId,
      requestId: exchange.requestId,
      status,
      code: error,
      durationMs: clock() - exchange.startedAtMs,
    });
    exchange.destination.fail(status, error);
  }

  /** An exchange the gateway ended itself, which no completion line would show (G1). */
  function exchangeFailed(fields: {
    readonly hostId: string;
    readonly requestId?: string;
    readonly status: number;
    readonly code: string;
    readonly durationMs: number;
  }): void {
    logger.warn({ event: "gateway.exchange.failed", ...fields }, "gateway exchange failed");
  }

  /**
   * App diagnostics (G4). Unauthenticated by design: the app reports even when
   * it cannot reach its host. Throttled before the body is read, validated
   * against the strict protocol schema, never forwarded to a host, and logged as
   * one metadata line per event. A batch is the app's own claim about itself.
   */
  async function handleAppTelemetry(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const throttled = (reason: "requests" | "events" | "host") => {
      telemetryThrottled[reason] += 1;
      reportTelemetryThrottles();
      response.setHeader("retry-after", "60");
      sendJson(response, 429, { error: "telemetry_throttled" });
    };
    if (
      !takeBudget(
        telemetryBudgets,
        "shared:requests",
        TELEMETRY_REQUEST_BUDGET.capacity,
        TELEMETRY_REQUEST_BUDGET.perSecond,
      )
    ) {
      request.resume();
      response.setHeader("connection", "close");
      throttled("requests");
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.byteLength;
        if (length > APP_TELEMETRY_BODY_BYTES_MAX) {
          response.setHeader("connection", "close");
          sendJson(response, 413, { error: "telemetry_too_large" });
          request.destroy();
          return;
        }
        chunks.push(buffer);
      }
    } catch {
      if (!response.headersSent) sendJson(response, 400, { error: "invalid_telemetry" });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
    } catch {
      sendJson(response, 400, { error: "invalid_telemetry" });
      return;
    }
    const parsed = AppTelemetryBatchSchema.safeParse(raw);
    if (!parsed.success) {
      sendJson(response, 400, { error: "invalid_telemetry" });
      return;
    }
    const batch = parsed.data;
    if (
      !takeBudget(
        telemetryBudgets,
        `host:${batch.hostId}`,
        TELEMETRY_HOST_BUDGET.capacity,
        TELEMETRY_HOST_BUDGET.perSecond,
      )
    ) {
      throttled("host");
      return;
    }
    if (
      !takeBudget(
        telemetryBudgets,
        "shared:events",
        TELEMETRY_EVENT_BUDGET.capacity,
        TELEMETRY_EVENT_BUDGET.perSecond,
        batch.events.length,
      )
    ) {
      throttled("events");
      return;
    }
    for (const event of batch.events) {
      logger.info(
        {
          ...event,
          hostId: batch.hostId,
          ...(batch.deviceRef === undefined ? {} : { deviceRef: batch.deviceRef }),
          platform: batch.platform,
          appVersion: batch.appVersion,
        },
        "app telemetry",
      );
    }
    sendJson(response, 202, { accepted: batch.events.length });
  }

  /** One line a minute at most, and only when something was refused: the alarm's signal. */
  function reportTelemetryThrottles(): void {
    const { requests, events, host } = telemetryThrottled;
    if (
      requests + events + host === 0 ||
      clock() - telemetryThrottled.reportedAtMs < TELEMETRY_THROTTLE_REPORT_MS
    )
      return;
    logger.warn(
      { event: "gateway.telemetry.throttled", requests, events, host },
      "gateway telemetry throttled",
    );
    Object.assign(telemetryThrottled, { requests: 0, events: 0, host: 0, reportedAtMs: clock() });
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
      closing = true;
      clearInterval(heartbeat);
      for (const exchange of pending.values()) finishExchange(exchange, 503, "gateway_closed");
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

/**
 * Discovery at the origin's root names the host after the well-known suffix:
 * RFC 8414 inserts the issuer's path there (`/.well-known/oauth-authorization-server/h/{hostId}`),
 * and RFC 9728 does the same for the resource (`.../oauth-protected-resource/h/{hostId}/mcp`).
 */
function parseWellKnownHostRoute(
  pathname: string,
): { readonly hostId: string; readonly path: string } | null {
  const issuer = `${CONNECTOR_AUTHORIZATION_SERVER_PATH}${PUBLIC_GATEWAY_HOST_PATH_PREFIX}/`;
  if (pathname.startsWith(issuer)) {
    const route = parseHostRoute(`${pathname.slice(CONNECTOR_AUTHORIZATION_SERVER_PATH.length)}/`);
    return route?.path === "/" ? { hostId: route.hostId, path: CONNECTOR_AUTHORIZATION_SERVER_PATH } : null;
  }
  const resource = `${CONNECTOR_PROTECTED_RESOURCE_PATH}${PUBLIC_GATEWAY_HOST_PATH_PREFIX}/`;
  if (pathname.startsWith(resource)) {
    const route = parseHostRoute(pathname.slice(CONNECTOR_PROTECTED_RESOURCE_PATH.length));
    return route?.path === CONNECTOR_MCP_PATH
      ? { hostId: route.hostId, path: `${CONNECTOR_PROTECTED_RESOURCE_PATH}${CONNECTOR_MCP_PATH}` }
      : null;
  }
  return null;
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

async function readBody(
  request: IncomingMessage,
  response: ServerResponse,
  maxBytes = PUBLIC_GATEWAY_REQUEST_BODY_BYTES_MAX,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.byteLength;
      if (length > maxBytes) {
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

function sendJson(response: ServerResponse, status: number, body: Readonly<Record<string, unknown>>): void {
  if (response.writableEnded || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
