import { createHash } from "node:crypto";
import { CAPTAIN_AUTHORED_TOOL_NAMES } from "@clankie/protocol";

export const EVE_WORKFLOW_ID = "workflow//eve//workflowEntry";
export const CAPTAIN_AGENT_NAME = "captain-eve";
/**
 * Re-exported rather than redeclared: the authored inventory is shared with
 * captain-eve's compile-time assertion so the launcher's identity check and the
 * agent it is checking cannot disagree. See the definition in `@clankie/protocol`.
 */
export { CAPTAIN_AUTHORED_TOOL_NAMES };
/**
 * The framework tools the captain deliberately does not have.
 *
 * Shell and filesystem stay disabled: execution belongs in governed workers
 * that own a worktree and a sandbox, and a captain that can write files is a
 * captain that can edit the doctrine it is judged against.
 *
 * Web reach is deliberately *not* on this list ([ADR 0082](../../../../docs/adr/0082-clankie-holds-the-browser.md)).
 * Looking something up is what every lane asks him for and no lane could do,
 * so `web_fetch` and `web_search` are part of the bank rather than a reason to
 * spawn a research worker.
 */
export const CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES = ["bash", "glob", "grep", "read_file", "write_file"] as const;

export function assertLoopbackCaptainHost(host: string): URL {
  const url = new URL(host);
  if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) {
    throw new Error(`Clankie must use a loopback http URL, received ${host}`);
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

/**
 * Whether this endpoint **is Clankie's captain** — deliberately not whether it
 * is an up-to-date one.
 *
 * Identity and currency are different questions with different remedies. A
 * stranger on the port must never be signalled; our own captain running an
 * older build must be rebuilt and restarted, which the launcher already knows
 * how to do. Folding the authored tool inventory into identity conflated the
 * two, so every change to the captain's tool list turned the running captain
 * into an unidentifiable stranger and dead-ended `clankie restart` into a
 * manual `lsof`-and-kill. Identity is therefore the agent's name and the roots
 * it reports; currency is {@link hasCurrentCaptainTools}.
 */
export function isCaptainIdentity(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (!("agent" in value) || value.agent === null || typeof value.agent !== "object") return false;
  // Deliberately just the name, alongside the ready-eve health probe the caller
  // has already passed. Identity must not depend on anything that legitimately
  // changes as the captain is developed — that is the mistake this split
  // exists to correct — so roots stay optional and serve adoption proof and
  // the generation fingerprint instead.
  return "name" in value.agent && value.agent.name === CAPTAIN_AGENT_NAME;
}

/** The app root a captain reports, used to prove it belongs to this checkout. */
export function captainInfoAppRoot(value: unknown): string | undefined {
  if (!isCaptainIdentity(value) || value === null || typeof value !== "object") return undefined;
  const agent = (value as { agent: Record<string, unknown> }).agent;
  return typeof agent.appRoot === "string" ? agent.appRoot : undefined;
}

/**
 * How a running captain's tool inventory differs from the authored one. Empty
 * arrays mean it is current; anything else names what drifted, so the operator
 * is told *what* is stale rather than that something is.
 */
export function captainToolDrift(value: unknown): { missing: string[]; unexpected: string[] } {
  const authored = new Set(CAPTAIN_AUTHORED_TOOL_NAMES as readonly string[]);
  const running = new Set(readToolNames(value, "authored"));
  return {
    missing: [...authored].filter((name) => !running.has(name)).sort(),
    unexpected: [...running].filter((name) => !authored.has(name)).sort(),
  };
}

function readToolNames(value: unknown, bucket: "authored" | "available"): string[] {
  if (value === null || typeof value !== "object") return [];
  if (!("tools" in value) || value.tools === null || typeof value.tools !== "object") return [];
  const tools = value.tools as Record<string, unknown>;
  const list = tools[bucket];
  if (!Array.isArray(list)) return [];
  return list
    .map((tool) =>
      tool !== null && typeof tool === "object" && "name" in tool && typeof tool.name === "string"
        ? tool.name
        : undefined,
    )
    .filter((name): name is string => name !== undefined);
}

/** Whether the running captain's tools match what this checkout authors. */
export function hasCurrentCaptainTools(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
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

/**
 * Ours *and* current. Kept as the strict predicate for callers that need a
 * fully-matching captain ({@link assertCaptainEndpoint}, the session client);
 * the launcher splits the two so it can rebuild a stale one instead of
 * refusing to touch it.
 */
export function isCaptainInfo(value: unknown): boolean {
  return isCaptainIdentity(value) && hasCurrentCaptainTools(value);
}

export function captainInfoGeneration(value: unknown): string | undefined {
  // Identity, not currency: the generation fingerprint is what *detects* a
  // stale build, so requiring a current tool inventory to compute it would
  // leave exactly the captains that need rebuilding without a generation.
  if (!isCaptainIdentity(value) || value === null || typeof value !== "object") return undefined;
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
    throw new Error("The configured endpoint is not the authored Clankie");
  }
}
