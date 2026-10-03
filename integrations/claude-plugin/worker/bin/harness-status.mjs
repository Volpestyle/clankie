#!/usr/bin/env node
// Static registration evidence only. This report never proves a live native occupant.
import { access, readFile, realpath, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export async function claudeProfileDirectories(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return [
    ...new Set(
      [
        join(home, ".claude"),
        env.CLAUDE_CONFIG_DIR,
        // Named Claude profiles are owner directories, never discovered from untrusted pane claims.
        ...(await readdir(home, { withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isDirectory() && entry.name.startsWith(".claude-"))
          .map((entry) => join(home, entry.name)),
      ].filter(Boolean),
    ),
  ];
}

export async function inspectHarnessProfiles({
  env = process.env,
  expectedVersion,
  execute = async (command, args) => (await exec(command, args, { env, timeout: 10_000 })).stdout,
} = {}) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const profiles = await claudeProfileDirectories(env);
  const present = async (command) => {
    try {
      await execute(command, ["--version"]);
      return true;
    } catch {
      return false;
    }
  };
  const installed = Object.fromEntries(
    await Promise.all(
      ["claude", "codex", "opencode", "pi"].map(async (command) => [command, await present(command)]),
    ),
  );
  const claude = await Promise.all(
    profiles.map(async (profile) => {
      const settings = await json(join(profile, "settings.json")).catch(() => ({}));
      const registry = await json(join(profile, "plugins", "installed_plugins.json")).catch(() => ({}));
      const entries = registry.plugins?.["clankie-worker@clankie"];
      const entry = Array.isArray(entries)
        ? entries.find((value) => value.scope === "user" && typeof value.installPath === "string")
        : undefined;
      const root = entry?.installPath;
      const manifest = root ? await json(join(root, ".claude-plugin", "plugin.json")).catch(() => ({})) : {};
      const mcp = root ? await json(join(root, ".mcp.json")).catch(() => ({})) : {};
      const hooks = root ? await json(join(root, "hooks", "hooks.json")).catch(() => ({})) : {};
      return {
        profile,
        executable: installed.claude,
        installed: Boolean(manifest.version),
        enabled: settings.enabledPlugins?.["clankie-worker@clankie"] === true,
        version: manifest.version ?? null,
        expectedVersion: expectedVersion ?? null,
        versionMatches: expectedVersion ? manifest.version === expectedVersion : null,
        bridge: Boolean(mcp.mcpServers?.clankie),
        legacyServerName: Boolean(mcp.mcpServers?.swarm),
        hooks: ["SessionStart", "UserPromptSubmit", "Stop"].every(
          (event) =>
            Array.isArray(hooks.hooks?.[event]) &&
            hooks.hooks[event].some((matcher) =>
              matcher.hooks?.some(
                (hook) => hook.type === "command" && String(hook.command).includes("/bin/seat-hook.mjs"),
              ),
            ),
        ),
        skill: root ? await exists(join(root, "skills", "clankie", "SKILL.md")) : false,
        liveReceiver: "not-observed",
      };
    }),
  );
  let codexPlugins = [];
  try {
    const result = JSON.parse(await execute("codex", ["plugin", "list", "--json"]));
    codexPlugins = Array.isArray(result) ? result : (result.installed ?? result.plugins ?? []);
  } catch {
    /* Visible missing registration below. */
  }
  const plugin = codexPlugins.find((value) =>
    [value.id, value.pluginId].some((name) => name === "clankie-worker@clankie-fleet"),
  );
  const forwardsIdentity = (spec) =>
    ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"].every(
      (name) => Array.isArray(spec?.env_vars) && spec.env_vars.includes(name),
    );
  let registered = false;
  let registration = "absent";
  let registrationIdentityForwarding = false;
  try {
    const result = JSON.parse(await execute("codex", ["mcp", "get", "clankie", "--json"]));
    const transport = result.transport ?? result;
    registrationIdentityForwarding = forwardsIdentity(transport);
    const cli =
      transport.command === "clankie" &&
      JSON.stringify(transport.args) === JSON.stringify(["mcp", "--fleet"]);
    const legacyPaths = ["swarm-mcp.mjs", "fleet-mcp.mjs"].map((name) =>
      join(home, ".clankie", "claude-plugin", "worker", "bin", name),
    );
    const legacy =
      transport.command === "node" &&
      Array.isArray(transport.args) &&
      transport.args.length === 1 &&
      legacyPaths.includes(transport.args[0]) &&
      (await exists(transport.args[0]));
    registration = cli ? "cli" : legacy ? "legacy-node" : "unrecognized";
    registered = result.enabled !== false && registrationIdentityForwarding && (cli || legacy);
  } catch {
    /* Native plugin status may supply the bridge. */
  }
  const configPath = join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
  const root = plugin
    ? join(
        env.CODEX_HOME || join(home, ".codex"),
        "plugins",
        "cache",
        "clankie-fleet",
        "clankie-worker",
        String(plugin.version ?? ""),
      )
    : undefined;
  const codexManifest = root ? await json(join(root, ".codex-plugin", "plugin.json")).catch(() => ({})) : {};
  const codexMcp = root ? await json(join(root, "codex-mcp.json")).catch(() => ({})) : {};
  const bridgeSpec = codexMcp.mcpServers?.clankie;
  const identityForwarding = forwardsIdentity(bridgeSpec);
  const bridge =
    codexManifest.mcpServers === "./codex-mcp.json" &&
    bridgeSpec?.command === "node" &&
    JSON.stringify(bridgeSpec.args) === JSON.stringify(["bin/fleet-mcp.mjs"]) &&
    bridgeSpec.cwd === "." &&
    Boolean(root && (await exists(join(root, "bin", "fleet-mcp.mjs"))));
  return {
    machine: { platform: process.platform, home },
    claude,
    codex: {
      executable: installed.codex,
      registered,
      registration,
      registrationIdentityForwarding,
      bridge,
      identityForwarding,
      pluginInstalled: Boolean(codexManifest.version),
      enabled: plugin ? plugin.enabled !== false : false,
      version: codexManifest.version ?? null,
      expectedVersion: expectedVersion ?? null,
      versionMatches: expectedVersion && plugin ? codexManifest.version === expectedVersion : null,
      configPath,
      configSource: await realpath(configPath).catch(() => configPath),
      skill: root ? await exists(join(root, "skills", "clankie", "SKILL.md")) : false,
      replies: "native-control",
      liveReceiver: "not-observed",
    },
    otherHarnesses: ["opencode", "pi"].map((harness) => ({
      harness,
      executable: installed[harness],
      registration: "not-inspected",
      detail:
        "No supported automatic worker-plugin installer for this harness; inspect its native MCP/skill configuration separately.",
    })),
  };
}
