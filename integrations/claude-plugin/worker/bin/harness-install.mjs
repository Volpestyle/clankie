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
const WORKER = "clankie-worker@clankie";
/**
 * What an older setup left in a Claude profile: Clankie's installed worker and,
 * when no other Clankie plugin is installed from it, the `clankie` marketplace.
 * Claude hires load the worker from Clankie's own files (ADR 0317).
 */
async function legacyClaudeWorker(profile) {
  const known = await json(join(profile, "plugins", "known_marketplaces.json")).catch(() => ({}));
  const installed = await json(join(profile, "plugins", "installed_plugins.json")).catch(() => ({}));
  const plugins = installed.plugins ?? {};
  const worker = Array.isArray(plugins[WORKER]) && plugins[WORKER].some((entry) => entry.scope === "user");
  const otherFromClankie = Object.keys(plugins).some((id) => id !== WORKER && id.endsWith("@clankie"));
  return { worker, marketplace: Boolean(known.clankie) && !otherFromClankie };
}
/** Remove the old worker copy from one profile; undefined when there is nothing to remove. */
async function removeClaudeWorker({ profile, execute, consent }) {
  const legacy = await legacyClaudeWorker(profile);
  if (!legacy.worker && !legacy.marketplace) return undefined;
  try {
    await execute("claude", ["--version"]);
  } catch {
    return { status: "absent", detail: "Harness executable unavailable on this machine." };
  }
  const config = join(profile, "settings.json");
  const source = await realpath(config).catch(() => config);
  const configBefore = await readFile(config, "utf8").catch(() => undefined);
  const wasSymlink = (await lstat(config).catch(() => undefined))?.isSymbolicLink() ?? false;
  const linkBefore = wasSymlink ? await readlink(config) : undefined;
  const managed = wasSymlink || managedText(configBefore ?? "");
  if (managed) {
    let declared = {};
    try {
      declared = JSON.parse(configBefore ?? "{}");
    } catch {
      /* An unreadable source declares nothing this setup can see. */
    }
    const entries = [
      ...(declared.enabledPlugins?.[WORKER] !== undefined ? [`enabledPlugins["${WORKER}"]`] : []),
      ...(legacy.marketplace && declared.extraKnownMarketplaces?.clankie !== undefined
        ? ["extraKnownMarketplaces.clankie"]
        : []),
    ];
    if (entries.length > 0)
      return {
        status: "source-manager-required",
        detail: `source-managed: ${profile} still declares the old worker copy in ${source}. Remove ${entries.join(" and ")} there through its owner, then run setup again to clear this profile's cached copy; preserve the configuration link. Claude hires load the worker from Clankie's own files (ADR 0317).`,
      };
  }
  const detail = `Remove the old ${WORKER} copy${legacy.marketplace ? " and its clankie marketplace" : ""} from profile ${profile}: Claude hires load the worker from Clankie's own files now (ADR 0317).`;
  if (!(await consent("claude", detail, { profile, source, managed }))) return { status: "declined", detail };
  const unchanged = async () => {
    if (
      managed &&
      ((await realpath(config).catch(() => config)) !== source ||
        (await readFile(config, "utf8").catch(() => undefined)) !== configBefore ||
        (wasSymlink && (await readlink(config).catch(() => undefined)) !== linkBefore))
    )
      throw new Error(
        `Removing the old worker copy changed the Claude settings source ${source}; inspect it through its owner`,
      );
  };
  try {
    await unchanged();
    if (legacy.worker) await execute("claude", ["plugin", "uninstall", WORKER, "--scope", "user"]);
    await unchanged();
    if (legacy.marketplace) await execute("claude", ["plugin", "marketplace", "remove", "clankie"]);
    await unchanged();
    const after = await legacyClaudeWorker(profile);
    if (after.worker || after.marketplace)
      throw new Error(
        `Claude still lists the old worker copy in ${profile}; inspect it with claude plugin list`,
      );
    return {
      status: "removed",
      detail:
        "Removed the old worker copy. Claude hires load the worker from Clankie's own files; a hand-started session drops the old copy when it restarts.",
    };
  } catch (error) {
    return { status: "failed", detail: error instanceof Error ? error.message : String(error) };
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
  // A profile whose refresh failed or was refused can still be repaired here.
  const refreshed = new Set(
    (options.refreshed ?? []).flatMap((entry) =>
      ["installed", "updated", "removed", "source-setup-completed"].includes(entry.status) && entry.profile
        ? [entry.profile]
        : [],
    ),
  );
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
            .filter(
              (entry) =>
                entry.isDirectory() &&
                /^\.codex(?:-.*|\d+)$/u.test(entry.name) &&
                !entry.name.endsWith(".lock"),
            )
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
  // Claude hires load this worker directory as it is (ADR 0317), so its bundled
  // skills are materialized here whether or not any profile is touched. A
  // failure surfaces on the Codex installs that need the same skills.
  let skills;
  const prepareSkills = () =>
    (skills ??= Promise.resolve().then(() =>
      (options.prepareSkills ?? prepareWorkerSkill)(join(marketplace, "worker")),
    ));
  await prepareSkills().catch(() => {});
  for (const { harness, profile, codexProfile } of targets) {
    if (refreshed.has(harness === "claude" ? profile : codexProfile)) continue;
    if (harness === "claude") {
      // Claude workers need no install any more; setup and refresh only clear an older copy.
      const removal = await removeClaudeWorker({
        profile,
        execute: (command, args) => run(command, args, { ...env, CLAUDE_CONFIG_DIR: profile }),
        consent: options.consent,
      });
      if (removal) results.push({ harness, profile, ...removal });
      continue;
    }
    const targetEnv = { ...env, CODEX_HOME: codexProfile };
    const execute = (command, args) => run(command, args, targetEnv);
    try {
      await execute(harness, ["--version"]);
    } catch {
      if (options.linkedOnly) {
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
    const config = join(codexProfile, "config.toml");
    const source = await realpath(config).catch(() => config);
    const configBefore = await readFile(config, "utf8").catch(() => undefined);
    const sourceSetup =
      options.codexSourceSetup ??
      (options.linkedOnly ? await rememberedSourceSetup(codexProfile, source) : undefined);
    if (options.linkedOnly) {
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
    const pluginId = "clankie-worker@clankie-fleet";
    const detail = managed
      ? `${harness} configuration is managed at ${source}. ${sourceSetup ? `Run source setup ${sourceSetup.command} to install ${pluginId}.` : `Use its source setup to install ${pluginId}; no config file will be modified here.`}`
      : `Install clankie-worker@clankie-fleet from ${marketplace} through Codex's native plugin manager (bridge and skills).`;
    // Missing source setup is a setup refusal, not a declined consent prompt.
    if (managed && !sourceSetup) {
      results.push({
        harness,
        profile: codexProfile,
        status: "source-manager-required",
        detail: `source-managed: needs setup in ${codexProfile}. Configuration source: ${source}. Have its owner provide a source-owned script, then run clankie harness install --codex-source-setup /absolute/source-owned/script --approve in this profile. Preserve the configuration link.`,
      });
      continue;
    }
    if (
      !(await options.consent(harness, detail, {
        profile: codexProfile,
        source,
        managed,
        ...(sourceSetup ? { sourceSetup } : {}),
      }))
    ) {
      results.push({ harness, profile, status: "declined", detail });
      continue;
    }
    try {
      await prepareSkills();
      if (
        (await realpath(config).catch(() => config)) !== source ||
        (await readFile(config, "utf8").catch(() => undefined)) !== configBefore ||
        (wasSymlink && (await readlink(config).catch(() => undefined)) !== linkBefore)
      )
        throw new Error("Harness configuration changed during consent; inspect its source and retry");
      if (managed) {
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
        if (options.linkedOnly) await refreshCodexMarketplace(execute, marketplace);
        else await execute(harness, ["plugin", "marketplace", "add", marketplace]);
        await execute(harness, ["plugin", "add", "clankie-worker@clankie-fleet", "--json"]);
      }
      if (managed && options.codexSourceSetup) await rememberSourceSetup(codexProfile, source, sourceSetup);
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
        const observed = inspection.codex;
        if (!observed?.versionMatches || !observed.bridge || !observed.skill || !observed.identityForwarding)
          throw new Error(
            `Native ${harness} refresh did not verify version ${expectedVersion}, bridge and packaged skill; inspect clankie doctor`,
          );
      }
      if (!options.linkedOnly) await rememberProfile(home, harness, codexProfile);
      results.push({
        harness,
        profile,
        status: options.linkedOnly && !managed ? "updated" : managed ? "source-setup-completed" : "installed",
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
export { installHarnessBridges };

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
