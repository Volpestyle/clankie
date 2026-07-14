import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceDispatch,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "../../../packages/protocol/src/index.ts";
import type {
  RelayDeviceAuthorization,
  RelayDeviceAuthorizer,
  RelayDeviceAuthDenial,
} from "./device-auth.ts";

export const OPERATOR_CONVERSATION_TAIL_PATH = "/operator/v1/tail";
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface RelayConversationLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface OperatorConversationRelayOptions {
  readonly authorizeDevice: RelayDeviceAuthorizer;
  readonly dispatch: OperatorConversationServiceDispatch;
  readonly logger?: RelayConversationLogger;
  readonly clock?: () => number;
  readonly idempotencyTtlMs?: number;
  readonly idempotencyMaxEntries?: number;
  readonly tailPollMs?: number;
  /** Bounded test/fixture seam; production leaves the stream unbounded. */
  readonly tailMaxPages?: number;
}

/**
 * Authenticated HTTP/NDJSON projection of the unchanged VUH-769 callable
 * contract. Returns true only for routes this boundary owns.
 */
export function createOperatorConversationRelayHandler(options: OperatorConversationRelayOptions) {
  const logger = options.logger ?? silentLogger;
  const idempotency = new TurnIdempotencyStore({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.idempotencyTtlMs === undefined ? {} : { ttlMs: options.idempotencyTtlMs }),
    ...(options.idempotencyMaxEntries === undefined ? {} : { maxEntries: options.idempotencyMaxEntries }),
  });
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = requestUrl(request).pathname;
    if (isApprovalCompletionPath(path)) {
      writeJson(response, 404, { error: "route_not_found" });
      logger.warn({ route: "approval_completion", statusCode: 404 }, "relay route denied");
      return true;
    }
    if (path !== OPERATOR_CONVERSATION_DISPATCH_PATH && path !== OPERATOR_CONVERSATION_TAIL_PATH) {
      return false;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed" });
      return true;
    }

    const token = bearerToken(request);
    if (token === undefined) {
      writeAuthDenial(response, "invalid");
      return true;
    }
    const authorization = await options.authorizeDevice.authorize(token);
    if (!authorization.authorized) {
      writeAuthDenial(response, authorization.denial);
      return true;
    }
    if (!authorization.device.grants.chat) {
      writeJson(response, 403, { error: "chat_grant_required" });
      return true;
    }

    let serviceRequest: OperatorConversationServiceRequest;
    try {
      serviceRequest = OperatorConversationServiceRequestSchema.parse(await readJson(request));
    } catch {
      writeJson(response, 400, { error: "invalid_conversation_request" });
      return true;
    }
    if (path === OPERATOR_CONVERSATION_TAIL_PATH) {
      if (serviceRequest.op !== "tail") {
        writeJson(response, 400, { error: "tail_request_required" });
        return true;
      }
      await streamTail({
        response,
        request: serviceRequest,
        token,
        initialAuthorization: authorization,
        options,
        logger,
      });
      return true;
    }

    try {
      const result =
        serviceRequest.op === "send"
          ? await idempotency.run(authorization.device.deviceId, serviceRequest, () =>
              options.dispatch(serviceRequest),
            )
          : await options.dispatch(serviceRequest);
      const publicResult = OperatorConversationServiceResultSchema.parse(result);
      writeJson(response, 200, publicResult);
      logger.info(logFields(authorization, serviceRequest, 200, publicResult), "conversation relay request");
    } catch {
      writeJson(response, 502, { error: "conversation_upstream_unavailable" });
      logger.warn(logFields(authorization, serviceRequest, 502), "conversation relay upstream failure");
    }
    return true;
  };
}

interface StreamTailInput {
  readonly response: ServerResponse;
  readonly request: Extract<OperatorConversationServiceRequest, { op: "tail" }>;
  readonly token: string;
  readonly initialAuthorization: Extract<RelayDeviceAuthorization, { authorized: true }>;
  readonly options: OperatorConversationRelayOptions;
  readonly logger: RelayConversationLogger;
}

async function streamTail(input: StreamTailInput): Promise<void> {
  const { response, request, options, logger } = input;
  response.statusCode = 200;
  response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  let cursor = request.tail.cursor;
  let pages = 0;
  let authorization: RelayDeviceAuthorization = input.initialAuthorization;
  while (!response.destroyed) {
    if (pages > 0) authorization = await options.authorizeDevice.authorize(input.token);
    if (!authorization.authorized) {
      logger.warn(
        {
          route: "tail",
          conversationId: request.tail.conversationId,
          surfaceClientId: request.tail.surfaceClientId,
          denial: authorization.denial,
        },
        "conversation tail authorization revoked",
      );
      response.destroy();
      return;
    }
    if (!authorization.device.grants.chat) {
      logger.warn(
        {
          route: "tail",
          conversationId: request.tail.conversationId,
          surfaceClientId: request.tail.surfaceClientId,
          denial: "chat_grant_required",
        },
        "conversation tail authorization revoked",
      );
      response.destroy();
      return;
    }
    let result: OperatorConversationServiceResult;
    try {
      result = OperatorConversationServiceResultSchema.parse(
        await options.dispatch({
          ...request,
          tail: { ...request.tail, ...(cursor === undefined ? {} : { cursor }) },
        }),
      );
    } catch {
      logger.warn(
        {
          route: "tail",
          deviceId: authorization.device.deviceId,
          conversationId: request.tail.conversationId,
          surfaceClientId: request.tail.surfaceClientId,
        },
        "conversation tail upstream failure",
      );
      response.destroy();
      return;
    }
    if (result.op !== "tail") {
      response.destroy();
      return;
    }
    const page = result.result;
    if (page.status === "recover") {
      await writeNdjson(response, { kind: "recovery", recovery: page });
      response.end();
      return;
    }
    for (const event of page.events) await writeNdjson(response, { kind: "event", event });
    cursor = page.nextCursor;
    pages += 1;
    if (options.tailMaxPages !== undefined && pages >= options.tailMaxPages) {
      response.end();
      return;
    }
    if (page.events.length === 0) await sleep(options.tailPollMs ?? 250);
  }
}

class TurnIdempotencyStore {
  private readonly entries = new Map<
    string,
    { readonly expiresAt: number; readonly result: Promise<OperatorConversationServiceResult> }
  >();
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  public constructor(options: {
    readonly clock?: () => number;
    readonly ttlMs?: number;
    readonly maxEntries?: number;
  }) {
    this.clock = options.clock ?? Date.now;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 4096;
  }

  public run(
    deviceId: string,
    request: Extract<OperatorConversationServiceRequest, { op: "send" }>,
    dispatch: () => Promise<OperatorConversationServiceResult>,
  ): Promise<OperatorConversationServiceResult> {
    this.expire();
    const key = createHash("sha256")
      .update(deviceId)
      .update("\0")
      .update(JSON.stringify(request))
      .digest("base64url");
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing.result;
    const result = dispatch().catch((error: unknown) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { expiresAt: this.clock() + this.ttlMs, result });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return result;
  }

  private expire(): void {
    const now = this.clock();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

function logFields(
  authorization: Extract<RelayDeviceAuthorization, { authorized: true }>,
  request: OperatorConversationServiceRequest,
  statusCode: number,
  result?: OperatorConversationServiceResult,
): Record<string, unknown> {
  const subject =
    request.op === "get"
      ? request
      : request.op === "replay"
        ? request.replay
        : request.op === "tail"
          ? request.tail
          : request.op === "send"
            ? request.turn
            : undefined;
  const resultStatus =
    result?.op === "send"
      ? result.result.status
      : result?.op === "replay" || result?.op === "tail"
        ? result.result.status
        : undefined;
  return {
    service: "clankie-relay",
    route: "operator_conversation",
    op: request.op,
    deviceId: authorization.device.deviceId,
    statusCode,
    ...(subject === undefined || !("conversationId" in subject)
      ? {}
      : { conversationId: subject.conversationId }),
    ...(subject === undefined || !("surfaceClientId" in subject)
      ? {}
      : { surfaceClientId: subject.surfaceClientId }),
    ...(resultStatus === undefined ? {} : { resultStatus }),
  };
}

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length === 0 ? undefined : token;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requestUrl(request: IncomingMessage): URL {
  return new URL(request.url ?? "/", "http://relay.invalid");
}

function isApprovalCompletionPath(path: string): boolean {
  return /\/approvals?(?:\/|$)/iu.test(path) && /(?:complete|approve|reject|record)/iu.test(path);
}

function writeAuthDenial(response: ServerResponse, denial: RelayDeviceAuthDenial): void {
  const status = denial === "unavailable" ? 503 : 401;
  const error =
    denial === "revoked"
      ? "revoked"
      : denial === "expired"
        ? "expired"
        : denial === "unavailable"
          ? "device_authorization_unavailable"
          : "device_authentication_required";
  writeJson(response, status, { error });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

async function writeNdjson(response: ServerResponse, body: unknown): Promise<void> {
  if (!response.write(`${JSON.stringify(body)}\n`)) await once(response, "drain");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const silentLogger: RelayConversationLogger = {
  info() {},
  warn() {},
};
