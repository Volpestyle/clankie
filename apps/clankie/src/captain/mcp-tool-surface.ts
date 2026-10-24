import type { CaptainSessionLaneV2 } from "@clankie/protocol";

/**
 * How a lane's tool bank is projected to an MCP seat (VUH-2796). The bank, its
 * schemas and its authority are unchanged; this only decides what a native
 * client keeps in context, what it may run in parallel, and what it finds by
 * search instead of by listing.
 */

/**
 * The operator tools a native lead actually uses: twenty names carried 97% of the
 * lead's Clankie calls over 2026-10-10..24 (the twentieth, `reply`, is the stdio
 * bridge's own). Claude Code defers MCP tools behind its tool search; these skip
 * that round trip.
 */
const ALWAYS_LOADED = new Set([
  "message_seat",
  "linear_save_issue",
  "record_drift_correction",
  "linear_save_comment",
  "readopt_seat",
  "worker_reports",
  "hire_agent",
  "close_worker_pane",
  "acknowledge_worker_reports",
  "schedule_wake",
  "linear_wake",
  "linear_get_issue",
  "mcp_tool_call",
  "linear_list_issues",
  "herdr_watch",
  "linear_list_comments",
  "memory",
  "waive_review",
  "settle_hire_receipt",
]);

/**
 * Pure observations: safe to repeat and to run beside one another. Anything that
 * records an offer, a read cursor or a review stays unmarked.
 */
const READ_ONLY = new Set([
  "agent_sessions",
  "agent_session_read",
  "get_self_state",
  "get_wake",
  "observe_room",
  "linear_get_issue",
  "linear_list_issues",
  "linear_list_comments",
  "linear_list_projects",
  "linear_list_teams",
  "list_tidy_worktrees",
  "mcp_tool_search",
  "runtime_update_status",
  "worker_accounts",
  "worker_pane_history",
]);

/** Play and media belong to rooms and Pi lanes; a lead reaches them through `mcp_tool_search`. */
const OFF_OPERATOR_LIST =
  /^(minecraft_|pokeagent_|music_|generate_(image|video)$|draw_[a-z]+_diagram$|youtube_search$|skin_draft$)/u;

/** Whether `name` is listed to an MCP seat in `lane`; unlisted tools stay callable. */
export function listedOnLane(lane: CaptainSessionLaneV2, name: string): boolean {
  return lane !== "operator" || !OFF_OPERATOR_LIST.test(name);
}

/** MCP `tools/list` hints for one tool. */
export function laneToolHints(
  lane: CaptainSessionLaneV2,
  name: string,
): { annotations?: { readOnlyHint: true }; _meta?: { "anthropic/alwaysLoad": true } } {
  return {
    ...(READ_ONLY.has(name) ? { annotations: { readOnlyHint: true } } : {}),
    ...(lane === "operator" && ALWAYS_LOADED.has(name) ? { _meta: { "anthropic/alwaysLoad": true } } : {}),
  };
}
