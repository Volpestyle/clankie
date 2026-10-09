import { nativeCodexExecutable } from "./native-codex.mjs";
import { prepareWorkerSkill } from "./skill-bundle.mjs";
import { claudeProfileDirectories, inspectHarnessProfiles } from "./harness-status.mjs";
import { execFile } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, win32, posix } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const managedText = (text) =>
  /(?:generated|do not edit|managed by)/iu.test(text.split("\n").slice(0, 20).join("\n"));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
async function linkedProfiles(home) {
  const text = await readFile(join(home, ".clankie", "harness-links.jsonl"), "utf8").catch(() => "");
  return text.split("\n").flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return ["claude", "codex"].includes(value.harness) &&
        typeof value.profile === "string" &&
        isAbsolute(value.profile)
        ? [value]
        : [];
    } catch {
      return [];
    }
  });
}
async function rememberProfile(home, harness, profile) {
  if ((await linkedProfiles(home)).some((entry) => entry.harness === harness && entry.profile === profile))
    return;
  await mkdir(join(home, ".clankie"), { recursive: true, mode: 0o700 });
  await appendFile(
    join(home, ".clankie", "harness-links.jsonl"),
    JSON.stringify({ harness, profile }) + "\n",
    { mode: 0o600 },
  );
}
const linkedClaude = async (profile) => {
  const known = await json(join(profile, "plugins", "known_marketplaces.json")).catch(() => ({}));
  const installed = await json(join(profile, "plugins", "installed_plugins.json")).catch(() => ({}));
  return Boolean(
    known.clankie || installed.plugins?.["clankie-worker@clankie"]?.some((entry) => entry.scope === "user"),
  );
};
// Recorded only after the owner approved and completed a source-owned installation.
const sourceRecord = (profile) => join(profile, "plugins", "clankie-source-setup.json");
async function rememberedSourceSetup(profile, source) {
  const record = await json(sourceRecord(profile)).catch(() => undefined);
  return record?.source === source &&
    typeof record.command === "string" &&
    Array.isArray(record.args) &&
    record.args.every((arg) => typeof arg === "string")
    ? { command: record.command, args: record.args }
    : undefined;
}
async function rememberSourceSetup(profile, source, setup) {
  await mkdir(join(profile, "plugins"), { recursive: true, mode: 0o700 });
  const path = sourceRecord(profile),
    temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ source, ...setup }), { mode: 0o600 });
  await rename(temporary, path);
}
async function clankieMarketplace(path) {
  const manifest = await json(join(path, ".claude-plugin", "marketplace.json")).catch(() => undefined);
  return manifest?.name === "clankie" && manifest.plugins?.some((plugin) => plugin.name === "clankie-worker");
}
async function refreshCodexMarketplace(execute, marketplace) {
  const output = await execute("codex", ["plugin", "marketplace", "list", "--json"]);
  const list = JSON.parse(typeof output === "string" ? output : output.stdout);
  const registered = list.marketplaces?.find((entry) => entry.name === "clankie-fleet");
  if (registered && (await realpath(registered.root)) !== (await realpath(marketplace))) {
    const manifest = await json(join(registered.root, ".agents", "plugins", "marketplace.json"));
    if (
      registered.marketplaceSource?.sourceType !== "local" ||
      manifest.name !== "clankie-fleet" ||
      !manifest.plugins?.some(
        (plugin) => plugin.name === "clankie-worker" && plugin.source?.source === "local",
      )
    )
      throw new Error(
        "The clankie-fleet marketplace has a different source; review it with the native plugin manager",
      );
    await execute("codex", ["plugin", "marketplace", "remove", "clankie-fleet", "--json"]);
  }
  await execute("codex", ["plugin", "marketplace", "add", marketplace]);
}
/** Read-only confirmation of one known native enable result; not plugin or tool authority. */
async function confirmClaudeWorkerEnabled(error, { profile, source, configBefore }) {
  const alreadyEnabled =
    /^[×✘] Failed to enable plugin "clankie-worker@clankie": Plugin "clankie-worker@clankie" is already enabled at user scope$/u;
  if (
    error?.code !== 1 ||
    error?.signal ||
    error?.killed ||
    String(error?.stdout ?? "").trim() ||
    !alreadyEnabled.test(String(error?.stderr ?? "").trim())
  )
    return false;
  try {
    const config = join(profile, "settings.json");
    const current = await readFile(config, "utf8");
    const expectedSource =
      configBefore === undefined ? join(await realpath(profile), "settings.json") : source;
    return (
      (await lstat(config)).isFile() &&
      (await realpath(config)) === expectedSource &&
      !managedText(current) &&
      JSON.parse(current).enabledPlugins?.["clankie-worker@clankie"] === true
    );
  } catch {
    return false;
  }
}
/** An alias may refresh its own existing cache, never install/enable or edit shared settings. */
async function updatableClaudeAlias(profile, profiles, source, marketplace, relocate = false) {
  try {
    if (!(await lstat(join(profile, "settings.json"))).isSymbolicLink()) return false;
    if (/[\\/]\.local[\\/]/iu.test(source) || !(await lstat(source)).isFile()) return false;
    let owner = false;
    for (const entry of profiles) {
      const config = join(entry, "settings.json");
      if (
        entry !== profile &&
        (await lstat(config).catch(() => undefined))?.isFile() &&
        (await realpath(config)) === source
      )
        owner = true;
    }
    if (!owner) return false;
    const bytes = await readFile(source, "utf8");
    if (managedText(bytes) || JSON.parse(bytes).enabledPlugins?.["clankie-worker@clankie"] !== true)
      return false;
    const installed = JSON.parse(await readFile(join(profile, "plugins", "installed_plugins.json"), "utf8"));
    if (
      !installed.plugins?.["clankie-worker@clankie"]?.some(
        (entry) => entry.scope === "user" && typeof entry.installPath === "string",
      )
    )
      return false;
    const registered = JSON.parse(await readFile(join(profile, "plugins", "known_marketplaces.json"), "utf8"))
      .clankie?.source;
    return (
      registered?.source === "directory" &&
      ((await realpath(registered.path)) === (await realpath(marketplace)) ||
        (relocate && (await clankieMarketplace(registered.path))))
    );
  } catch {
    return false;
  }
}
async function installHarnessBridges(options) {
  const env = options.env ?? process.env;
  const run =
    options.execute ??
    (async (command, args, targetEnv) =>
      exec(command === "codex" ? await nativeCodexExecutable({ env: targetEnv }) : command, [...args], {
        env: targetEnv,
        timeout: 12e4,
      }));
  const home = env.HOME || env.USERPROFILE || homedir();
  const marketplace = options.marketplaceRoot ?? join(options.repoRoot, "integrations", "claude-plugin");
  const results = [];
  const remembered = await linkedProfiles(home);
  const profiles = [
    ...new Set([
      ...(await claudeProfileDirectories(env)),
      ...remembered.filter((entry) => entry.harness === "claude").map((entry) => entry.profile),
    ]),
  ];
  const codexProfiles = options.linkedOnly
    ? [
        ...new Set([
          env.CODEX_HOME || join(home, ".codex"),
          ...(options.codexHomes ?? []),
          ...remembered.filter((entry) => entry.harness === "codex").map((entry) => entry.profile),
          ...(await readdir(home, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory() && /^\.codex(?:-.*|\d+)$/u.test(entry.name))
            .map((entry) => join(home, entry.name)),
        ]),
      ]
    : [env.CODEX_HOME || join(home, ".codex")];
  const targets = [
    ...profiles.map((profile) => ({ harness: "claude", profile })),
    ...codexProfiles.map((codexProfile) => ({
      harness: "codex",
      profile: options.linkedOnly ? codexProfile : undefined,
      codexProfile,
    })),
  ];
  for (const { harness, profile, codexProfile } of targets) {
    if (options.linkedOnly && harness === "claude" && !(await linkedClaude(profile))) continue;
    const targetEnv = {
      ...env,
      ...(harness === "claude" ? { CLAUDE_CONFIG_DIR: profile } : { CODEX_HOME: codexProfile }),
    };
    const execute = (command, args) => run(command, args, targetEnv);
    try {
      await execute(harness, ["--version"]);
    } catch {
      if (options.linkedOnly && harness === "codex") {
        const config = await readFile(join(codexProfile, "config.toml"), "utf8").catch(() => "");
        const cached = await readdir(
          join(codexProfile, "plugins", "cache", "clankie-fleet", "clankie-worker"),
        ).catch(() => []);
        if (
          !/(?:clankie-worker@clankie-fleet|\[mcp_servers\.(?:"(?:clankie|worker)"|'(?:clankie|worker)'|clankie|worker)\])/u.test(
            config,
          ) &&
          !cached.length &&
          !(await lstat(sourceRecord(codexProfile)).catch(() => undefined))
        )
          continue;
      }
      results.push({
        harness,
        profile,
        status: "absent",
        detail: "Harness executable unavailable on this machine.",
      });
      continue;
    }
    const config = harness === "claude" ? join(profile, "settings.json") : join(codexProfile, "config.toml");
    const source = await realpath(config).catch(() => config);
    const configBefore = await readFile(config, "utf8").catch(() => undefined);
    const sourceSetup =
      harness === "codex"
        ? (options.codexSourceSetup ??
          (options.linkedOnly ? await rememberedSourceSetup(codexProfile, source) : undefined))
        : undefined;
    if (options.linkedOnly && harness === "codex") {
      let plugins = [];
      try {
        const output = await execute(harness, ["plugin", "list", "--json"]);
        const list = JSON.parse(typeof output === "string" ? output : output.stdout);
        plugins = Array.isArray(list) ? list : (list.installed ?? list.plugins ?? []);
      } catch {
        /* A legacy bridge or approved source setup can still be repaired. */
      }
      if (
        plugins.some(
          (entry) =>
            [entry.id, entry.pluginId].includes("clankie-worker@clankie-fleet") && entry.enabled === false,
        )
      ) {
        results.push({
          harness,
          profile,
          status: "declined",
          detail:
            "The Codex worker plugin is disabled. Native installation would enable it; review clankie harness install before refreshing this profile.",
        });
        continue;
      }
      const linked =
        plugins.some((entry) => [entry.id, entry.pluginId].includes("clankie-worker@clankie-fleet")) ||
        /(?:clankie-worker@clankie-fleet|\[mcp_servers\.(?:"(?:clankie|worker)"|'(?:clankie|worker)'|clankie|worker)\])/u.test(
          configBefore ?? "",
        ) ||
        sourceSetup;
      if (!linked) continue;
    }
    const wasSymlink = (await lstat(config).catch(() => void 0))?.isSymbolicLink() ?? false;
    const linkBefore = wasSymlink ? await readlink(config) : undefined;
    const managed =
      wasSymlink ||
      /(?:generated|do not edit|managed by)/iu.test(
        (await readFile(config, "utf8").catch(() => "")).split("\n").slice(0, 20).join("\n"),
      );
    const aliasUpdate =
      harness === "claude" &&
      managed &&
      (await updatableClaudeAlias(profile, profiles, source, marketplace, options.linkedOnly));
    const pluginId = harness === "claude" ? "clankie-worker@clankie" : "clankie-worker@clankie-fleet";
    const detail = aliasUpdate
      ? `Update the existing clankie-worker cache for alias profile ${profile}; shared settings at ${source} stay unchanged.`
      : harness === "claude" && !managed
        ? `Install and enable clankie-worker@clankie from ${marketplace} for profile ${profile} (bridge, native hooks and packaged skills).`
        : managed
          ? `${harness} configuration is managed at ${source}. ${sourceSetup ? `Run source setup ${sourceSetup.command} to install ${pluginId}.` : `Use its source setup to install ${pluginId}; no config file will be modified here.`}`
          : `Install clankie-worker@clankie-fleet from ${marketplace} through Codex's native plugin manager (bridge and skills).`;
    // Missing source setup is a setup refusal, not a declined consent prompt.
    if (managed && !sourceSetup && !aliasUpdate) {
      results.push({
        harness,
        profile: harness === "codex" ? codexProfile : profile,
        status: "source-manager-required",
        detail:
          harness === "codex"
            ? `source-managed: needs setup in ${codexProfile}. Configuration source: ${source}. Have its owner provide a source-owned script, then run clankie harness install --codex-source-setup /absolute/source-owned/script --approve in this profile. Preserve the configuration link.`
            : `source-managed: needs setup in ${profile}. Apply the worker plugin setup through the owner of ${source}; preserve the configuration link.`,
      });
      continue;
    }
    if (
      !(await options.consent(harness, detail, {
        profile: harness === "claude" ? profile : codexProfile,
        source,
        managed,
        ...(sourceSetup ? { sourceSetup } : {}),
      }))
    ) {
      results.push({ harness, profile, status: "declined", detail });
      continue;
    }
    try {
      await (options.prepareSkills ?? prepareWorkerSkill)(join(marketplace, "worker"));
      if (
        (await realpath(config).catch(() => config)) !== source ||
        (await readFile(config, "utf8").catch(() => undefined)) !== configBefore ||
        (wasSymlink && (await readlink(config).catch(() => undefined)) !== linkBefore)
      )
        throw new Error("Harness configuration changed during consent; inspect its source and retry");
      if (aliasUpdate) {
        if (!(await updatableClaudeAlias(profile, profiles, source, marketplace, options.linkedOnly)))
          throw new Error("Claude profile alias or marketplace changed during consent; inspect and retry");
        const checkAlias = async () => {
          if (!(await updatableClaudeAlias(profile, profiles, source, marketplace, options.linkedOnly)))
            throw new Error(
              "Claude alias plugin, enabled settings, or marketplace changed; inspect and retry",
            );
          if (
            (await realpath(config)) !== source ||
            !(await lstat(config)).isSymbolicLink() ||
            (await readlink(config)) !== linkBefore ||
            (await readFile(source, "utf8")) !== configBefore ||
            !(await lstat(source)).isFile()
          )
            throw new Error(
              "Native update changed shared Claude configuration; inspect its source before continuing",
            );
        };
        await checkAlias();
        const registered = (await json(join(profile, "plugins", "known_marketplaces.json"))).clankie.source;
        if ((await realpath(registered.path)) !== (await realpath(marketplace)))
          await execute(harness, ["plugin", "marketplace", "add", marketplace]);
        else await execute(harness, ["plugin", "marketplace", "update", "clankie"]);
        await checkAlias();
        await execute(harness, ["plugin", "update", "clankie-worker@clankie", "--scope", "user"]);
        await checkAlias();
      } else if (managed) {
        await run(sourceSetup.command, sourceSetup.args, {
          ...targetEnv,
          CLANKIE_CODEX_WORKER_MARKETPLACE: marketplace,
          CLANKIE_CODEX_NATIVE_EXECUTABLE: await nativeCodexExecutable({ env: targetEnv }),
          CODEX_HOME: codexProfile,
        });
        if (
          (await realpath(config)) !== source ||
          (await lstat(config)).isSymbolicLink() !== wasSymlink ||
          (wasSymlink && (await readlink(config)) !== linkBefore)
        )
          throw new Error(
            "Source setup changed the managed configuration link; inspect its source before continuing",
          );
      } else {
        if (harness === "claude") {
          const known = JSON.parse(
            await readFile(join(profile, "plugins", "known_marketplaces.json"), "utf8").catch(() => "{}"),
          );
          const registered = known.clankie?.source;
          if (registered) {
            if (
              registered.source !== "directory" ||
              (await realpath(registered.path)) !== (await realpath(marketplace))
            )
              if (
                !(
                  options.linkedOnly &&
                  registered.source === "directory" &&
                  (await clankieMarketplace(registered.path))
                )
              )
                throw new Error(
                  `The clankie marketplace in ${profile} has a different source; review it with the native plugin manager`,
                );
            if ((await realpath(registered.path)) !== (await realpath(marketplace)))
              await execute(harness, ["plugin", "marketplace", "add", marketplace]);
            else await execute(harness, ["plugin", "marketplace", "update", "clankie"]);
          } else await execute(harness, ["plugin", "marketplace", "add", marketplace]);
        } else if (options.linkedOnly) await refreshCodexMarketplace(execute, marketplace);
        else await execute(harness, ["plugin", "marketplace", "add", marketplace]);
        if (harness === "claude") {
          if (!options.linkedOnly)
            await execute(harness, ["plugin", "install", "clankie-worker@clankie", "--scope", "user"]);
          await execute(harness, ["plugin", "update", "clankie-worker@clankie", "--scope", "user"]);
          if (!options.linkedOnly)
            try {
              await execute(harness, ["plugin", "enable", "clankie-worker@clankie", "--scope", "user"]);
            } catch (error) {
              if (!(await confirmClaudeWorkerEnabled(error, { profile, source, configBefore }))) throw error;
            }
        } else await execute(harness, ["plugin", "add", "clankie-worker@clankie-fleet", "--json"]);
      }
      if (harness === "codex" && managed && options.codexSourceSetup)
        await rememberSourceSetup(codexProfile, source, sourceSetup);
      if (options.linkedOnly) {
        const expectedVersion = (await json(join(marketplace, "worker", ".claude-plugin", "plugin.json")))
          .version;
        const inspection = await inspectHarnessProfiles({
          env: targetEnv,
          expectedVersion,
          execute: async (command, args) => {
            const output = await run(command, args, targetEnv);
            return typeof output === "string" ? output : output.stdout;
          },
        });
        const observed =
          harness === "claude"
            ? inspection.claude.find((entry) => entry.profile === profile)
            : inspection.codex;
        if (
          !observed?.versionMatches ||
          !observed.bridge ||
          !observed.skill ||
          (harness === "claude" ? !observed.hooks : !observed.identityForwarding)
        )
          throw new Error(
            `Native ${harness} refresh did not verify version ${expectedVersion}, bridge and packaged skill; inspect clankie doctor`,
          );
      }
      if (!options.linkedOnly)
        await rememberProfile(home, harness, harness === "claude" ? profile : codexProfile);
      results.push({
        harness,
        profile,
        status:
          aliasUpdate || (options.linkedOnly && !managed)
            ? "updated"
            : managed
              ? "source-setup-completed"
              : "installed",
        detail:
          "Setup completed. Restart this harness and use doctor to inspect activation, skill presence and live membership; installation alone grants no tools.",
      });
    } catch (error) {
      results.push({
        harness,
        profile,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
export { installHarnessBridges, confirmClaudeWorkerEnabled };

/** Execute an owner-selected source script without a shell or a config rewrite. */
export function codexSourceSetupCommand(
  script,
  { platform = process.platform, node = process.execPath } = {},
) {
  if (!(platform === "win32" ? win32 : posix).isAbsolute(script) || /\p{Cc}/u.test(script))
    throw new Error("Codex source setup must be an absolute source-owned script path");
  if (/\.m?js$/iu.test(script)) return { command: node, args: [script] };
  if (/\.py$/iu.test(script))
    return {
      command: platform === "win32" ? "py" : "python3",
      args: [...(platform === "win32" ? ["-3"] : []), script],
    };
  if (platform === "win32" && /\.ps1$/iu.test(script))
    return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-File", script] };
  return { command: script, args: [] };
}
