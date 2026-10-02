/**
 * Which harnesses on this machine can drive the owner's real desktop or
 * browser ([ADR 0199](../../../docs/adr/0199-hard-computer-work-goes-to-a-computer-use-harness.md)).
 *
 * Detection only: nothing here starts a harness, opens a window or touches the
 * owner's apps. Each probe reads the harness's own answer — its CLI's login
 * and feature reports, its own config — rather than guessing from a binary on
 * PATH, because an installed harness that is signed out or has the capability
 * switched off is not one Clankie can hand work to.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** What a harness can drive: native Mac apps, or the owner's own signed-in Chrome. */
type ComputerUseSurface = "desktop" | "chrome";

export interface ComputerUseHarness {
  readonly harness: "codex" | "claude";
  readonly signedIn: boolean;
  /** Surfaces the harness has switched on. Empty means installed but not computer-use-capable here. */
  readonly surfaces: readonly ComputerUseSurface[];
  /** A hire needs `chrome: true` for the Chrome surface (claude without Chrome on by default). */
  readonly chromeNeedsHireFlag: boolean;
  /** Why it cannot take computer work yet, and what the owner does about it. */
  readonly missing?: string;
}

export interface ComputerUseProbe {
  /** Run a command; undefined when it is absent, times out, or cannot start. */
  run(command: string, args: readonly string[]): Promise<{ status: number; output: string } | undefined>;
  /** A file's text, undefined when it does not exist or cannot be read. */
  readText(path: string): Promise<string | undefined>;
  readonly home: string;
}

const PROBE_TIMEOUT_MS = 8_000;
const CHROME_NATIVE_HOSTS = "Library/Application Support/Google/Chrome/NativeMessagingHosts";

function localComputerUseProbe(): ComputerUseProbe {
  return {
    run: (command, args) =>
      new Promise((resolve) => {
        execFile(
          command,
          [...args],
          { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            // A missing binary or a killed probe is "not available", not a status.
            if (code === "ENOENT" || error?.killed === true) return resolve(undefined);
            const status = error === null ? 0 : typeof code === "number" ? code : 1;
            resolve({ status, output: `${stdout}\n${stderr}` });
          },
        );
      }),
    readText: (path) => readFile(path, "utf8").catch(() => undefined),
    home: homedir(),
  };
}

/** `codex features list` rows: `name  stage  true|false`. */
export function parseCodexFeatures(output: string): ReadonlyMap<string, boolean> {
  const features = new Map<string, boolean>();
  for (const line of output.split("\n")) {
    const match = /^([a-z0-9_]+)\s+.*\s(true|false)\s*$/u.exec(line.trim());
    if (match !== null) features.set(match[1]!, match[2] === "true");
  }
  return features;
}

/**
 * Whether the owner switched a Codex plugin off in `config.toml`. Only an
 * explicit `enabled = false` counts: an absent table is Codex's own default,
 * which the feature flag already reports.
 */
export function codexPluginDisabled(config: string, plugin: string): boolean {
  const lines = config.split("\n");
  const header = new RegExp(
    `^\\[\\s*"?plugins"?\\s*\\.\\s*"${plugin.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"\\s*\\]\\s*$`,
    "u",
  );
  const start = lines.findIndex((line) => header.test(line.trim()));
  if (start === -1) return false;
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) return false;
    const enabled = /^"?enabled"?\s*=\s*(true|false)\b/u.exec(trimmed);
    if (enabled !== null) return enabled[1] === "false";
  }
  return false;
}

async function probeCodex(probe: ComputerUseProbe): Promise<ComputerUseHarness | undefined> {
  const login = await probe.run("codex", ["login", "status"]);
  if (login === undefined) return undefined;
  const signedIn = login.status === 0 && /logged in/iu.test(login.output);
  const features = parseCodexFeatures((await probe.run("codex", ["features", "list"]))?.output ?? "");
  const config = (await probe.readText(join(probe.home, ".codex", "config.toml"))) ?? "";
  const surfaces: ComputerUseSurface[] = [];
  if (features.get("computer_use") === true && !codexPluginDisabled(config, "computer-use@openai-bundled")) {
    surfaces.push("desktop");
  }
  // The owner's Chrome is reached through Codex's extension, whose native host
  // is registered with Chrome when the extension is set up.
  const chromeHost = await probe.readText(
    join(probe.home, CHROME_NATIVE_HOSTS, "com.openai.codexextension.json"),
  );
  if (
    features.get("browser_use_external") === true &&
    !codexPluginDisabled(config, "chrome@openai-bundled") &&
    chromeHost !== undefined
  ) {
    surfaces.push("chrome");
  }
  const missing = !signedIn
    ? "not signed in: the owner runs `codex login`"
    : surfaces.length === 0
      ? "computer use and Chrome are off: the owner enables them in the Codex app's plugins"
      : undefined;
  return {
    harness: "codex",
    signedIn,
    surfaces,
    chromeNeedsHireFlag: false,
    ...(missing === undefined ? {} : { missing }),
  };
}

async function probeClaude(probe: ComputerUseProbe): Promise<ComputerUseHarness | undefined> {
  const auth = await probe.run("claude", ["auth", "status"]);
  if (auth === undefined) return undefined;
  let signedIn = false;
  try {
    const start = auth.output.indexOf("{");
    signedIn =
      start !== -1 &&
      (JSON.parse(auth.output.slice(start, auth.output.lastIndexOf("}") + 1)) as { loggedIn?: unknown })
        .loggedIn === true;
  } catch {
    signedIn = false;
  }
  // Claude Code records the Claude in Chrome extension in its own state file;
  // the native host proves Chrome can reach this install's bridge.
  let state: {
    cachedChromeExtensionInstalled?: unknown;
    claudeInChromeDefaultEnabled?: unknown;
  } = {};
  try {
    state = JSON.parse((await probe.readText(join(probe.home, ".claude.json"))) ?? "{}") as typeof state;
  } catch {
    state = {};
  }
  const chromeHost = await probe.readText(
    join(probe.home, CHROME_NATIVE_HOSTS, "com.anthropic.claude_code_browser_extension.json"),
  );
  const chrome = state.cachedChromeExtensionInstalled === true && chromeHost !== undefined;
  const missing = !signedIn
    ? "not signed in: the owner runs `claude auth login`"
    : !chrome
      ? "the Claude in Chrome extension is not installed: the owner adds it and runs `/chrome` once"
      : undefined;
  return {
    harness: "claude",
    signedIn,
    surfaces: chrome ? ["chrome"] : [],
    chromeNeedsHireFlag: chrome && state.claudeInChromeDefaultEnabled !== true,
    ...(missing === undefined ? {} : { missing }),
  };
}

/** Every installed harness that has, or could have, computer use here. Absent harnesses are left out. */
export async function detectComputerUseHarnesses(
  probe: ComputerUseProbe = localComputerUseProbe(),
): Promise<readonly ComputerUseHarness[]> {
  const found = await Promise.all([probeCodex(probe), probeClaude(probe)]);
  return found.filter((entry): entry is ComputerUseHarness => entry !== undefined);
}

/** One harness that can take computer work right now. */
function computerUseReady(entry: ComputerUseHarness): boolean {
  return entry.signedIn && entry.surfaces.length > 0;
}

const SURFACE_WORDS: Readonly<Record<ComputerUseSurface, string>> = {
  desktop: "Mac apps",
  chrome: "their Chrome",
};

/**
 * The reach card's computer-use lines. Empty when no harness here can take the
 * work: the built-in browser is then his only way in, and a heading that says
 * "none" is noise on every turn.
 */
export function renderComputerUseReach(harnesses: readonly ComputerUseHarness[]): string {
  const ready = harnesses.filter(computerUseReady);
  if (ready.length === 0) return "";
  const lines = harnesses.map((entry) => {
    if (!computerUseReady(entry)) return `- ${entry.harness}: ${entry.missing ?? "not ready"}`;
    const surfaces = entry.surfaces.map((surface) => SURFACE_WORDS[surface]).join(" and ");
    return `- ${entry.harness}: ${surfaces}${entry.chromeNeedsHireFlag ? " (hire with `chrome: true`)" : ""}`;
  });
  return [
    "# Computer use through a harness",
    "",
    "These harnesses on this machine can drive your person's real apps and signed-in browser:",
    ...lines,
    "",
    "For a hard computer or browser task they are usually stronger than your own browser: hire one with `hire_agent`, brief it, and watch it (the `computer-use-delegation` skill has the pattern). It works in your person's own sessions, so stop it for sign-ins, codes, payments or anything that changes an account, and don't drive while they are using the machine. Each run spends their plan for that harness. Your own browser is still yours for your accounts and quick lookups. `clankie browser harnesses` re-checks.",
  ].join("\n");
}

/**
 * Detection is a handful of short-lived CLI calls, so the service remembers the
 * answer for a while instead of paying for it on every new session; a failed
 * refresh keeps the last answer rather than dropping the card.
 */
export function cachedComputerUseHarnesses(
  detect: () => Promise<readonly ComputerUseHarness[]> = () => detectComputerUseHarnesses(),
  ttlMs = 5 * 60_000,
  now: () => number = Date.now,
): {
  current(): Promise<readonly ComputerUseHarness[]>;
  refresh(): Promise<readonly ComputerUseHarness[]>;
} {
  let value: readonly ComputerUseHarness[] | undefined;
  let at = 0;
  let pending: Promise<readonly ComputerUseHarness[]> | undefined;
  const refresh = (): Promise<readonly ComputerUseHarness[]> =>
    (pending ??= detect()
      .then((found) => {
        value = found;
        at = now();
        return found;
      })
      .catch(() => value ?? [])
      .finally(() => {
        pending = undefined;
      }));
  return {
    current: () => (value !== undefined && now() - at < ttlMs ? Promise.resolve(value) : refresh()),
    refresh,
  };
}
