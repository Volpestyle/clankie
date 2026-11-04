#!/usr/bin/env node
// Static registration evidence only. This report never proves a live native occupant.
import { access, readFile, realpath, readdir, lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nativeCodexExecutable } from "./native-codex.mjs";
import { bridgeToolNames } from "./bridge-tools.mjs";
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

const OLD_WORKER = "clankie-worker@clankie";
/**
 * A path that isn't there is the only expected miss; any other failure (a file
 * it may not read, say) fails the reading instead of passing for an absence.
 */
const missing = (error) => {
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
  throw error;
};
/** A settings file whose header says a generator or another source owns it. */
const managedSettingsText = (text) =>
  /(?:generated|do not edit|managed by)/iu.test(text.split("\n").slice(0, 20).join("\n"));
/** Whether a settings file still enables the old worker; only its owner may change that. */
async function declaresOldWorker(path) {
  const text = await readFile(path, "utf8").catch(missing);
  if (text === undefined) return false;
  try {
    return JSON.parse(text).enabledPlugins?.[OLD_WORKER] !== undefined;
  } catch {
    return false;
  }
}
/**
 * What an older setup left in a Claude profile (ADR 0317): Clankie's installed
 * worker at user scope and at project scope for each project it was installed
 * in, and the `clankie` marketplace when no other Clankie plugin comes from it.
 * `worker`, `projects` and `marketplace` are what the cleanup removes; `keptBy`
 * names each settings file that keeps a copy until its owner drops the entry.
 * The cleanup and doctor both read this, so doctor never asks for a removal the
 * cleanup skips. A missing project directory has nothing left to clear.
 */
export async function oldClaudeWorker(profile) {
  const known = await json(join(profile, "plugins", "known_marketplaces.json")).catch(() => ({}));
  const installed = await json(join(profile, "plugins", "installed_plugins.json")).catch(() => ({}));
  const plugins = installed.plugins ?? {};
  const entries = Array.isArray(plugins[OLD_WORKER]) ? plugins[OLD_WORKER] : [];
  const worker = entries.some((entry) => entry.scope === "user");
  const recorded = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.scope === "project" && typeof entry.projectPath === "string" && isAbsolute(entry.projectPath)
          ? [entry.projectPath]
          : [],
      ),
    ),
  ];
  const otherFromClankie = Object.keys(plugins).some((id) => id !== OLD_WORKER && id.endsWith("@clankie"));
  let marketplace = Boolean(known.clankie) && !otherFromClankie;
  const found = worker || marketplace || recorded.length > 0;
  if (!found) return { found, worker, projects: [], marketplace, keptBy: [], settings: undefined };
  const config = join(profile, "settings.json");
  const source = await realpath(config).catch(() => config);
  const text = await readFile(config, "utf8").catch(missing);
  const wasSymlink = (await lstat(config).catch(missing))?.isSymbolicLink() ?? false;
  const link = wasSymlink ? await readlink(config) : undefined;
  const managed = wasSymlink || managedSettingsText(text ?? "");
  const keptBy = [];
  if (managed) {
    let declared = {};
    try {
      declared = JSON.parse(text ?? "{}");
    } catch {
      /* An unreadable source declares nothing this setup can see. */
    }
    if (declared.enabledPlugins?.[OLD_WORKER] !== undefined)
      keptBy.push({ scope: "profile", settings: source });
    // A source that still declares the clankie marketplace keeps it (the operator
    // plugin may come from it); Claude would only register it again.
    if (declared.extraKnownMarketplaces?.clankie !== undefined) marketplace = false;
  }
  const projects = [];
  for (const project of recorded) {
    if (!(await lstat(project).catch(missing))?.isDirectory()) continue;
    const settings = [];
    for (const name of ["settings.json", "settings.local.json"])
      if (await declaresOldWorker(join(project, ".claude", name)))
        settings.push(join(project, ".claude", name));
    if (settings.length === 0) projects.push(project);
    else keptBy.push(...settings.map((path) => ({ scope: "project", project, settings: path })));
  }
  return {
    found,
    worker,
    projects,
    marketplace,
    keptBy,
    settings: { config, source, text, wasSymlink, link, managed },
  };
}

export async function claudeProfileDirectories(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return [
    ...new Set(
      [
        join(home, ".claude"),
        env.CLAUDE_CONFIG_DIR,
        // Named Claude profiles are owner directories, never discovered from untrusted pane claims.
        // A lock directory beside a profile (.claude-name.lock) is not a profile.
        ...(await readdir(home, { withFileTypes: true }).catch(() => []))
          .filter(
            (entry) =>
              entry.isDirectory() && entry.name.startsWith(".claude-") && !entry.name.endsWith(".lock"),
          )
          .map((entry) => join(home, entry.name)),
      ].filter(Boolean),
    ),
  ];
}

export async function inspectHarnessProfiles({ env = process.env, expectedVersion, execute } = {}) {
  let codexExecutablePath = null;
  const run = async (command, args) => {
    if (command === "codex") command = codexExecutablePath ??= await nativeCodexExecutable({ env });
    return execute ? execute(command, args) : (await exec(command, args, { env, timeout: 10_000 })).stdout;
  };
  const home = env.HOME || env.USERPROFILE || homedir();
  const profiles = await claudeProfileDirectories(env);
  const present = async (command) => {
    try {
      await run(command, ["--version"]);
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
      // An older installed copy (ADR 0317), at user scope or left in a project.
      const copies = Array.isArray(entries)
        ? entries.filter((value) => typeof value.installPath === "string")
        : [];
      const entry = copies.find((value) => value.scope === "user") ?? copies[0];
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
        bridge: Boolean(mcp.mcpServers?.worker ?? mcp.mcpServers?.clankie),
        legacyServerName: Boolean(mcp.mcpServers?.swarm),
        hooks:
          ["SessionStart", "UserPromptSubmit", "Stop"].every(
            (event) =>
              Array.isArray(hooks.hooks?.[event]) &&
              hooks.hooks[event].some((matcher) =>
                matcher.hooks?.some(
                  (hook) => hook.type === "command" && String(hook.command).includes("/bin/seat-hook.mjs"),
                ),
              ),
          ) &&
          Array.isArray(hooks.hooks?.PreToolUse) &&
          hooks.hooks.PreToolUse.some(
            (matcher) =>
              matcher.matcher === "Bash" &&
              matcher.hooks?.some(
                (hook) => hook.type === "command" && String(hook.command).includes("/bin/resource-hook.mjs"),
              ),
          ),
        skill: root ? await exists(join(root, "skills", "clankie", "SKILL.md")) : false,
        liveReceiver: "not-observed",
      };
    }),
  );
  let codexPlugins = [];
  try {
    const result = JSON.parse(await run("codex", ["plugin", "list", "--json"]));
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
  let observedTransport;
  let registered = false;
  let registration = "absent";
  let registrationIdentityForwarding = false;
  try {
    let result;
    try {
      result = JSON.parse(await run("codex", ["mcp", "get", "worker", "--json"]));
    } catch {
      result = JSON.parse(await run("codex", ["mcp", "get", "clankie", "--json"]));
    }
    const transport = result.transport ?? result;
    observedTransport = transport;
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
  const configSource = await realpath(configPath).catch(() => configPath);
  const configText = await readFile(configPath, "utf8").catch(() => "");
  const sourceManaged =
    (await lstat(configPath).catch(() => undefined))?.isSymbolicLink() === true ||
    /(?:generated|do not edit|managed by)/iu.test(configText.split("\n").slice(0, 20).join("\n"));
  const setup = await json(
    join(env.CODEX_HOME || join(home, ".codex"), "plugins", "clankie-source-setup.json"),
  ).catch(() => undefined);
  const sourceSetupRequired =
    sourceManaged &&
    !(
      setup?.source === configSource &&
      typeof setup.command === "string" &&
      Array.isArray(setup.args) &&
      setup.args.every((arg) => typeof arg === "string")
    );
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
  const bridgeSpec = codexMcp.mcpServers?.worker ?? codexMcp.mcpServers?.clankie;
  const identityForwarding = forwardsIdentity(bridgeSpec);
  const bridge =
    codexManifest.mcpServers === "./codex-mcp.json" &&
    bridgeSpec?.command === "node" &&
    JSON.stringify(bridgeSpec.args) === JSON.stringify(["bin/fleet-mcp.mjs"]) &&
    bridgeSpec.cwd === "." &&
    Boolean(root && (await exists(join(root, "bin", "fleet-mcp.mjs"))));
  if (
    root &&
    bridge &&
    observedTransport?.command === "node" &&
    JSON.stringify(observedTransport.args) === JSON.stringify(["bin/fleet-mcp.mjs"]) &&
    typeof observedTransport.cwd === "string" &&
    (await realpath(observedTransport.cwd).catch(() => undefined)) ===
      (await realpath(root).catch(() => null))
  )
    registration = "plugin";
  return {
    machine: { platform: process.platform, home },
    claude,
    codex: {
      executable: installed.codex,
      executablePath: codexExecutablePath,
      executableDetail: installed.codex
        ? "Native executable responded; static registration only."
        : "Native Codex unavailable or ambiguous. On Windows, doctor requires a unique installed .exe; command shims are not executed.",
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
      configSource,
      sourceSetup: sourceSetupRequired
        ? {
            state: "source-manager-required",
            detail: `source-managed: needs setup in ${env.CODEX_HOME || join(home, ".codex")}`,
            fix: `Have the owner of ${configSource} provide a source-owned script; run clankie harness install --codex-source-setup /absolute/source-owned/script --approve in this profile. Preserve the configuration link.`,
          }
        : { state: sourceManaged ? "source-setup-recorded" : "unmanaged" },
      skill: root ? await exists(join(root, "skills", "clankie", "SKILL.md")) : false,
      // The tools this cached bridge defines itself, compared with Clankie's served catalog (#379).
      bridgeTools: root ? await bridgeToolNames(join(root, "bin")) : null,
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
