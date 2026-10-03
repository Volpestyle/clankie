/**
 * Inherited tracker connectors ([worker tracker identity](../../../../docs/worker-tracker-identity.md)).
 *
 * Every Linear write by Clankie or an agent he launches goes through his
 * connected account, never through a Linear MCP server the harness inherits
 * from the owner's own configuration, whose login may be someone else. So a
 * launch finds those servers in the harness's effective configuration and
 * switches them off for that session only: a Claude deny rule, or a Codex
 * `enabled=false` override. The owner's configuration files are not edited.
 *
 * A server is a tracker connector when its URL is on Linear's host or its name
 * says Linear. This is launch configuration, not an OS boundary: a worker with
 * a shell can still reach credentials on disk.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LINEAR_MCP_RESOURCE } from "@clankie/credential-broker";

const TRACKER_HOST = new URL(LINEAR_MCP_RESOURCE).hostname.replace(/^mcp\./u, "");
const CODEX_LIST_TIMEOUT_MS = 15_000;
/** The claude.ai account connector, which Claude Code loads on its own when signed in. */
const CLAUDE_AI_TRACKER_RULE = "mcp__claude_ai_Linear";

interface McpServerEntry {
  readonly url?: unknown;
  readonly command?: unknown;
  readonly args?: unknown;
}

export function isTrackerServer(name: string, entry: McpServerEntry): boolean {
  if (/linear/iu.test(name)) return true;
  if (typeof entry.url === "string") {
    try {
      const host = new URL(entry.url).hostname;
      if (host === TRACKER_HOST || host.endsWith(`.${TRACKER_HOST}`)) return true;
    } catch {
      // Not a URL; fall through to the command line.
    }
  }
  const commandLine = [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return commandLine.includes(TRACKER_HOST) || /\blinear-mcp\b|@linear\//iu.test(commandLine);
}

/** Claude Code's tool prefix for a server: characters outside `[A-Za-z0-9_-]` become `_`. */
function claudeServerRule(name: string): string {
  return `mcp__${name.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function serversOf(value: unknown): Record<string, McpServerEntry> {
  return typeof value === "object" && value !== null ? (value as Record<string, McpServerEntry>) : {};
}

function ancestors(cwd: string): string[] {
  const paths: string[] = [];
  for (let current = resolve(cwd); ; current = dirname(current)) {
    paths.push(current);
    if (dirname(current) === current) return paths;
  }
}

/**
 * Claude permission deny rules for every tracker connector a session started
 * in `cwd` would load: user and local scope from `.claude.json`, project
 * scope from `.mcp.json`, and the claude.ai account connector.
 */
export function claudeTrackerDenyRules(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  // A worker's pane may not share the service's CLAUDE_CONFIG_DIR, so both the
  // configured and the default config count; a rule for an absent server is inert.
  const configFiles = new Set([
    ...(env.CLAUDE_CONFIG_DIR ? [join(env.CLAUDE_CONFIG_DIR, ".claude.json")] : []),
    join(env.HOME ?? homedir(), ".claude.json"),
  ]);
  const sources: Record<string, McpServerEntry>[] = [];
  for (const file of configFiles) {
    const state = readJson(file);
    const projects = serversOf(state?.projects) as Record<string, { mcpServers?: unknown }>;
    sources.push(serversOf(state?.mcpServers));
    for (const path of ancestors(cwd)) sources.push(serversOf(projects[path]?.mcpServers));
  }
  for (const path of ancestors(cwd)) {
    const projectFile = join(path, ".mcp.json");
    if (existsSync(projectFile)) sources.push(serversOf(readJson(projectFile)?.mcpServers));
  }
  const rules = new Set([CLAUDE_AI_TRACKER_RULE]);
  for (const servers of sources)
    for (const [name, entry] of Object.entries(servers))
      if (isTrackerServer(name, entry ?? {})) rules.add(claudeServerRule(name));
  return [...rules].sort();
}

interface CodexListedServer {
  readonly name?: unknown;
  readonly enabled?: unknown;
  readonly transport?: { readonly url?: unknown; readonly command?: unknown; readonly args?: unknown };
}

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name);
}

/**
 * Codex `-c` overrides that disable every enabled tracker connector in the
 * effective configuration for `cwd`, read through Codex itself so project and
 * plugin sources count. Throws when the configuration cannot be read: a launch
 * that cannot prove isolation should not start.
 */
export async function codexTrackerOverrides(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string[]> {
  const stdout = await new Promise<string>((resolveList, reject) => {
    execFile(
      "codex",
      ["mcp", "list", "--json"],
      { cwd, env: { ...process.env, ...env }, timeout: CODEX_LIST_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, out) => (error ? reject(error) : resolveList(out)),
    );
  }).catch((error: unknown) => {
    throw new Error(
      `Could not read Codex's MCP servers to switch off inherited Linear connectors: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return codexTrackerOverridesFromList(stdout);
}

/**
 * The same overrides from `codex mcp list --json` output, wherever it ran: a
 * remote hire reads the configuration on the machine its Codex runs on.
 */
export function codexTrackerOverridesFromList(stdout: string): string[] {
  const listed: unknown = JSON.parse(stdout);
  if (!Array.isArray(listed)) throw new Error("Codex listed its MCP servers in an unexpected shape");
  return (listed as CodexListedServer[])
    .filter(
      (server): server is CodexListedServer & { name: string } =>
        typeof server.name === "string" && server.enabled !== false,
    )
    .filter((server) => isTrackerServer(server.name, server.transport ?? {}))
    .map((server) => `mcp_servers.${tomlKey(server.name)}.enabled=false`)
    .sort();
}
