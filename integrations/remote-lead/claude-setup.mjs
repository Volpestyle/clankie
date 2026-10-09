// Prepare only Clankie's lead plugin in an existing signed-in native profile.
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const leadPlugin = "clankie-remote-lead@clankie-remote-leads";
const parse = (text, detail) => {
  try {
    return JSON.parse(text);
  } catch {
    // Node's SyntaxError may quote private configuration fragments.
    throw new Error(detail);
  }
};

export async function prepareClaude(executable, plugin, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const invoke = async (args, profile) => {
    try {
      return (
        await execute(executable, args, {
          env: { ...env, CLAUDE_CONFIG_DIR: profile },
          timeout: 60000,
        })
      ).stdout;
    } catch {
      // Native stderr may contain provider/configuration secrets.
      throw new Error(`Native Claude ${args.slice(0, 3).join(" ")} failed; inspect that profile on the PC`);
    }
  };
  const candidates = env.CLAUDE_CONFIG_DIR
    ? [env.CLAUDE_CONFIG_DIR]
    : [
        join(home, ".claude"),
        ...(await readdir(home, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && /^\.claude(?:-.*|\d+)$/u.test(entry.name))
          .map((entry) => join(home, entry.name)),
      ];
  const signed = new Set();
  for (const profile of candidates) {
    try {
      const existing = await realpath(profile); // Never manufacture a profile or copy credentials.
      const status = JSON.parse(await invoke(["auth", "status"], existing));
      if (status.loggedIn === true && status.authMethod === "claude.ai") signed.add(existing);
    } catch {
      /* An absent or logged-out profile is not a launch target. */
    }
  }
  if (signed.size !== 1)
    throw new Error(
      signed.size
        ? "Multiple signed-in Claude profiles; select the PC profile with CLAUDE_CONFIG_DIR"
        : "No existing signed-in Claude.ai profile; James must sign in to the intended PC profile",
    );
  const [profile] = signed;

  const policyPath = options.policyPath ?? "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  const text = await readFile(policyPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{}";
    throw new Error(`Cannot read channel policy at ${policyPath}`);
  });
  const policy = parse(text, `Invalid channel policy at ${policyPath}; leaving it untouched`);
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    (policy.allowedChannelPlugins !== undefined && !Array.isArray(policy.allowedChannelPlugins))
  )
    throw new Error(`Invalid channel policy at ${policyPath}; leaving it untouched`);
  if (policy.channelsEnabled === false)
    throw new Error(
      `Channel policy disables channels at ${policyPath}; James must approve remote lead channels`,
    );
  const entry = { marketplace: "clankie-remote-leads", plugin: "clankie-remote-lead" };
  const allowed = policy.allowedChannelPlugins ?? [];
  if (
    policy.channelsEnabled !== true ||
    !allowed.some((value) => value?.marketplace === entry.marketplace && value.plugin === entry.plugin)
  ) {
    // Same additive managed-policy setup as herdr prepare; never weaken permissions.
    const next = { ...policy, channelsEnabled: true, allowedChannelPlugins: [...allowed, entry] };
    try {
      await mkdir(dirname(policyPath), { recursive: true });
      if ((await readFile(policyPath, "utf8").catch(() => "{}")) !== text)
        throw new Error("Channel policy changed during preparation");
      await writeFile(policyPath, JSON.stringify(next, null, 2) + "\n");
    } catch {
      throw new Error(`James must approve ${leadPlugin} in ${policyPath} as the PC administrator`);
    }
  }
  const knownPath = join(profile, "plugins", "known_marketplaces.json");
  const known = parse(
    await readFile(knownPath, "utf8").catch(() => "{}"),
    "Invalid native marketplace registry; inspect that profile on the PC",
  );
  const source = known["clankie-remote-leads"]?.source;
  if (source) {
    const fromRoot =
      typeof source.path === "string" ? relative(join(home, ".clankie", "remote-leads"), source.path) : "..";
    if (
      source.source !== "directory" ||
      isAbsolute(fromRoot) ||
      fromRoot === ".." ||
      fromRoot.startsWith(".." + (process.platform === "win32" ? "\\" : "/"))
    )
      throw new Error("Remote lead marketplace has a different source; inspect it before launch");
  }
  if (!source || (await realpath(source.path)) !== (await realpath(plugin)))
    await invoke(["plugin", "marketplace", "add", plugin], profile);
  else await invoke(["plugin", "marketplace", "update", "clankie-remote-leads"], profile);
  const installed = parse(
    await invoke(["plugin", "list", "--json"], profile),
    "Invalid native plugin list; inspect that profile on the PC",
  );
  if (!Array.isArray(installed))
    throw new Error("Invalid native plugin list; inspect that profile on the PC");
  const exists = installed.some((value) => value.id === leadPlugin);
  await invoke(["plugin", exists ? "update" : "install", leadPlugin, "--scope", "user"], profile);
  // Install records are required for channel registration. Keep activation
  // session-only so ordinary PC sessions never acquire lead hooks or authority.
  await invoke(["plugin", "disable", leadPlugin, "--scope", "user"], profile);
  return profile;
}
