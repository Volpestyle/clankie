import {
  APPEARANCE_SETTINGS_PATH,
  AppearanceSettingsSnapshotSchema,
  UpdateAppearanceSettingsSchema,
  HOST_SETTINGS_PATH,
  HostSettingsSnapshotSchema,
  UpdateHostSettingsSchema,
  OwnerVoiceSnapshotSchema,
  OwnerVoiceUpdateSchema,
} from "../../../packages/protocol/src/owner-settings.ts";
import {
  LINEAR_FOLLOW_PATH,
  LINEAR_WAKE_PATH,
  LinearWakeUpdateSchema,
  LinearWakeSnapshotSchema,
  LinearFollowUpdateSchema,
  LinearFollowSnapshotSchema,
} from "../../../packages/protocol/src/linear-settings.ts";
import { DeviceConversationRefusal, type DeviceConversationDispatch } from "./conversation-upstream.ts";
import { supportReadOperationAllowed } from "../../../packages/protocol/src/support-access.ts";
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
  FLEET_HIRE_DEFAULTS_PATH,
  FLEET_SETTINGS_PATH,
  FleetHireDefaultsSnapshotSchema,
  FleetSettingsSnapshotSchema,
  UpdateFleetHireDefaultsSchema,
  UpdateFleetSettingsSchema,
} from "../../../packages/protocol/src/fleet-settings.ts";
import {
  OPERATOR_PERSONA_PATH,
  PersonaAttentionSnapshotSchema,
  PersonaAttentionUpdateSchema,
} from "../../../packages/protocol/src/discord-attention.ts";
import {
  MachineWorkerAccountsSchema,
  WORKER_ACCOUNTS_PATH,
  WORKER_ACCOUNT_HOLDS_PATH,
  WorkerAccountHoldRequestSchema,
  WorkerAccountHoldsSchema,
  USAGE_PATH,
  USAGE_SETTINGS_PATH,
  UsageReportSchema,
  UsageSettingsSnapshotSchema,
  UpdateUsageSettingsSchema,
} from "../../../packages/protocol/src/worker-accounts.ts";
import {
  CloseHuddleSchema,
  HUDDLE_CLOSE_PATH,
  HUDDLES_PATH,
  HuddleSchema,
  HuddlesResponseSchema,
  StartHuddleSchema,
} from "../../../packages/protocol/src/huddles.ts";
import {
  isViewRoute,
  VIEWS_PATH,
  ViewRenderSchema,
  ViewRequestSchema,
  ViewsResponseSchema,
} from "../../../packages/protocol/src/views.ts";
import {
  PROJECTS_PATH,
  PROJECT_UPDATE_SETTINGS_PATH,
  ProjectsSnapshotSchema,
  UpdateProjectSettingsSchema,
} from "../../../packages/protocol/src/projects.ts";
import {
  DISCORD_DIRECTORY_PATH,
  DiscordDirectorySnapshotSchema,
  DISCORD_SETUP_TEST_POST_PATH,
  DiscordSetupTestPostRequestSchema,
  DiscordSetupTestPostResultSchema,
  safeParseProtocolResponse,
} from "../../../packages/protocol/src/index.ts";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { ConversationTailHub } from "./conversation-tail-hub.ts";
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
  /** Room and owner settings routes forward the original device; never captain authority. */
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
 * Every route this boundary owns for a paired device. A device reaching its
 * host through the public gateway can only use routes the gateway forwards,
 * so the relay tests hold this list against `PUBLIC_GATEWAY_ROUTES`.
 */
export const OPERATOR_RELAY_DEVICE_ROUTES = [
  { method: "POST", path: OPERATOR_CONVERSATION_DISPATCH_PATH },
  { method: "POST", path: OPERATOR_CONVERSATION_TAIL_PATH },
  { method: "POST", path: OPERATOR_TERMINAL_TAIL_PATH },
  { method: "POST", path: OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH },
  { method: "GET", path: BODY_LEASE_STATUS_PATH },
  { method: "GET", path: DISCORD_ROOMS_PATH },
  { method: "GET", path: DISCORD_SETTINGS_PATH },
  { method: "GET", path: DISCORD_DIRECTORY_PATH },
  { method: "GET", path: DISCORD_ROOM_VOICE_PATH },
  { method: "GET", path: DISCORD_VOICE_TRANSCRIPTS_PATH },
  { method: "POST", path: DISCORD_ROOM_GUIDANCE_PATH },
  { method: "POST", path: DISCORD_SETUP_TEST_POST_PATH },
  { method: "GET", path: FLEET_SETTINGS_PATH },
  { method: "POST", path: FLEET_SETTINGS_PATH },
  { method: "GET", path: FLEET_HIRE_DEFAULTS_PATH },
  { method: "POST", path: FLEET_HIRE_DEFAULTS_PATH },
  { method: "GET", path: OPERATOR_PERSONA_PATH },
  { method: "POST", path: OPERATOR_PERSONA_PATH },
  { method: "GET", path: WORKER_ACCOUNTS_PATH },
  { method: "GET", path: WORKER_ACCOUNT_HOLDS_PATH },
  { method: "POST", path: WORKER_ACCOUNT_HOLDS_PATH },
  { method: "GET", path: USAGE_PATH },
  { method: "GET", path: USAGE_SETTINGS_PATH },
  { method: "POST", path: USAGE_SETTINGS_PATH },
  { method: "GET", path: HUDDLES_PATH },
  { method: "POST", path: HUDDLES_PATH },
  { method: "POST", path: HUDDLE_CLOSE_PATH },
  { method: "GET", path: VIEWS_PATH },
  { method: "POST", path: VIEWS_PATH },
  { method: "GET", path: LINEAR_FOLLOW_PATH },
  { method: "POST", path: LINEAR_FOLLOW_PATH },
  { method: "GET", path: LINEAR_WAKE_PATH },
  { method: "POST", path: LINEAR_WAKE_PATH },
  { method: "GET", path: HOST_SETTINGS_PATH },
  { method: "POST", path: HOST_SETTINGS_PATH },
  { method: "GET", path: APPEARANCE_SETTINGS_PATH },
  { method: "POST", path: APPEARANCE_SETTINGS_PATH },
  { method: "GET", path: "/v1/operator/voice" },
  { method: "POST", path: "/v1/operator/voice" },
  { method: "GET", path: PROJECTS_PATH },
  { method: "POST", path: PROJECT_UPDATE_SETTINGS_PATH },
] as const;

interface ParseSchema {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false };
}
/**
 * Owner settings a device holding terminal control may read and change. Each
 * request and answer is held to its protocol schema, so the relay never
 * forwards more than the route names (a persona patch is talkativeness only).
 */
const OWNER_SETTINGS_ROUTES: Readonly<
  Record<
    string,
    { readonly methods: readonly string[]; readonly update?: ParseSchema; readonly snapshot: ParseSchema }
  >
> = {
  [HOST_SETTINGS_PATH]: {
    methods: ["GET", "POST"],
    update: UpdateHostSettingsSchema,
    snapshot: HostSettingsSnapshotSchema,
  },
  [APPEARANCE_SETTINGS_PATH]: {
    methods: ["GET", "POST"],
    update: UpdateAppearanceSettingsSchema,
    snapshot: AppearanceSettingsSnapshotSchema,
  },
  ["/v1/operator/voice"]: {
    methods: ["GET", "POST"],
    update: OwnerVoiceUpdateSchema,
    snapshot: OwnerVoiceSnapshotSchema,
  },
  [LINEAR_FOLLOW_PATH]: {
    methods: ["GET", "POST"],
    update: LinearFollowUpdateSchema,
    snapshot: LinearFollowSnapshotSchema,
  },
  [LINEAR_WAKE_PATH]: {
    methods: ["GET", "POST"],
    update: LinearWakeUpdateSchema,
    snapshot: LinearWakeSnapshotSchema,
  },
  [FLEET_SETTINGS_PATH]: {
    methods: ["GET", "POST"],
    update: UpdateFleetSettingsSchema,
    snapshot: FleetSettingsSnapshotSchema,
  },
  [FLEET_HIRE_DEFAULTS_PATH]: {
    methods: ["GET", "POST"],
    update: UpdateFleetHireDefaultsSchema,
    snapshot: FleetHireDefaultsSnapshotSchema,
  },
  [OPERATOR_PERSONA_PATH]: {
    methods: ["GET", "POST"],
    update: PersonaAttentionUpdateSchema,
    snapshot: PersonaAttentionSnapshotSchema,
  },
  [WORKER_ACCOUNTS_PATH]: { methods: ["GET"], snapshot: MachineWorkerAccountsSchema },
  [WORKER_ACCOUNT_HOLDS_PATH]: {
    methods: ["GET", "POST"],
    update: WorkerAccountHoldRequestSchema,
    snapshot: WorkerAccountHoldsSchema,
  },
  [USAGE_PATH]: { methods: ["GET"], snapshot: UsageReportSchema },
  [USAGE_SETTINGS_PATH]: {
    methods: ["GET", "POST"],
    update: UpdateUsageSettingsSchema,
    snapshot: UsageSettingsSnapshotSchema,
  },
  [HUDDLES_PATH]: { methods: ["GET", "POST"], update: StartHuddleSchema, snapshot: HuddlesResponseSchema },
  [HUDDLE_CLOSE_PATH]: { methods: ["POST"], update: CloseHuddleSchema, snapshot: HuddleSchema },
  [VIEWS_PATH]: { methods: ["GET", "POST"], update: ViewRequestSchema, snapshot: ViewsResponseSchema },
  [PROJECTS_PATH]: { methods: ["GET"], snapshot: ProjectsSnapshotSchema },
  [PROJECT_UPDATE_SETTINGS_PATH]: {
    methods: ["POST"],
    update: UpdateProjectSettingsSchema,
    snapshot: ProjectsSnapshotSchema,
  },
};

/** `GET /v1/operator/views/:id`, the one parameterized owner route (VUH-2042). */
const VIEW_RENDER_ROUTE: (typeof OWNER_SETTINGS_ROUTES)[string] = {
  methods: ["GET"],
  snapshot: ViewRenderSchema,
};

/**
 * Authenticated HTTP/NDJSON projection of the callable operator contract.
 * Returns true only for routes this boundary owns.
 */
export function createOperatorConversationRelayHandler(options: OperatorConversationRelayOptions) {
  const logger = options.logger ?? silentLogger;
  const idempotency = new TurnIdempotencyStore(options.clock ?? Date.now);
  const tails = new ConversationTailHub(async (request, signal) =>
    publicServiceResult(await options.dispatch(request, signal)),
  );
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = requestUrl(request).pathname;
    const settingsRoute = Object.hasOwn(OWNER_SETTINGS_ROUTES, path)
      ? OWNER_SETTINGS_ROUTES[path]
      : isViewRoute(path)
        ? VIEW_RENDER_ROUTE
        : undefined;
    if (settingsRoute !== undefined) {
      response.setHeader("cache-control", "no-store");
      const method = request.method;
      if ((method !== "GET" && method !== "POST") || !settingsRoute.methods.includes(method)) {
        writeJson(response, 405, { error: "method_not_allowed" });
        return true;
      }
      const route = `${path}${requestUrl(request).search}`;
      if (!hostedOperatorAllows(method, route)) {
        writeJson(response, 400, { error: "invalid_settings_route" });
        return true;
      }
      const token = bearerToken(request);
      if (token === undefined) {
        writeAuthDenial(response, "invalid");
        return true;
      }
      const initial = await authorizeGrant(options, token, response, "terminalControl");
      if (!initial) return true;
      if (!options.roomRequest) {
        writeJson(response, 503, { error: "settings_upstream_unavailable" });
        return true;
      }
      let body: string | undefined;
      if (method === "POST") {
        const input = await readJson(request).catch(() => undefined);
        const parsed = settingsRoute.update?.safeParse(input) ?? { success: false as const };
        if (!parsed.success) {
          writeJson(response, 400, { error: "invalid_settings_update" });
          return true;
        }
        body = JSON.stringify(parsed.data);
      }
      const before = await authorizeGrant(options, token, response, "terminalControl");
      if (!before) return true;
      if (
        before.device.deviceId !== initial.device.deviceId ||
        before.device.controlScope !== initial.device.controlScope
      ) {
        writeAuthDenial(response, "invalid");
        return true;
      }
      try {
        const upstream = await options.roomRequest(route, method, token, body);
        const data: unknown = await upstream.json();
        const after = await authorizeGrant(options, token, response, "terminalControl");
        if (!after) return true;
        if (
          after.device.deviceId !== before.device.deviceId ||
          after.device.controlScope !== before.device.controlScope
        ) {
          writeAuthDenial(response, "invalid");
          return true;
        }
        if (!upstream.ok) {
          // Only this documented partial-success receipt survives refusal projection.
          // Validate the saved snapshot; arbitrary upstream error payloads stay private.
          if (
            path === HOST_SETTINGS_PATH &&
            upstream.status === 503 &&
            data !== null &&
            typeof data === "object" &&
            !Array.isArray(data)
          ) {
            const receipt = data as Record<string, unknown>;
            const saved = HostSettingsSnapshotSchema.safeParse(receipt.settings);
            if (
              receipt.error === "keep_awake_apply_failed" &&
              receipt.saved === true &&
              Object.keys(receipt).every((key) => ["error", "saved", "settings"].includes(key)) &&
              saved.success
            ) {
              writeJson(response, 503, {
                error: "keep_awake_apply_failed",
                saved: true,
                settings: saved.data,
              });
              return true;
            }
          }
          writeJson(response, upstream.status, { error: "settings_upstream_refused" });
          return true;
        }
        const parsed = settingsRoute.snapshot.safeParse(data);
        writeJson(
          response,
          parsed.success ? 200 : 502,
          parsed.success ? parsed.data : { error: "invalid_settings_response" },
        );
      } catch {
        writeJson(response, 502, { error: "settings_upstream_unavailable" });
      }
      return true;
    }
    const roomRoute =
      path === DISCORD_ROOMS_PATH ||
      path === DISCORD_ROOM_GUIDANCE_PATH ||
      path === DISCORD_SETTINGS_PATH ||
      path === DISCORD_DIRECTORY_PATH ||
      path === DISCORD_SETUP_TEST_POST_PATH ||
      path === DISCORD_ROOM_VOICE_PATH ||
      path === DISCORD_VOICE_TRANSCRIPTS_PATH;
    if (roomRoute) {
      const method =
        path === DISCORD_ROOM_GUIDANCE_PATH || path === DISCORD_SETUP_TEST_POST_PATH ? "POST" : "GET";
      if (request.method !== method) {
        writeJson(response, 405, { error: "method_not_allowed" });
        return true;
      }
      const token = bearerToken(request);
      if (token === undefined) {
        writeAuthDenial(response, "invalid");
        return true;
      }
      const grant =
        path === DISCORD_SETUP_TEST_POST_PATH
          ? "terminalControl"
          : path === DISCORD_ROOM_GUIDANCE_PATH
            ? "steer"
            : "terminalObserve";
      if (!(await authorizeGrant(options, token, response, grant))) return true;
      if (!options.roomRequest) {
        writeJson(response, 503, { error: "room_route_unavailable" });
        return true;
      }
      let body: string | undefined;
      if (method === "POST") {
        const parsed = (
          path === DISCORD_SETUP_TEST_POST_PATH
            ? DiscordSetupTestPostRequestSchema
            : DiscordRoomGuidanceRequestSchema
        ).safeParse(await readJson(request));
        if (!parsed.success) {
          writeJson(response, 400, {
            error:
              path === DISCORD_SETUP_TEST_POST_PATH ? "invalid_discord_test_post" : "invalid_room_guidance",
          });
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
        path === DISCORD_SETUP_TEST_POST_PATH
          ? DiscordSetupTestPostResultSchema
          : path === DISCORD_ROOMS_PATH
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
    const nativeMessageOp = serviceRequest.op === "pending_messages" || serviceRequest.op === "stop_task";
    const questionOp =
      serviceRequest.op === "project_proposal_get" ||
      serviceRequest.op === "project_proposal_confirm" ||
      serviceRequest.op === "project_proposal_tweak" ||
      serviceRequest.op === "input_list" ||
      serviceRequest.op === "input_get" ||
      serviceRequest.op === "input_answer" ||
      serviceRequest.op === "input_cancel";
    const workWriteOp =
      serviceRequest.op === "work_item_write" ||
      serviceRequest.op === "work_item_write_receipt" ||
      (serviceRequest.op === "tracker_sync" && serviceRequest.command.action === "transaction");
    const grant =
      serviceRequest.op === "terminal_tail" || serviceRequest.op === "terminal_catalog"
        ? "terminalObserve"
        : nativeMessageOp ||
            questionOp ||
            workWriteOp ||
            serviceRequest.op === "terminal_control" ||
            serviceRequest.op === "terminal_input"
          ? "terminalControl"
          : serviceRequest.op === "connections" ||
              serviceRequest.op === "reset" ||
              serviceRequest.op === "close_seat" ||
              serviceRequest.op === "readopt_seat" ||
              serviceRequest.op === "worker_reports" ||
              serviceRequest.op === "acknowledge_worker_reports" ||
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
              // Native re-adoption and retained worker reports likewise belong
              // to the lead: reading exposes machine work, and ACK clears its
              // unread report marker.
              "steer"
            : "chat";
    // Reading a request may span sleep or a control-plane restart. Admission
    // before that await is not authority to dispatch after it.
    const currentAuthorization = await authorizeGrant(options, token, response, grant, serviceRequest.op);
    if (currentAuthorization === undefined) return true;
    if (path === OPERATOR_CONVERSATION_TAIL_PATH && serviceRequest.op === "tracker_sync") {
      if (serviceRequest.command.action !== "subscribe") {
        writeJson(response, 400, { error: "subscription_required" });
        return true;
      }
      await streamTrackerSync(response, serviceRequest, token, currentAuthorization, options);
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
        initialAuthorization: currentAuthorization,
        options,
        logger,
        tails,
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
    // Recorded evidence bytes are owner-device reads: the service checks the
    // device's own signed identity, so a captain bearer can never fetch them.
    const ownerRoute =
      nativeMessageOp ||
      questionOp ||
      workWriteOp ||
      serviceRequest.op === "tracker_sync" ||
      serviceRequest.op === "evidence_fetch" ||
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
        (serviceRequest.op === "pending_messages" ||
          serviceRequest.op === "stop_task" ||
          serviceRequest.op === "work_item_write" ||
          serviceRequest.op === "work_item_write_receipt" ||
          serviceRequest.op === "tracker_sync" ||
          serviceRequest.op === "evidence_fetch" ||
          serviceRequest.op === "project_proposal_get" ||
          serviceRequest.op === "project_proposal_confirm" ||
          serviceRequest.op === "project_proposal_tweak" ||
          serviceRequest.op === "input_list" ||
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
          : serviceRequest.op === "tail"
            ? readTail(tails, serviceRequest, abort.signal)
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
      const fresh = await authorizeGrant(options, token, response, grant, serviceRequest.op);
      if (fresh === undefined || abort.signal.aborted) return true;
      if (
        fresh.device.deviceId !== currentAuthorization.device.deviceId ||
        fresh.device.controlScope !== currentAuthorization.device.controlScope
      ) {
        writeAuthDenial(response, "invalid");
        return true;
      }
      if (ownerRoute && serviceRequest.op !== "tracker_sync" && !fresh.device.grants.terminalControl) {
        writeGrantDenial(response, "terminalControl");
        return true;
      }
      const publicResult = publicServiceResult(result);
      if (publicResult.op === "tracker_sync" && publicResult.result.outcome === "bootstrap") {
        response.statusCode = 200;
        response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(publicResult.result.ndjson);
      } else writeJson(response, 200, publicResult);
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
  op?: string,
): Promise<Extract<RelayDeviceAuthorization, { authorized: true }> | undefined> {
  const authorization = await options.authorizeDevice.authorize(token);
  if (!authorization.authorized) {
    writeAuthDenial(response, authorization.denial);
    return undefined;
  }
  if (authorization.device.supportGrantId !== undefined) {
    if (
      op === undefined ||
      authorization.device.supportScope !== "read-state" ||
      !supportReadOperationAllowed(op, authorization.device.supportScope)
    ) {
      writeGrantDenial(response, grant);
      return undefined;
    }
  } else if (!authorization.device.grants[grant]) {
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
  readonly tails: ConversationTailHub;
}

async function readTail(
  tails: ConversationTailHub,
  request: Extract<OperatorConversationServiceRequest, { op: "tail" }>,
  signal: AbortSignal,
): Promise<OperatorConversationServiceResult> {
  const subscription = tails.subscribe(request, signal);
  try {
    return await subscription.read(request);
  } finally {
    subscription.close();
  }
}

/** The existing tail route also carries tracker commits; waits are awakened by atomic writes. */
async function streamTrackerSync(
  response: import("node:http").ServerResponse,
  request: Extract<OperatorConversationServiceRequest, { op: "tracker_sync" }>,
  token: string,
  initial: Extract<RelayDeviceAuthorization, { authorized: true }>,
  options: OperatorConversationRelayOptions,
): Promise<void> {
  if (request.command.action !== "subscribe" || !options.deviceDispatch) {
    writeJson(response, 503, { error: "tracker_subscription_unavailable" });
    return;
  }
  const abort = new AbortController();
  const disconnected = () => abort.abort();
  response.once("close", disconnected);
  response.statusCode = 200;
  response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.flushHeaders();
  let lastSyncId = request.command.lastSyncId;
  let pages = 0;
  try {
    while (!response.destroyed && !abort.signal.aborted) {
      const current = await options.authorizeDevice.authorize(token);
      if (
        !current.authorized ||
        !current.device.grants.chat ||
        current.device.deviceId !== initial.device.deviceId ||
        current.device.controlScope !== initial.device.controlScope
      ) {
        await writeTailAuthFailure(response, "chat_grant_required");
        return;
      }
      const result = await options.deviceDispatch(
        { ...request, command: { ...request.command, lastSyncId, waitMs: 20_000 } },
        {
          deviceToken: token,
          ...(current.device.controlScope ? { controlScope: current.device.controlScope } : {}),
        },
        abort.signal,
      );
      if (abort.signal.aborted) return;
      const fresh = await options.authorizeDevice.authorize(token);
      if (
        !fresh.authorized ||
        !fresh.device.grants.chat ||
        fresh.device.deviceId !== initial.device.deviceId ||
        fresh.device.controlScope !== initial.device.controlScope
      ) {
        await writeTailAuthFailure(response, "chat_grant_required");
        return;
      }
      if (result.op !== "tracker_sync") throw new Error("Unexpected tracker subscription result");
      // Sync fields must round-trip unchanged; transcript redaction cannot rewrite object IDs or bodies.
      await writeNdjson(response, { kind: "tracker_sync", result: result.result });
      if (result.result.outcome !== "deltas") {
        response.end();
        return;
      }
      lastSyncId = result.result.lastSyncId;
      pages++;
      if (options.tailMaxPages && pages >= options.tailMaxPages) {
        response.end();
        return;
      }
    }
  } catch {
    if (!abort.signal.aborted) response.destroy();
  } finally {
    abort.abort();
    response.off("close", disconnected);
  }
}

async function streamTail(input: StreamTailInput): Promise<void> {
  const { response, request, options, logger } = input;
  response.statusCode = 200;
  response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  let cursor = request.tail.cursor;
  let liveSequence = request.tail.liveSequence;
  let pages = 0;
  let authorization: RelayDeviceAuthorization = input.initialAuthorization;
  const abort = new AbortController();
  const disconnected = () => abort.abort();
  response.once("close", disconnected);
  if (response.destroyed) abort.abort();
  const subscription = input.tails.subscribe(request, abort.signal);
  try {
    while (!response.destroyed && !abort.signal.aborted) {
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
      if (!authorization.device.grants.chat && authorization.device.supportGrantId === undefined) {
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
        result = await subscription.read({
          ...request,
          tail: {
            ...request.tail,
            ...(cursor === undefined ? {} : { cursor }),
            ...(liveSequence === undefined ? {} : { liveSequence }),
            waitMs: request.tail.waitMs ?? options.tailPollMs ?? 250,
          },
        });
      } catch {
        if (abort.signal.aborted) return;
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
      for (const event of page.events) {
        const fresh = await options.authorizeDevice.authorize(input.token);
        const denial = tailAuthorizationDenial(fresh, "chat");
        if (denial !== undefined) {
          await writeTailAuthFailure(response, denial);
          return;
        }
        await writeNdjson(response, { kind: "event", event });
      }
      cursor = page.nextCursor;
      liveSequence = page.live?.sequence ?? 0;
      pages += 1;
      if (options.tailMaxPages !== undefined && pages >= options.tailMaxPages) {
        response.end();
        return;
      }
      if (page.events.length === 0) await sleep(options.tailPollMs ?? 250);
    }
  } finally {
    subscription.close();
    response.off("close", disconnected);
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
      const fresh = await options.authorizeDevice.authorize(input.token);
      const denial = tailAuthorizationDenial(fresh, "terminalObserve");
      if (denial !== undefined) {
        await writeTailAuthFailure(response, denial);
        return;
      }
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
  if (authorization.device.supportGrantId !== undefined) {
    const scope = authorization.device.supportScope;
    return scope === "read-state" &&
      supportReadOperationAllowed(grant === "chat" ? "tail" : "terminal_tail", scope)
      ? undefined
      : "support_scope_required";
  }
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
  // Opaque payloads: redacting inside base64 bytes or an NDJSON bootstrap would corrupt them.
  if (parsed.op === "tracker_sync" || parsed.op === "evidence_fetch") return parsed;
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
