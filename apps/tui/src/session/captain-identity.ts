import { createHash } from "node:crypto";

export const EVE_WORKFLOW_ID = "workflow//eve//workflowEntry";
export const CAPTAIN_AGENT_NAME = "captain-eve";
export const CAPTAIN_AUTHORED_TOOL_NAMES = [
  "create_mission",
  "decide_action",
  "get_mission",
  "start_mission",
  "steer_worker",
  "submit_plan",
] as const;
export const CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES = [
  "bash",
  "glob",
  "grep",
  "read_file",
  "web_fetch",
  "web_search",
  "write_file",
] as const;

export function assertLoopbackCaptainHost(host: string): URL {
  const url = new URL(host);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error(`The Clankie captain must use a loopback http URL, received ${host}`);
  }
  return url;
}

export function isReadyEveHealth(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    value.ok === true &&
    "status" in value &&
    value.status === "ready" &&
    "workflowId" in value &&
    value.workflowId === EVE_WORKFLOW_ID
  );
}

export function isCaptainInfo(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (!("agent" in value) || value.agent === null || typeof value.agent !== "object") return false;
  if (!("name" in value.agent) || value.agent.name !== CAPTAIN_AGENT_NAME) return false;
  if (!("tools" in value) || value.tools === null || typeof value.tools !== "object") return false;
  if (!("authored" in value.tools) || !Array.isArray(value.tools.authored)) return false;
  const names = value.tools.authored
    .map((tool) =>
      tool !== null && typeof tool === "object" && "name" in tool && typeof tool.name === "string"
        ? tool.name
        : undefined,
    )
    .filter((name): name is string => name !== undefined)
    .sort();
  if (names.join("\n") !== [...CAPTAIN_AUTHORED_TOOL_NAMES].sort().join("\n")) return false;
  if (!("disabledFramework" in value.tools) || !Array.isArray(value.tools.disabledFramework)) {
    return false;
  }
  const disabled = new Set(
    value.tools.disabledFramework.filter((name): name is string => typeof name === "string"),
  );
  if (!CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES.every((name) => disabled.has(name))) return false;
  if (!("available" in value.tools) || !Array.isArray(value.tools.available)) return false;
  const available = new Set(
    value.tools.available
      .map((tool) =>
        tool !== null && typeof tool === "object" && "name" in tool && typeof tool.name === "string"
          ? tool.name
          : undefined,
      )
      .filter((name): name is string => name !== undefined),
  );
  return CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES.every((name) => !available.has(name));
}

export function captainInfoGeneration(value: unknown): string | undefined {
  if (!isCaptainInfo(value) || value === null || typeof value !== "object") return undefined;
  if (!("agent" in value) || value.agent === null || typeof value.agent !== "object") return undefined;
  const agent = value.agent as Record<string, unknown>;
  const mode = "mode" in value && typeof value.mode === "string" ? value.mode : "unknown";
  if (typeof agent.agentRoot !== "string" || typeof agent.appRoot !== "string") return undefined;
  return createHash("sha256")
    .update([mode, CAPTAIN_AGENT_NAME, agent.appRoot, agent.agentRoot].join("\0"))
    .digest("hex");
}

export function assertCaptainEndpoint(health: unknown, info: unknown): void {
  if (!isReadyEveHealth(health) || !isCaptainInfo(info)) {
    throw new Error("The configured endpoint is not the authored Clankie captain");
  }
}
