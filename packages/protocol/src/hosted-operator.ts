import { CAPTAIN_SEAT_PATH, CAPTAIN_SEAT_START_PATH, CAPTAIN_SEAT_STATUS_PATH } from "./captain-seat.ts";
import { SHIPPING_PATH } from "./integrate.ts";
import { BODY_TRANSFER_ROUTES } from "./body-transfer.ts";
import { WORK_TRACKER_SETTINGS_PATH } from "./work-tracker-settings.ts";
import {
  APPEARANCE_SETTINGS_PATH,
  EVIDENCE_STORAGE_SETTINGS_PATH,
  HOST_SETTINGS_PATH,
  HTTP_SETTINGS_PATH,
  MAXIMUM_TRUST_MODE_PATH,
} from "./owner-settings.ts";
import { isSkinDraftRoute } from "./skin-drafts.ts";
import { LINEAR_FOLLOW_PATH, LINEAR_WAKE_PATH } from "./linear-settings.ts";
import { hostedDiscordAllows } from "./hosted-discord.ts";
export const HOSTED_OPERATOR_PATH = "/v1/hosted/operator";
import { OperatorConversationServiceRequestSchema } from "./operator-service.ts";
import { FLEET_HIRE_DEFAULTS_PATH, FLEET_SETTINGS_PATH } from "./fleet-settings.ts";
import {
  isWorkerAccountsRoute,
  isUsageReportRoute,
  USAGE_PATH,
  USAGE_SETTINGS_PATH,
  WORKER_ACCOUNT_HOLDS_PATH,
} from "./worker-accounts.ts";
import { HUDDLE_CLOSE_PATH, HUDDLES_PATH } from "./huddles.ts";
import { isViewRoute, VIEWS_PATH } from "./views.ts";
import {
  FLEET_ROSTER_PATH,
  FLEET_ROSTER_WORK_PATH,
  FLEET_ROSTER_RETIRE_PATH,
  FLEET_ROSTER_UNDO_PATH,
} from "./fleet-roster.ts";
import { ROUTINES_PATH } from "./routines.ts";
import { RUNTIME_HEALTH_PATH } from "./runtime-health.ts";
import { OFFICIAL_DISCORD_BODY_PATH } from "./official-discord.ts";
import { PROJECTS_PATH, PROJECT_UPDATE_SETTINGS_PATH } from "./projects.ts";

/** The single hosted-device authority seam. Lifecycle belongs to the account/control plane. */
export function hostedOperatorAllows(method: string, path: string, body?: string): boolean {
  // Moving Clankie between bodies is the owner's own action (ADR 0286).
  if (BODY_TRANSFER_ROUTES.some((route) => route.method === method && route.path === path)) return true;
  if (
    method === "GET" &&
    (path === WORK_TRACKER_SETTINGS_PATH ||
      /^\/v1\/operator\/work-tracker\?projectId=[a-z][a-z0-9_-]{0,63}$/u.test(path))
  )
    return true;
  if (path === CAPTAIN_SEAT_PATH) return method === "GET" || method === "POST";
  if (path === CAPTAIN_SEAT_START_PATH || path === CAPTAIN_SEAT_STATUS_PATH) return method === "POST";
  if (isSkinDraftRoute(method, path)) return true;
  if (hostedDiscordAllows(method, path)) return true;
  // A self-hosted machine's free official bot (VUH-1766); never the edge's web permits.
  if (path === OFFICIAL_DISCORD_BODY_PATH) return method === "GET" || method === "POST";
  // Only this explicit projection query is supported. Unknown, duplicated or
  // encoded queries never acquire authority through URL normalization.
  if (path === `${PROJECTS_PATH}?includeAutonomy=true`) return method === "GET";
  if (path === `${PROJECT_UPDATE_SETTINGS_PATH}?includeAutonomy=true`) return method === "POST";
  if (path === `${FLEET_HIRE_DEFAULTS_PATH}?includeModels=true`) return method === "GET";
  if (
    [
      `${FLEET_SETTINGS_PATH}?includeWorkPolicy=true`,
      `${FLEET_SETTINGS_PATH}?includeMaximumTrust=true`,
      `${FLEET_SETTINGS_PATH}?includeWorkPolicy=true&includeMaximumTrust=true`,
      `${FLEET_SETTINGS_PATH}?includeMaximumTrust=true&includeWorkPolicy=true`,
    ].includes(path)
  )
    return method === "GET" || method === "POST";
  // Worker accounts read one machine through the only query that route accepts.
  if (isWorkerAccountsRoute(path)) return method === "GET";
  if (isUsageReportRoute(path)) return method === "GET";
  if (path === FLEET_ROSTER_WORK_PATH) return method === "GET";
  if (isViewRoute(path)) return method === "GET";
  if (path === "/operator/v1/dispatch" && method === "POST") {
    let value: unknown;
    try {
      value = JSON.parse(body ?? "");
    } catch {
      return false;
    }
    const request = OperatorConversationServiceRequestSchema.safeParse(value);
    return (
      request.success &&
      new Set([
        "connections",
        "list",
        "get",
        "create",
        "fork",
        "close",
        "replay",
        "tail",
        "send",
        "send_receipt",
        "pending_messages",
        "stop_task",
        "project_proposal_get",
        "project_proposal_confirm",
        "project_proposal_tweak",
        "input_get",
        "input_list",
        "owner_update_list",
        "feed_list",
        "owner_update_read",
        "owner_update_dismiss",
        "input_answer",
        "input_cancel",
        "cancel",
        "channel",
        "channels",
        "personas",
        "roles",
        "update_persona",
        "set_persona_role",
        "discord_rooms",
        "work_repos",
        "work_items",
        "work_project",
        "work_project_details",
        "work_item_activity",
        "tracker_sync",
        "evidence_records",
        "evidence_fetch",
        "work_media",
        "lead_chats",
        "fleet_room",
        "evidence_preview",
        "work_item_write",
        "work_item_write_receipt",
        "react",
        "autonomy",
        "roster",
        "fleet",
        "presence",
        "composer_catalog",
        "state_stance",
        "terminal_catalog",
        "close_seat",
        "spawn_seat",
        "move_seat",
        "terminal_tail",
        "terminal_control",
        "terminal_input",
        "publish_file",
        "upload_begin",
        "upload_chunk",
        "upload_commit",
      ]).has(request.data.op)
    );
  }
  const routes: Record<string, readonly string[]> = {
    GET: [
      HTTP_SETTINGS_PATH,
      EVIDENCE_STORAGE_SETTINGS_PATH,
      HOST_SETTINGS_PATH,
      APPEARANCE_SETTINGS_PATH,
      MAXIMUM_TRUST_MODE_PATH,
      "/v1/operator/voice",
      WORKER_ACCOUNT_HOLDS_PATH,
      USAGE_PATH,
      USAGE_SETTINGS_PATH,
      HUDDLES_PATH,
      VIEWS_PATH,
      SHIPPING_PATH,
      FLEET_ROSTER_PATH,
      ROUTINES_PATH,
      LINEAR_FOLLOW_PATH,
      LINEAR_WAKE_PATH,
      "/v1/discord/rooms",
      "/v1/discord/room-voice",
      "/v1/discord/settings",
      "/v1/discord/directory",
      "/v1/body-leases",
      "/health",
      "/v1/operator/persona",
      "/v1/model-keys",
      "/v1/model-keys/subscriptions",
      "/v1/model-keys/options",
      "/v1/accounts",
      "/v1/connections",
      "/v1/runtime-connections",
      "/v1/agent-hosts",
      "/v1/agent-sessions",
      FLEET_SETTINGS_PATH,
      FLEET_HIRE_DEFAULTS_PATH,
      RUNTIME_HEALTH_PATH,
      PROJECTS_PATH,
      "/v1/support/grants",
    ],
    POST: [
      WORK_TRACKER_SETTINGS_PATH,
      HTTP_SETTINGS_PATH,
      EVIDENCE_STORAGE_SETTINGS_PATH,
      HOST_SETTINGS_PATH,
      APPEARANCE_SETTINGS_PATH,
      MAXIMUM_TRUST_MODE_PATH,
      "/v1/operator/voice",
      LINEAR_FOLLOW_PATH,
      LINEAR_WAKE_PATH,
      RUNTIME_HEALTH_PATH,
      "/v1/activity/shares",
      "/v1/discord/room-guidance",
      "/v1/discord/room-voice",
      "/v1/discord/settings",
      "/v1/conversation-heads",
      "/v1/discord/setup/test-post",
      "/v1/operator/persona",
      "/v1/model-keys/set",
      "/v1/model-keys/validate",
      "/v1/model-keys/select",
      "/v1/model-keys/remove",
      "/v1/model-keys/effort",
      "/v1/accounts/github/start",
      "/v1/accounts/github/poll",
      "/v1/accounts/linear/start",
      "/v1/accounts/linear/complete",
      "/v1/accounts/linear/app",
      "/v1/accounts/disconnect",
      "/v1/accounts/email/connect",
      "/v1/accounts/google/start",
      "/v1/accounts/google/complete",
      "/v1/accounts/google/check",
      "/v1/runtime-connections",
      "/v1/agent-hosts",
      FLEET_SETTINGS_PATH,
      FLEET_HIRE_DEFAULTS_PATH,
      WORKER_ACCOUNT_HOLDS_PATH,
      USAGE_SETTINGS_PATH,
      HUDDLES_PATH,
      HUDDLE_CLOSE_PATH,
      VIEWS_PATH,
      FLEET_ROSTER_RETIRE_PATH,
      FLEET_ROSTER_UNDO_PATH,
      ROUTINES_PATH,
      PROJECT_UPDATE_SETTINGS_PATH,
      "/v1/support/grants",
    ],
  };
  return (
    (routes[method]?.includes(path) ?? false) ||
    (method === "POST" && /^\/v1\/support\/grants\/[a-f0-9-]{36}\/(?:revoke|pairing-offer)$/u.test(path))
  );
}
