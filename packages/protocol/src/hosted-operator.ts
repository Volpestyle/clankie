import { OperatorConversationServiceRequestSchema } from "./index.ts";

/** The single hosted-device authority seam. Lifecycle belongs to the account/control plane. */
export function hostedOperatorAllows(method: string, path: string, body?: string): boolean {
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
        "cancel",
        "channel",
        "channels",
        "personas",
        "update_persona",
        "discord_rooms",
        "work_repos",
        "work_items",
        "react",
        "autonomy",
        "roster",
        "fleet",
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
      ]).has(request.data.op)
    );
  }
  const routes: Record<string, readonly string[]> = {
    GET: [
      "/health",
      "/v1/operator/persona",
      "/v1/model-keys",
      "/v1/model-keys/subscriptions",
      "/v1/accounts",
      "/v1/connections",
      "/v1/runtime-connections",
      "/v1/agent-hosts",
      "/v1/agent-sessions",
      "/v1/swarm",
    ],
    POST: [
      "/v1/operator/persona",
      "/v1/model-keys/set",
      "/v1/model-keys/validate",
      "/v1/model-keys/select",
      "/v1/model-keys/remove",
      "/v1/accounts/github/start",
      "/v1/accounts/github/poll",
      "/v1/accounts/linear/start",
      "/v1/accounts/linear/complete",
      "/v1/accounts/disconnect",
      "/v1/runtime-connections",
      "/v1/agent-hosts",
      "/v1/swarm/connections",
      "/v1/swarm/fleet-peers",
    ],
  };
  return routes[method]?.includes(path) ?? false;
}
