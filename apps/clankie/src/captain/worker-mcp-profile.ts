/**
 * A local hire's MCP profile (VUH-2388).
 *
 * A worker inherits the owner's harness configuration, and with it every MCP
 * server the owner registered for their own sessions: video editors, IDE
 * bridges, Blender. Each one is a process per worker (per Codex thread), so a
 * fleet of them held gigabytes for tools no worker asked for. A local hire
 * starts Clankie's worker bridge, the servers its checkout declares, and only
 * the owner servers its hire profile opts in (`mcpServers`, added up across
 * fleet, role and hire). The owner's configuration files are not edited.
 *
 * Claude enforces the profile itself: `allowedMcpServers` in the launch's
 * settings admits nothing else, including other plugins' servers and claude.ai
 * connectors. Codex has no allowlist, so its user-layer servers are switched
 * off for the session; servers its plugins contribute follow the owner's plugin
 * choices. Like tracker isolation, this is launch configuration, not an OS
 * boundary.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  claudeMcpServerSources,
  isTrackerServer,
  tomlKey,
  type McpServerEntry,
} from "./tracker-isolation.ts";

/** A Claude Code `allowedMcpServers` entry: a server name, or a stdio server's exact argv. */
export type ClaudeMcpPolicyEntry =
  | { readonly serverName: string }
  | { readonly serverCommand: readonly string[] };

const CLAUDE_POLICY_NAME = /^[A-Za-z0-9_-]+$/u;
const CODEX_CONFIG_TIMEOUT_MS = 20_000;
/** Clankie's bridge on a local Codex hire; its launch flags define it. */
const CODEX_WORKER_SERVER = "worker";

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function stringArgs(entry: McpServerEntry): string[] | undefined {
  if (typeof entry.command !== "string" || entry.command.length === 0) return undefined;
  if (entry.args !== undefined && !Array.isArray(entry.args)) return undefined;
  const args = (entry.args ?? []) as unknown[];
  return args.every((arg) => typeof arg === "string") ? [entry.command, ...(args as string[])] : undefined;
}

/**
 * Claude matches a stdio server by its exact argv once any command entry is
 * present, and every other server by name. Names it cannot spell (a plugin's
 * `plugin:…` servers, claude.ai connectors) stay off.
 */
function claudePolicyEntry(name: string, entry: McpServerEntry): ClaudeMcpPolicyEntry | undefined {
  const isStdio = entry.type === undefined || entry.type === "stdio";
  if (isStdio && entry.url === undefined) {
    const argv = stringArgs(entry);
    return argv === undefined ? undefined : { serverCommand: argv };
  }
  return CLAUDE_POLICY_NAME.test(name) ? { serverName: name } : undefined;
}

/**
 * Where Claude runs the `clankie-worker` plugin from: the directory
 * marketplace Clankie registers, or a copied install. The pane may not share
 * the service's CLAUDE_CONFIG_DIR, so the launch's, the service's and the
 * default profile all count; an entry for a root Claude does not use is inert.
 */
function claudeWorkerPluginRoots(env: Readonly<Record<string, string | undefined>>): string[] {
  const profiles = new Set(
    [env.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR, join(env.HOME ?? homedir(), ".claude")].filter(
      (profile): profile is string => typeof profile === "string" && profile.length > 0,
    ),
  );
  const roots = new Set<string>();
  for (const profile of profiles) {
    const marketplace = readJson(join(profile, "plugins", "known_marketplaces.json"))?.clankie as
      | { source?: { source?: unknown; path?: unknown }; installLocation?: unknown }
      | undefined;
    if (marketplace?.source?.source === "directory") {
      const location = marketplace.source.path ?? marketplace.installLocation;
      if (typeof location === "string") roots.add(join(location, "worker"));
    }
    const installed = readJson(join(profile, "plugins", "installed_plugins.json"))?.plugins as
      | Record<string, unknown>
      | undefined;
    const entries = installed?.["clankie-worker@clankie"];
    if (Array.isArray(entries))
      for (const entry of entries as { scope?: unknown; installPath?: unknown }[])
        if (entry.scope === "user" && typeof entry.installPath === "string") roots.add(entry.installPath);
  }
  return [...roots];
}

/** The worker plugin's own servers, with `${CLAUDE_PLUGIN_ROOT}` as Claude expands it. */
function claudeWorkerPluginEntries(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeMcpPolicyEntry[] {
  const entries: ClaudeMcpPolicyEntry[] = [];
  for (const root of claudeWorkerPluginRoots(env)) {
    const servers = readJson(join(root, ".mcp.json"))?.mcpServers;
    if (typeof servers !== "object" || servers === null) continue;
    for (const [name, entry] of Object.entries(servers as Record<string, McpServerEntry>)) {
      const expanded = JSON.parse(
        JSON.stringify(entry ?? {}).replaceAll("${CLAUDE_PLUGIN_ROOT}", root.replaceAll("\\", "\\\\")),
      ) as McpServerEntry;
      const policy = claudePolicyEntry(name, expanded);
      if (policy) entries.push(policy);
    }
  }
  return entries;
}

/**
 * The `allowedMcpServers` a local Claude hire launches with: the worker
 * plugin's bridge, every non-tracker server the checkout's `.mcp.json`
 * declares, and the owner servers named in `optIns`. Undefined when the
 * worker plugin's own server cannot be located: a list without it would cut
 * the hire's channel, so the launch keeps the owner's servers instead.
 */
export function claudeWorkerMcpAllowlist(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  optIns: readonly string[],
): ClaudeMcpPolicyEntry[] | undefined {
  const { owner, project } = claudeMcpServerSources(cwd, { ...process.env, ...env });
  const entries = claudeWorkerPluginEntries(env);
  if (entries.length === 0) {
    console.warn("hire_agent.worker_mcp_unrestricted: the clankie-worker plugin's server was not found");
    return undefined;
  }
  for (const servers of project)
    for (const [name, entry] of Object.entries(servers)) {
      if (isTrackerServer(name, entry ?? {})) continue;
      const policy = claudePolicyEntry(name, entry ?? {});
      if (policy) entries.push(policy);
    }
  for (const name of optIns) {
    let found = false;
    for (const servers of [...owner, ...project]) {
      const entry = servers[name];
      if (entry === undefined) continue;
      found = true;
      const policy = claudePolicyEntry(name, entry);
      if (policy) entries.push(policy);
    }
    // A plugin's or account's server is admitted by name when Claude can spell it.
    if (!found && CLAUDE_POLICY_NAME.test(name)) entries.push({ serverName: name });
  }
  const unique = new Map(entries.map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()];
}

interface CodexConfigLayer {
  readonly name?: { readonly type?: unknown };
  readonly config?: { readonly mcp_servers?: Record<string, { readonly enabled?: unknown } | undefined> };
}

/** Codex's own reading of its configuration layers for `cwd`: no thread, no model turn, no MCP start. */
async function codexConfigLayers(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly CodexConfigLayer[]> {
  return await new Promise<readonly CodexConfigLayer[]>((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | undefined, layers?: readonly CodexConfigLayer[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      if (error) {
        child.kill();
        reject(error);
      } else resolve(layers!);
    };
    const timer = setTimeout(() => finish(new Error("Codex config read timed out")), CODEX_CONFIG_TIMEOUT_MS);
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(new Error(`Codex app-server exited (${String(code)})${stderr ? `: ${stderr.trim()}` : ""}`)),
    );
    child.stdin.on("error", (error) => finish(error));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_096);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 16 * 1024 * 1024) return finish(new Error("Codex config frame too large"));
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { id?: unknown; result?: { layers?: unknown }; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return finish(new Error("Invalid Codex config frame"));
        }
        if (message.error !== undefined && (message.id === 1 || message.id === 2))
          return finish(new Error(`Codex config read failed: ${JSON.stringify(message.error)}`));
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
          child.stdin.write(
            `${JSON.stringify({ id: 2, method: "config/read", params: { includeLayers: true, cwd } })}\n`,
          );
        } else if (message.id === 2) {
          const layers = message.result?.layers;
          if (!Array.isArray(layers)) return finish(new Error("Codex returned no config layers"));
          finish(undefined, layers as CodexConfigLayer[]);
        }
      }
    });
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "clankie-worker-mcp", version: "1" },
          capabilities: { experimentalApi: true },
        },
      })}\n`,
    );
  });
}

/**
 * Codex `-c` overrides that switch off every enabled MCP server the owner's
 * user configuration declares, except Clankie's bridge, a server the checkout's
 * own `.codex/config.toml` also declares, and the names in `optIns`. Throws
 * when Codex cannot read its configuration, like tracker isolation.
 */
export async function codexWorkerMcpOverrides(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  optIns: readonly string[],
  layers: (
    cwd: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<readonly CodexConfigLayer[]> = codexConfigLayers,
): Promise<string[]> {
  const read = await layers(cwd, env).catch((error: unknown) => {
    throw new Error(
      `Could not read Codex's MCP servers to leave the owner's own off: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const kept = new Set([CODEX_WORKER_SERVER, ...optIns]);
  for (const layer of read)
    if (layer.name?.type === "project")
      for (const name of Object.keys(layer.config?.mcp_servers ?? {})) kept.add(name);
  const overrides = new Set<string>();
  for (const layer of read) {
    if (layer.name?.type !== "user") continue;
    for (const [name, server] of Object.entries(layer.config?.mcp_servers ?? {}))
      if (!kept.has(name) && server?.enabled !== false)
        overrides.add(`mcp_servers.${tomlKey(name)}.enabled=false`);
  }
  return [...overrides].sort();
}
