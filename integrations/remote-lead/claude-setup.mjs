// Prepare only Clankie's lead plugin in an existing signed-in native profile.
import { execFile } from "node:child_process";
import { readFile, readdir, realpath, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, relative, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const leadPlugin = "clankie-remote-lead@clankie-remote-leads";
const leadServer = "plugin:clankie-remote-lead:lead";
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
  const account = options.account;
  // Validate again on the target before resolving a path or invoking Claude.
  if (account !== undefined && (typeof account !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(account)))
    throw new Error(
      "Invalid Claude account label; use 1-64 lowercase letters, digits, underscores or hyphens, starting with a letter",
    );
  const invoke = async (args, profile, allowAlreadyDisabled = false) => {
    try {
      return (
        await execute(executable, args, {
          env: { ...env, CLAUDE_CONFIG_DIR: profile },
          timeout: 60000,
        })
      ).stdout;
    } catch (error) {
      if (allowAlreadyDisabled && error.code === 1) {
        // Native Claude treats an already-disabled plugin as a nonzero result.
        // Accept only its structured, exact user-scope goal-state receipt.
        try {
          const result = JSON.parse(error.stdout);
          if (
            result.command === "disable" &&
            result.plugin === leadPlugin &&
            result.scope === "user" &&
            result.failureCode === "already_in_goal_state" &&
            result.alreadyInGoalState === true
          )
            return error.stdout;
        } catch {
          /* Other failures retain the redacted native error below. */
        }
      }
      // Native stderr may contain provider/configuration secrets.
      throw new Error(`Native Claude ${args.slice(0, 3).join(" ")} failed; inspect that profile on the PC`);
    }
  };
  const candidates =
    account !== undefined
      ? [join(home, `.claude-${account}`)]
      : env.CLAUDE_CONFIG_DIR
        ? [env.CLAUDE_CONFIG_DIR]
        : [
            join(home, ".claude"),
            ...(await readdir(home, { withFileTypes: true }))
              .filter((entry) => entry.isDirectory() && /^\.claude(?:-.*|\d+)$/u.test(entry.name))
              .map((entry) => join(home, entry.name)),
          ];
  const signed = new Set();
  let accountFailure = "does not exist or cannot be accessed";
  for (const profile of candidates) {
    try {
      const existing = await realpath(profile); // Never manufacture a profile or copy credentials.
      accountFailure = "could not verify native Claude sign-in";
      const status = JSON.parse(await invoke(["auth", "status"], existing));
      if (status.loggedIn === true && status.authMethod === "claude.ai") signed.add(existing);
      else accountFailure = "is not signed in to Claude.ai";
    } catch {
      /* An absent or logged-out profile is not a launch target. */
    }
  }
  if (signed.size !== 1)
    throw new Error(
      account !== undefined
        ? `Claude account '${account}' at ~/.claude-${account} ${accountFailure}; sign in to the intended profile on the PC with $env:CLAUDE_CONFIG_DIR = Join-Path $HOME '.claude-${account}'; claude auth login, then retry. Launch never creates a profile or copies credentials`
        : signed.size
          ? "Multiple signed-in Claude profiles; select an account label in the launch request or the PC profile with CLAUDE_CONFIG_DIR"
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
  await invoke(["plugin", "disable", leadPlugin, "--scope", "user", "--json"], profile, true);
  const after = parse(
    await invoke(["plugin", "list", "--json"], profile),
    "Invalid native plugin list; inspect that profile on the PC",
  );
  if (
    !Array.isArray(after) ||
    !after.some((value) => value.id === leadPlugin && value.scope === "user" && value.enabled === false)
  )
    throw new Error(
      "Native Claude lead plugin is not disabled at user scope; inspect that profile on the PC",
    );
  // Herdr learns a pane's session only from its own SessionStart hook in this
  // profile; without it the lead's proof stays pending and every call is refused (VUH-2074).
  const herdr = async (args) => {
    try {
      return (
        await execute(options.herdr ?? "herdr", args, {
          env: { ...env, CLAUDE_CONFIG_DIR: profile },
          timeout: 30000,
        })
      ).stdout;
    } catch {
      return "";
    }
  };
  const herdrCurrent = async () => /^claude: current\b/mu.test(await herdr(["integration", "status"]));
  if (!(await herdrCurrent())) {
    await herdr(["integration", "install", "claude"]);
    if (!(await herdrCurrent()))
      throw new Error(
        `Herdr's Claude integration is not installed in ${profile}; on the PC run $env:CLAUDE_CONFIG_DIR = '${profile}'; herdr integration install claude, then retry`,
      );
  }
  // An earlier lead whose bridge timed out leaves its server marked as needing
  // auth, and every later session in this profile skips it (VUH-2074).
  const authCachePath = join(profile, "mcp-needs-auth-cache.json");
  const authCacheText = await readFile(authCachePath, "utf8").catch(() => undefined);
  if (authCacheText !== undefined) {
    const authCache = parse(authCacheText, "Invalid native MCP auth cache; inspect that profile on the PC");
    if (authCache && typeof authCache === "object" && Object.hasOwn(authCache, leadServer)) {
      delete authCache[leadServer];
      await writeFile(authCachePath, JSON.stringify(authCache));
    }
  }
  return profile;
}
