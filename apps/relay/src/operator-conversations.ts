import { DeviceConversationRefusal, type DeviceConversationDispatch } from "./conversation-upstream.ts";
import {
  DISCORD_VOICE_TRANSCRIPTS_PATH,
  DiscordVoiceTranscriptPageSchema,
} from "../../../packages/protocol/src/index.ts";
import {
  DISCORD_ROOMS_PATH,
  DISCORD_ROOM_GUIDANCE_PATH,
  DISCORD_SETTINGS_PATH,
  DISCORD_ROOM_VOICE_PATH,
  DiscordRoomVoiceStatusSchema,
  DiscordRoomsSnapshotSchema,
  DiscordRoomGuidanceRequestSchema,
  DiscordRoomGuidanceSchema,
  DiscordSettingsSnapshotSchema,
} from "../../../packages/protocol/src/discord-rooms.ts";
import { BODY_LEASE_STATUS_PATH, BodyLeaseStatusSchema } from "../../../packages/protocol/src/body-leases.ts";
import { hostedOperatorAllows } from "../../../packages/protocol/src/hosted-operator.ts";
import {
  DISCORD_DIRECTORY_PATH,
  DiscordDirectorySnapshotSchema,
  safeParseProtocolResponse,
} from "../../../packages/protocol/src/index.ts";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OPERATOR_DELIVERED_FILE_BYTES_MAX,
  OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH,
  OPERATOR_TERMINAL_TAIL_PATH,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  OperatorDeliveredFileDownloadRequestSchema,
  type OperatorDeliveredFileDownloadRequest,
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
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const IDEMPOTENCY_MAX_ENTRIES = 4_096;

export interface RelayConversationLogger {
  info(fields: Readonly<Record<string, unknown>>, message: string): void;
  warn(fields: Readonly<Record<string, unknown>>, message: string): void;
}

export interface OperatorConversationRelayOptions {
  readonly authorizeDevice: RelayDeviceAuthorizer;
  readonly dispatch: OperatorConversationServiceDispatch;
  /** Original signed device; only owner-capable send and preference input operations. */
  readonly deviceDispatch?: DeviceConversationDispatch;
  /** Forwards the original paired-device token; never substitutes captain authority. */
  readonly roomRequest?: (
    path: string,
    method: "GET" | "POST",
    deviceToken: string,
    body?: string,
  ) => Promise<Response>;
  readonly readBodyLeases?: (deviceToken: string) => Promise<Response>;
  readonly downloadFile?: (request: OperatorDeliveredFileDownloadRequest) => Promise<Response>;
  readonly logger?: RelayConversationLogger;
  readonly clock?: () => number;
  readonly tailPollMs?: number;
  /** Bounded test/fixture seam; production leaves the stream unbounded. */
  readonly tailMaxPages?: number;
}

/**
 * Authenticated HTTP/NDJSON projection of the callable operator contract.
 * Returns true only for routes this boundary owns.
 */
export function createOperatorConversationRelayHandler(options: OperatorConversationRelayOptions) {
  const logger = options.logger ?? silentLogger;
  const idempotency = new TurnIdempotencyStore(options.clock ?? Date.now);
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = requestUrl(request).pathname;
    const roomRoute =
      path === DISCORD_ROOMS_PATH ||
      path === DISCORD_ROOM_GUIDANCE_PATH ||
      path === DISCORD_SETTINGS_PATH ||
      path === DISCORD_DIRECTORY_PATH ||
      path === DISCORD_ROOM_VOICE_PATH ||
      path === DISCORD_VOICE_TRANSCRIPTS_PATH;
    if (roomRoute) {
      const method = path === DISCORD_ROOM_GUIDANCE_PATH ? "POST" : "GET";
      if (request.method !== method) {
        writeJson(response, 405, { error: "method_not_allowed" });
        return true;
      }
      const token = bearerToken(request);
      if (token === undefined) {
        writeAuthDenial(response, "invalid");
        return true;
      }
      const grant = path === DISCORD_ROOM_GUIDANCE_PATH ? "steer" : "terminalObserve";
      if (!(await authorizeGrant(options, token, response, grant))) return true;
      if (!options.roomRequest) {
        writeJson(response, 503, { error: "room_route_unavailable" });
        return true;
      }
      let body: string | undefined;
      if (method === "POST") {
        const parsed = DiscordRoomGuidanceRequestSchema.safeParse(await readJson(request));
        if (!parsed.success) {
          writeJson(response, 400, { error: "invalid_room_guidance" });
          return true;
        }
        body = JSON.stringify(parsed.data);
      }
      if (!(await authorizeGrant(options, token, response, grant))) return true;
      const upstream = await options.roomRequest(`${path}${requestUrl(request).search}`, method, token, body);
      const data: unknown = await upstream.json();
      if (!(await authorizeGrant(options, token, response, grant))) return true;
      response.setHeader("cache-control", "no-store");
      if (!upstream.ok) {
        writeJson(response, upstream.status, { error: "room_route_unavailable" });
        return true;
      }
      const schema =
        path === DISCORD_ROOMS_PATH
          ? DiscordRoomsSnapshotSchema
          : path === DISCORD_ROOM_GUIDANCE_PATH
            ? DiscordRoomGuidanceSchema
            : path === DISCORD_ROOM_VOICE_PATH
              ? DiscordRoomVoiceStatusSchema
              : path === DISCORD_VOICE_TRANSCRIPTS_PATH
                ? DiscordVoiceTranscriptPageSchema
                : path === DISCORD_DIRECTORY_PATH
                  ? DiscordDirectorySnapshotSchema
                  : DiscordSettingsSnapshotSchema;
      const parsed = safeParseProtocolResponse<unknown>(schema, data);
      writeJson(
        response,
        parsed.success ? 200 : 502,
        parsed.success ? parsed.data : { error: "invalid_room_response" },
      );
      return true;
    }
    if (
      path !== BODY_LEASE_STATUS_PATH &&
      path !== OPERATOR_CONVERSATION_DISPATCH_PATH &&
      path !== OPERATOR_CONVERSATION_TAIL_PATH &&
      path !== OPERATOR_TERMINAL_TAIL_PATH &&
      path !== OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH
    ) {
      return false;
    }
    if (request.method !== (path === BODY_LEASE_STATUS_PATH ? "GET" : "POST")) {
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
    if (path === BODY_LEASE_STATUS_PATH) {
      if (!authorization.device.grants.terminalObserve) {
        writeGrantDenial(response, "terminalObserve");
        return true;
      }
      if (options.readBodyLeases === undefined) {
        writeJson(response, 503, { error: "body_leases_unavailable" });
        return true;
      }
      const upstream = await options.readBodyLeases(token);
      const parsed = upstream.ok ? BodyLeaseStatusSchema.safeParse(await upstream.json()) : undefined;
      const fresh = await options.authorizeDevice.authorize(token);
      if (!fresh.authorized) {
        writeAuthDenial(response, fresh.denial);
        return true;
      }
      if (!fresh.device.grants.terminalObserve) {
        writeGrantDenial(response, "terminalObserve");
        return true;
      }
      if (!upstream.ok) {
        writeJson(response, upstream.status, { error: "body_leases_unavailable" });
        return true;
      }
      response.setHeader("cache-control", "no-store");
      writeJson(
        response,
        parsed?.success ? 200 : 502,
        parsed?.success ? parsed.data : { error: "invalid_body_lease_status" },
      );
      return true;
    }
    if (path === OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH) {
      if (!authorization.device.grants.chat) {
        writeGrantDenial(response, "chat");
        return true;
      }
      let body: unknown;
      try {
        body = await readJson(request);
      } catch {
        writeJson(response, 400, { error: "invalid_artifact_request" });
        return true;
      }
      const parsed = OperatorDeliveredFileDownloadRequestSchema.safeParse(body);
      if (!parsed.success) {
        writeJson(response, 400, { error: "invalid_artifact_request" });
        return true;
      }
      if (!(await authorizeGrant(options, token, response, "chat"))) return true;
      try {
        if (options.downloadFile === undefined) throw new Error("artifact upstream unavailable");
        const upstream = await options.downloadFile(parsed.data);
        const declaredLength = Number(upstream.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > OPERATOR_DELIVERED_FILE_BYTES_MAX) {
          writeJson(response, 502, { error: "artifact_upstream_too_large" });
          return true;
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.byteLength > OPERATOR_DELIVERED_FILE_BYTES_MAX) {
          writeJson(response, 502, { error: "artifact_upstream_too_large" });
          return true;
        }
        if (!(await authorizeGrant(options, token, response, "chat"))) return true;
        response.statusCode = upstream.status;
        for (const header of [
          "cache-control",
          "content-disposition",
          "content-type",
          "x-content-type-options",
        ]) {
          const value = upstream.headers.get(header);
          if (value !== null) response.setHeader(header, value);
        }
        response.setHeader("content-length", String(body.byteLength));
        response.end(body);
      } catch {
        writeJson(response, 502, { error: "artifact_upstream_unavailable" });
      }
      return true;
    }
    let serviceRequest: OperatorConversationServiceRequest;
    try {
      serviceRequest = OperatorConversationServiceRequestSchema.parse(await readJson(request));
    } catch {
      writeJson(response, 400, { error: "invalid_conversation_request" });
      return true;
    }
    if (
      authorization.device.controlScope === "hosted" &&
      !hostedOperatorAllows("POST", "/operator/v1/dispatch", JSON.stringify(serviceRequest))
    ) {
      writeJson(response, 403, { error: "account_authority_required" });
      return true;
    }
    // A stance is safe to reach from the agent side for exactly one reason: the
    // caller names the Herdr pane it is sitting in, and the service checks that
    // against the census (ADR 0148). A remote device cannot make that claim — it
    // would be typing some other pane's id — so the op stays on the local door
    // rather than riding a device grant.
    if (
      serviceRequest.op === "state_stance" ||
      serviceRequest.op === "state_work" ||
      serviceRequest.op === "publish_file"
    ) {
      writeJson(response, 403, { error: "op_is_local_to_the_machine" });
      return true;
    }
    const questionOp =
      serviceRequest.op === "project_proposal_get" ||
      serviceRequest.op === "project_proposal_confirm" ||
      serviceRequest.op === "input_get" ||
      serviceRequest.op === "input_answer" ||
      serviceRequest.op === "input_cancel";
    const workWriteOp =
      serviceRequest.op === "work_item_write" || serviceRequest.op === "work_item_write_receipt";
    const grant =
      serviceRequest.op === "terminal_tail" || serviceRequest.op === "terminal_catalog"
        ? "terminalObserve"
        : questionOp ||
            workWriteOp ||
            serviceRequest.op === "terminal_control" ||
            serviceRequest.op === "terminal_input"
          ? "terminalControl"
          : serviceRequest.op === "connections" ||
              serviceRequest.op === "reset" ||
              serviceRequest.op === "close_seat" ||
              serviceRequest.op === "spawn_seat" ||
              serviceRequest.op === "move_seat" ||
              serviceRequest.op === "channel" ||
              serviceRequest.op === "update_persona" ||
              serviceRequest.op === "set_persona_role" ||
              serviceRequest.op === "discord_rooms"
            ? // Hiring is at least as consequential as closing: it starts a
              // process on the operator's machine. Moving is both at once — it
              // closes a pane and starts a process — so it rides the same grant
              // rather than falling through to chat. Listing the home guild's
              // rooms rides the grant of the projection it is picked for, so a
              // chat-only device never enumerates the owner's server.
              "steer"
            : "chat";
    // Reading a request may span sleep or a control-plane restart. Admission
    // before that await is not authority to dispatch after it.
    const currentAuthorization = await authorizeGrant(options, token, response, grant);
    if (currentAuthorization === undefined) return true;
    if (path === OPERATOR_CONVERSATION_TAIL_PATH) {
      if (serviceRequest.op !== "tail") {
        writeJson(response, 400, { error: "tail_request_required" });
        return true;
      }
      await streamTail({
        response,
        request: serviceRequest,
        token,
        initialAuthorization: currentAuthorization,
        options,
        logger,
      });
      return true;
    }
    if (path === OPERATOR_TERMINAL_TAIL_PATH) {
      if (serviceRequest.op !== "terminal_tail") {
        writeJson(response, 400, { error: "terminal_tail_request_required" });
        return true;
      }
      await streamTerminalTail({
        response,
        request: serviceRequest,
        token,
        initialAuthorization: currentAuthorization,
        options,
        logger,
      });
      return true;
    }
    if (serviceRequest.op === "terminal_tail") {
      writeJson(response, 400, { error: "terminal_tail_route_required" });
      return true;
    }

    // This lifetime cancels unary HTTP work, never an already committed answer/run.
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    if (request.aborted || response.destroyed) abort.abort();
    const ownerRoute =
      questionOp ||
      workWriteOp ||
      (serviceRequest.op === "send" && currentAuthorization.device.grants.terminalControl);
    try {
      if (abort.signal.aborted) return true;
      if (
        currentAuthorization.device.deviceId !== authorization.device.deviceId ||
        currentAuthorization.device.controlScope !== authorization.device.controlScope
      ) {
        writeAuthDenial(response, "invalid");
        return true;
      }
      if (ownerRoute && options.deviceDispatch === undefined) {
        writeJson(response, 503, { error: "conversation_owner_upstream_unavailable" });
        return true;
      }
      const dispatch = () =>
        ownerRoute &&
        (serviceRequest.op === "work_item_write" ||
          serviceRequest.op === "work_item_write_receipt" ||
          serviceRequest.op === "project_proposal_get" ||
          serviceRequest.op === "project_proposal_confirm" ||
          serviceRequest.op === "input_get" ||
          serviceRequest.op === "input_answer" ||
          serviceRequest.op === "input_cancel" ||
          serviceRequest.op === "send")
          ? options.deviceDispatch!(
              serviceRequest,
              {
                deviceToken: token,
                ...(currentAuthorization.device.controlScope === undefined
                  ? {}
                  : { controlScope: currentAuthorization.device.controlScope }),
              },
              abort.signal,
            )
          : serviceRequest.op === "send" || serviceRequest.op === "presence"
            ? options.dispatch(serviceRequest, abort.signal)
            : options.dispatch(serviceRequest);
      const result =
        serviceRequest.op === "send"
          ? await idempotency.run(currentAuthorization.device.deviceId, serviceRequest, dispatch)
          : await dispatch();
      if (abort.signal.aborted) return true;
      // Recheck even a retained send receipt. Never downgrade owner authority
      // after a dispatch, or route/retry a write under another principal.
      const fresh = await authorizeGrant(options, token, response, grant);
      if (fresh === undefined || abort.signal.aborted) return true;
      if (
        fresh.device.deviceId !== currentAuthorization.device.deviceId ||
        fresh.device.controlScope !== currentAuthorization.device.controlScope
      ) {
        writeAuthDenial(response, "invalid");
        return true;
      }
      if (ownerRoute && !fresh.device.grants.terminalControl) {
        writeGrantDenial(response, "terminalControl");
        return true;
      }
      const publicResult = publicServiceResult(result);
      writeJson(response, 200, publicResult);
      logger.info(logFields(authorization, serviceRequest, 200, publicResult), "conversation relay request");
    } catch (error) {
      if (abort.signal.aborted) return true;
      const status = ownerRoute && error instanceof DeviceConversationRefusal ? error.status : 502;
      writeJson(response, status, {
        error: status === 502 ? "conversation_upstream_unavailable" : "conversation_owner_upstream_refused",
      });
      logger.warn(logFields(authorization, serviceRequest, status), "conversation relay upstream failure");
    } finally {
      request.off("aborted", disconnected);
      response.off("close", disconnected);
    }
    return true;
  };
}

/** Recheck both the ordinary bearer and live operation grant; never cache either. */
async function authorizeGrant(
  options: OperatorConversationRelayOptions,
  token: string,
  response: ServerResponse,
  grant: "chat" | "steer" | "terminalObserve" | "terminalControl",
): Promise<Extract<RelayDeviceAuthorization, { authorized: true }> | undefined> {
  const authorization = await options.authorizeDevice.authorize(token);
  if (!authorization.authorized) {
    writeAuthDenial(response, authorization.denial);
    return undefined;
  }
  if (!authorization.device.grants[grant]) {
    writeGrantDenial(response, grant);
    return undefined;
  }
  return authorization;
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
          conversationId: redactSensitiveString(request.tail.conversationId),
          surfaceClientId: redactSensitiveString(request.tail.surfaceClientId),
          denial: authorization.denial,
        },
        "conversation tail authorization revoked",
      );
      await writeTailAuthFailure(response, authorization.denial);
      return;
    }
    if (!authorization.device.grants.chat) {
      logger.warn(
        {
          route: "tail",
          conversationId: redactSensitiveString(request.tail.conversationId),
          surfaceClientId: redactSensitiveString(request.tail.surfaceClientId),
          denial: "chat_grant_required",
        },
        "conversation tail authorization revoked",
      );
      await writeTailAuthFailure(response, "chat_grant_required");
      return;
    }
    let result: OperatorConversationServiceResult;
    try {
      result = publicServiceResult(
        await options.dispatch({
          ...request,
          tail: { ...request.tail, ...(cursor === undefined ? {} : { cursor }) },
        }),
      );
    } catch {
      logger.warn(
        {
          route: "tail",
          deviceId: redactSensitiveString(authorization.device.deviceId),
          conversationId: redactSensitiveString(request.tail.conversationId),
          surfaceClientId: redactSensitiveString(request.tail.surfaceClientId),
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
    authorization = await options.authorizeDevice.authorize(input.token);
    const emissionDenial = tailAuthorizationDenial(authorization, "chat");
    if (emissionDenial !== undefined) {
      logger.warn(
        {
          route: "tail",
          conversationId: redactSensitiveString(request.tail.conversationId),
          surfaceClientId: redactSensitiveString(request.tail.surfaceClientId),
          denial: emissionDenial,
        },
        "conversation tail authorization revoked",
      );
      await writeTailAuthFailure(response, emissionDenial);
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

interface StreamTerminalTailInput {
  readonly response: ServerResponse;
  readonly request: Extract<OperatorConversationServiceRequest, { op: "terminal_tail" }>;
  readonly token: string;
  readonly initialAuthorization: Extract<RelayDeviceAuthorization, { authorized: true }>;
  readonly options: OperatorConversationRelayOptions;
  readonly logger: RelayConversationLogger;
}

async function streamTerminalTail(input: StreamTerminalTailInput): Promise<void> {
  const { response, request, options, logger } = input;
  response.statusCode = 200;
  response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  let cursor = request.observation.cursor;
  let pages = 0;
  let authorization: RelayDeviceAuthorization = input.initialAuthorization;
  while (!response.destroyed) {
    if (pages > 0) authorization = await options.authorizeDevice.authorize(input.token);
    const pollDenial = tailAuthorizationDenial(authorization, "terminalObserve");
    if (pollDenial !== undefined) {
      logger.warn(
        {
          route: "terminal_tail",
          terminalId: redactSensitiveString(request.observation.terminalId),
          surfaceClientId: redactSensitiveString(request.observation.surfaceClientId),
          denial: pollDenial,
        },
        "terminal tail authorization revoked",
      );
      await writeTailAuthFailure(response, pollDenial);
      return;
    }

    let result: OperatorConversationServiceResult;
    try {
      result = publicServiceResult(
        await options.dispatch({
          ...request,
          observation: {
            ...request.observation,
            ...(cursor === undefined ? {} : { cursor }),
          },
        }),
      );
    } catch {
      logger.warn(
        {
          route: "terminal_tail",
          terminalId: redactSensitiveString(request.observation.terminalId),
          surfaceClientId: redactSensitiveString(request.observation.surfaceClientId),
        },
        "terminal tail upstream failure",
      );
      response.destroy();
      return;
    }
    if (result.op !== "terminal_tail") {
      response.destroy();
      return;
    }

    authorization = await options.authorizeDevice.authorize(input.token);
    const emissionDenial = tailAuthorizationDenial(authorization, "terminalObserve");
    if (emissionDenial !== undefined) {
      logger.warn(
        {
          route: "terminal_tail",
          terminalId: redactSensitiveString(request.observation.terminalId),
          surfaceClientId: redactSensitiveString(request.observation.surfaceClientId),
          denial: emissionDenial,
        },
        "terminal tail authorization revoked",
      );
      await writeTailAuthFailure(response, emissionDenial);
      return;
    }

    const page = result.result;
    if (page.status === "reset") {
      await writeNdjson(response, { kind: "reset", reset: page });
      response.end();
      return;
    }
    if (page.status === "unavailable") {
      await writeNdjson(response, { kind: "unavailable", unavailable: page });
      response.end();
      return;
    }
    for (const frame of page.frames) {
      await writeNdjson(response, { kind: "frame", streamId: page.cursor.streamId, frame });
    }
    cursor = page.cursor;
    pages += 1;
    if (options.tailMaxPages !== undefined && pages >= options.tailMaxPages) {
      response.end();
      return;
    }
    if (page.frames.length === 0) await sleep(options.tailPollMs ?? 250);
  }
}

class TurnIdempotencyStore {
  private readonly entries = new Map<
    string,
    { readonly expiresAt: number; readonly result: Promise<OperatorConversationServiceResult> }
  >();
  private readonly clock: () => number;

  public constructor(clock: () => number) {
    this.clock = clock;
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
    const result = dispatch()
      .then((value) => {
        if (value.op === "send" && value.result.status === "seat_offline") this.entries.delete(key);
        return value;
      })
      .catch((error: unknown) => {
        this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, { expiresAt: this.clock() + IDEMPOTENCY_TTL_MS, result });
    while (this.entries.size > IDEMPOTENCY_MAX_ENTRIES) {
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
    request.op === "get" ||
    request.op === "reset" ||
    request.op === "close" ||
    request.op === "close_seat" ||
    request.op === "react"
      ? request
      : request.op === "replay" || request.op === "subagent_replay"
        ? request.replay
        : request.op === "tail"
          ? request.tail
          : request.op === "send"
            ? request.turn
            : request.op === "terminal_tail"
              ? request.observation
              : undefined;
  const resultStatus =
    result?.op === "send"
      ? result.result.status
      : result?.op === "replay" || result?.op === "subagent_replay" || result?.op === "tail"
        ? result.result.status
        : result?.op === "terminal_tail"
          ? result.result.status
          : undefined;
  return {
    service: "clankie-relay",
    route:
      request.op === "terminal_tail" || request.op === "terminal_catalog"
        ? "operator_terminal"
        : "operator_conversation",
    op: request.op,
    deviceId: redactSensitiveString(authorization.device.deviceId),
    statusCode,
    ...(subject === undefined || !("conversationId" in subject)
      ? {}
      : { conversationId: redactSensitiveString(subject.conversationId) }),
    ...(subject === undefined || !("surfaceClientId" in subject)
      ? {}
      : { surfaceClientId: redactSensitiveString(subject.surfaceClientId) }),
    ...(subject === undefined || !("terminalId" in subject)
      ? {}
      : { terminalId: redactSensitiveString(subject.terminalId) }),
    ...(subject === undefined || !("seatId" in subject)
      ? {}
      : { seatId: redactSensitiveString(subject.seatId) }),
    ...(resultStatus === undefined ? {} : { resultStatus }),
  };
}

type DispatchGrant = "chat" | "steer" | "terminalObserve" | "terminalControl";
type StreamGrant = "chat" | "terminalObserve";

function tailAuthorizationDenial(
  authorization: RelayDeviceAuthorization,
  grant: StreamGrant,
): string | undefined {
  if (!authorization.authorized) return authorization.denial;
  if (authorization.device.grants[grant]) return undefined;
  return grant === "chat" ? "chat_grant_required" : "terminal_observe_grant_required";
}

async function writeTailAuthFailure(response: ServerResponse, reason: string): Promise<void> {
  await writeNdjson(response, {
    kind: "auth_failure",
    failure: { schemaVersion: 1, outcome: "auth_failed", reason },
  });
  response.end();
}

function publicServiceResult(value: unknown): OperatorConversationServiceResult {
  const parsed = OperatorConversationServiceResultSchema.parse(value);
  return OperatorConversationServiceResultSchema.parse(redactPublicValue(parsed));
}

function redactPublicValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveString(value);
  if (Array.isArray(value)) return value.map(redactPublicValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactPublicValue(entry)]),
  );
}

/** Mirrors the runner transcript authorization/token/credential redaction classes at the relay boundary. */
function redactSensitiveString(value: string): string {
  return value
    .replace(/\bauthorization\s*:\s*(?:bearer|basic)\s+[^\s,;]+/giu, "authorization: [REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[_A-Za-z0-9-]{8,}/gu, "[REDACTED]")
    .replace(
      /\b(?:(?:eve[_ -]?)?session(?:[_ -]?(?:id|token))?|(?:access|refresh|continuation)[_ -]?token|api[_ -]?key|provider[_ -]?credential|password|passwd|secret|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "[REDACTED]",
    );
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

function writeGrantDenial(response: ServerResponse, grant: DispatchGrant): void {
  writeJson(response, 403, {
    error:
      grant === "chat"
        ? "chat_grant_required"
        : grant === "steer"
          ? "steer_grant_required"
          : grant === "terminalControl"
            ? "terminal_control_grant_required"
            : "terminal_observe_grant_required",
  });
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
