/** Session-only MCP configuration for the Claude operator seat (VUH-2815). */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isTrackerServer, type McpServerEntry } from "../../../clankie/src/captain/tracker-isolation.ts";

type ServerMap = Record<string, McpServerEntry>;

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Invalid Claude configuration at ${path}`);
  return value as Record<string, unknown>;
}

function servers(value: unknown): ServerMap {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid Claude mcpServers map");
  return value as ServerMap;
}

/** Claude's local > project > user precedence, confined to the selected profile. */
function inheritedServers(cwd: string, env: NodeJS.ProcessEnv): ServerMap {
  const state = readJson(
    env.CLAUDE_CONFIG_DIR?.trim()
      ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
      : join(env.HOME ?? homedir(), ".claude.json"),
  );
  const ancestors: string[] = [];
  for (let path = resolve(cwd); ; path = dirname(path)) {
    ancestors.unshift(path);
    if (dirname(path) === path) break;
  }
  const result: ServerMap = Object.assign(Object.create(null), servers(state.mcpServers));
  for (const path of ancestors) Object.assign(result, servers(readJson(join(path, ".mcp.json")).mcpServers));
  const projects = state.projects as Record<string, { mcpServers?: unknown }> | undefined;
  for (const path of ancestors) Object.assign(result, servers(projects?.[path]?.mcpServers));
  return result;
}

/**
 * Strict mode omits plugin MCP servers too. Re-declare the plugin's lead as
 * `clankie`, the existing bare-server channel identity and room-tool prefix.
 * Keep the plugin itself for identity, hooks, agents and skills. Never write
 * through the projected .mcp.json symlink into the source plugin.
 */
export function writeClaudeSeatMcpConfig(
  pluginRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  optIns: readonly string[],
  bridgeNonce?: string,
): string {
  const declared = servers(readJson(join(pluginRoot, ".mcp.json")).mcpServers);
  if (!Object.hasOwn(declared, "lead"))
    throw new Error("The Clankie plugin must declare its lead MCP bridge");
  const selected: ServerMap = Object.create(null);
  for (const [name, entry] of Object.entries(declared)) {
    const key = name === "lead" ? "clankie" : `clankie-${name}`;
    selected[key] = JSON.parse(
      JSON.stringify(entry).replaceAll("${CLAUDE_PLUGIN_ROOT}", JSON.stringify(pluginRoot).slice(1, -1)),
    ) as McpServerEntry;
    // This new bare-server artifact must not default to the owner's global
    // chat when reused without the launcher's binding (the broader direct
    // unbound-bridge defect is VUH-2816). Claude expands the empty default;
    // `mcp --conversation ""` fails before connecting to the service.
    if (name === "lead") {
      const args = selected[key]!.args;
      if (!Array.isArray(args)) throw new Error("The Clankie lead bridge must declare its arguments");
      selected[key] = {
        ...selected[key],
        args: [...args, "--conversation", "${CLANKIE_CONVERSATION_ID:-}"],
        // The launch nonce rides this per-launch 0600 file only. It is not in Claude's
        // environment, so a shell Claude runs does not inherit it (VUH-2816).
        ...(bridgeNonce === undefined
          ? {}
          : {
              env: {
                ...(selected[key] as { env?: Record<string, string> }).env,
                CLANKIE_BRIDGE_NONCE: bridgeNonce,
              },
            }),
      };
    }
  }
  if (optIns.length > 0) {
    const inherited = inheritedServers(cwd, env);
    for (const name of optIns) {
      if (Object.hasOwn(selected, name)) throw new Error(`MCP server ${name} is reserved by Clankie`);
      const entry = inherited[name];
      if (!entry)
        throw new Error(`MCP server ${name} is not configured in the selected Claude profile or workspace`);
      if (isTrackerServer(name, entry))
        throw new Error("Use Clankie's connected tracker tools instead of a personal Linear server");
      selected[name] = entry;
    }
  }
  const path = join(pluginRoot, "seat-mcp.json");
  writeFileSync(path, `${JSON.stringify({ mcpServers: selected }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}
