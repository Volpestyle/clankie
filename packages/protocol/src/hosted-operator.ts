import { APPEARANCE_SETTINGS_PATH, HOST_SETTINGS_PATH } from "./owner-settings.ts";
import { LINEAR_FOLLOW_PATH, LINEAR_WAKE_PATH } from "./linear-settings.ts";
import { hostedDiscordAllows } from "./hosted-discord.ts";
export const HOSTED_OPERATOR_PATH = "/v1/hosted/operator";
import { OperatorConversationServiceRequestSchema } from "./index.ts";
import { FLEET_HIRE_DEFAULTS_PATH, FLEET_SETTINGS_PATH } from "./fleet-settings.ts";
import {
  isWorkerAccountsRoute,
  USAGE_PATH,
  USAGE_SETTINGS_PATH,
  WORKER_ACCOUNT_HOLDS_PATH,
} from "./worker-accounts.ts";
import { RUNTIME_HEALTH_PATH } from "./runtime-health.ts";
import { OFFICIAL_DISCORD_BODY_PATH } from "./official-discord.ts";
import { PROJECTS_PATH, PROJECT_UPDATE_SETTINGS_PATH } from "./projects.ts";

/** The single hosted-device authority seam. Lifecycle belongs to the account/control plane. */
export function hostedOperatorAllows(method: string, path: string, body?: string): boolean {
  if (hostedDiscordAllows(method, path)) return true;
  // A self-hosted machine's free official bot (VUH-1766); never the edge's web permits.
  if (path === OFFICIAL_DISCORD_BODY_PATH) return method === "GET" || method === "POST";
  // Only this explicit projection query is supported. Unknown, duplicated or
  // encoded queries never acquire authority through URL normalization.
  if (path === `${PROJECTS_PATH}?includeAutonomy=true`) return method === "GET";
  if (path === `${PROJECT_UPDATE_SETTINGS_PATH}?includeAutonomy=true`) return method === "POST";
  // Worker accounts read one machine through the only query that route accepts.
  if (isWorkerAccountsRoute(path)) return method === "GET";
  if (path === `${USAGE_PATH}?refresh=1`) return method === "GET";
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
        "pending_messages",
        "stop_task",
        "project_proposal_get",
        "project_proposal_confirm",
        "project_proposal_tweak",
        "input_get",
        "input_list",
        "owner_update_list",
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
      HOST_SETTINGS_PATH,
      APPEARANCE_SETTINGS_PATH,
      "/v1/operator/voice",
      WORKER_ACCOUNT_HOLDS_PATH,
      USAGE_PATH,
      USAGE_SETTINGS_PATH,
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
      HOST_SETTINGS_PATH,
      APPEARANCE_SETTINGS_PATH,
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
      "/v1/accounts/google/start",
      "/v1/accounts/google/complete",
      "/v1/accounts/google/check",
      "/v1/runtime-connections",
      "/v1/agent-hosts",
      FLEET_SETTINGS_PATH,
      FLEET_HIRE_DEFAULTS_PATH,
      WORKER_ACCOUNT_HOLDS_PATH,
      USAGE_SETTINGS_PATH,
      PROJECT_UPDATE_SETTINGS_PATH,
      "/v1/support/grants",
    ],
  };
  return (
    (routes[method]?.includes(path) ?? false) ||
    (method === "POST" && /^\/v1\/support\/grants\/[a-f0-9-]{36}\/(?:revoke|pairing-offer)$/u.test(path))
  );
}
