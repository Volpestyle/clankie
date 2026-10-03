import { claudeProfileDirectories } from "./harness-status.mjs";
import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
async function installHarnessBridges(options) {
  const env = options.env ?? process.env;
  const run =
    options.execute ??
    ((command, args, targetEnv) => exec(command, [...args], { env: targetEnv, timeout: 12e4 }));
  const home = env.HOME || env.USERPROFILE || homedir();
  const marketplace = options.marketplaceRoot ?? join(options.repoRoot, "integrations", "claude-plugin");
  const results = [];
  const targets = [
    ...(await claudeProfileDirectories(env)).map((profile) => ({ harness: "claude", profile })),
    { harness: "codex", profile: void 0 },
  ];
  for (const { harness, profile } of targets) {
    const targetEnv = { ...env, ...(profile ? { CLAUDE_CONFIG_DIR: profile } : {}) };
    const execute = (command, args) => run(command, args, targetEnv);
    try {
      await execute(harness, ["--version"]);
    } catch {
      results.push({
        harness,
        profile,
        status: "absent",
        detail: "Harness executable unavailable on this machine.",
      });
      continue;
    }
    const config =
      harness === "claude"
        ? join(profile, "settings.json")
        : join(env.CODEX_HOME || join(home, ".codex"), "config.toml");
    const sourceSetup = harness === "codex" ? options.codexSourceSetup : undefined;
    const source = await realpath(config).catch(() => config);
    const configBefore = await readFile(config, "utf8").catch(() => undefined);
    const wasSymlink = (await lstat(config).catch(() => void 0))?.isSymbolicLink() ?? false;
    const managed =
      wasSymlink ||
      /(?:generated|do not edit|managed by)/iu.test(
        (await readFile(config, "utf8").catch(() => "")).split("\n").slice(0, 20).join("\n"),
      );
    const detail =
      harness === "claude" && !managed
        ? `Install and enable clankie-worker@clankie from ${marketplace} for profile ${profile} (bridge, native hooks and packaged skills).`
        : managed
          ? `${harness} configuration is managed at ${source}. ${sourceSetup ? `Run source setup ${sourceSetup.command} to install clankie-worker@clankie-fleet.` : "Use its source setup to install clankie-worker@clankie-fleet; no config file will be modified here."}`
          : `Install clankie-worker@clankie-fleet from ${marketplace} through Codex's native plugin manager (bridge and skills).`;
    if (!(await options.consent(harness, detail))) {
      results.push({ harness, profile, status: "declined", detail });
      continue;
    }
    if (managed && !sourceSetup) {
      results.push({ harness, profile, status: "source-manager-required", detail });
      continue;
    }
    try {
      if (
        (await realpath(config).catch(() => config)) !== source ||
        (await readFile(config, "utf8").catch(() => undefined)) !== configBefore
      )
        throw new Error("Harness configuration changed during consent; inspect its source and retry");
      if (managed) {
        await execute(sourceSetup.command, sourceSetup.args);
        if ((await realpath(config)) !== source || (await lstat(config)).isSymbolicLink() !== wasSymlink)
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
              throw new Error(
                `The clankie marketplace in ${profile} has a different source; review it with the native plugin manager`,
              );
            await execute(harness, ["plugin", "marketplace", "update", "clankie"]);
          } else await execute(harness, ["plugin", "marketplace", "add", marketplace]);
        } else await execute(harness, ["plugin", "marketplace", "add", marketplace]);
        if (harness === "claude") {
          await execute(harness, ["plugin", "install", "clankie-worker@clankie", "--scope", "user"]);
          await execute(harness, ["plugin", "update", "clankie-worker@clankie", "--scope", "user"]);
          await execute(harness, ["plugin", "enable", "clankie-worker@clankie", "--scope", "user"]);
        } else await execute(harness, ["plugin", "add", "clankie-worker@clankie-fleet", "--json"]);
      }
      results.push({
        harness,
        profile,
        status: managed ? "source-setup-completed" : "installed",
        detail:
          "Native installation completed. Restart this harness and use doctor to inspect activation, skill presence and live membership; installation alone grants no tools.",
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
