import { randomUUID } from "node:crypto";
import type { HarnessSeatAdapter } from "@clankie/agent-hosts";
import { CLAUDE_WORKER_PLUGIN_ID } from "@clankie/protocol";
import {
  posixQuote,
  posixScriptCommand,
  powershellLiteral,
  powershellScriptCommand,
  type FleetShellRun,
  type HerdrFleet,
} from "../herdr-fleet.ts";
import {
  createClaudeWorkerSeatAdapter,
  policiesApproveWorker,
  type ClaudeWorkerConsent,
  type ClaudeWorkerSeatDeps,
} from "./claude-worker-seat.ts";
import { claudeTrackerRulesFor } from "./tracker-isolation.ts";

/**
 * A Claude seat on another machine (VUH-1527): the same interactive worker and
 * the same clankie-worker channel and hooks as on Clankie's Mac, with the three
 * machine-local steps done on that machine. Consent is read from its installed
 * plugins and its managed policy; tracker isolation from its own Claude
 * configuration; and the launch settings are written there as a file. The
 * plugin reaches Clankie back through the fleet's link.
 */

const PLUGINS = "---CLANKIE-PLUGINS---";
const POLICY = "---CLANKIE-POLICY---";

/** The owner's one step for a machine: `clankie herdr prepare` does both halves. */
function prepareFix(fleet: string): string {
  return `Run clankie herdr prepare ${fleet} once: it installs ${CLAUDE_WORKER_PLUGIN_ID} on ${fleet} from this Clankie and approves its channel in that machine's managed policy, as its administrator.`;
}

function consentScript(fleet: HerdrFleet): string {
  if (fleet.ssh.shell === "powershell")
    return powershellScriptCommand(
      [
        `Write-Output ${powershellLiteral(PLUGINS)}`,
        "try { & claude plugin list --json 2>$null } catch { }",
        "$dir = 'C:\\Program Files\\ClaudeCode'",
        "$files = @(Join-Path $dir 'managed-settings.json') + @(Get-ChildItem (Join-Path $dir 'managed-settings.d') -Filter *.json -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { $_.FullName })",
        `foreach ($file in $files) { if (Test-Path -LiteralPath $file) { Write-Output ${powershellLiteral(POLICY)}; [IO.File]::ReadAllText($file) } }`,
      ].join("; "),
    );
  return posixScriptCommand(
    [
      `echo ${posixQuote(PLUGINS)}`,
      "claude plugin list --json 2>/dev/null || true",
      'for file in "/Library/Application Support/ClaudeCode/managed-settings.json" "/Library/Application Support/ClaudeCode/managed-settings.d/"*.json /etc/claude-code/managed-settings.json /etc/claude-code/managed-settings.d/*.json; do',
      `  if [ -f "$file" ]; then echo ${posixQuote(POLICY)}; cat "$file"; echo; fi`,
      "done",
    ].join("\n"),
  );
}

/** The plugin list and policy files from a consent script's output. */
export function parseConsentOutput(stdout: string): { plugins: string; policies: string[] } {
  const afterPlugins = stdout.split(PLUGINS)[1] ?? "";
  const [plugins = "", ...policies] = afterPlugins.split(POLICY);
  return { plugins: plugins.trim(), policies: policies.map((policy) => policy.trim()) };
}

export function remoteClaudeConsent(fleet: HerdrFleet, shell: FleetShellRun) {
  return async (): Promise<ClaudeWorkerConsent> => {
    let output: { plugins: string; policies: string[] };
    try {
      output = parseConsentOutput(await shell(consentScript(fleet), 30_000));
    } catch (error) {
      return {
        approved: false,
        detail: `Could not inspect Claude on ${fleet.id}: ${error instanceof Error ? error.message : String(error)}`,
        fix: prepareFix(fleet.id),
      };
    }
    let installed = false;
    try {
      const plugins = JSON.parse(output.plugins) as unknown;
      installed =
        Array.isArray(plugins) &&
        plugins.some((entry) => (entry as { id?: unknown })?.id === CLAUDE_WORKER_PLUGIN_ID);
    } catch {
      installed = false;
    }
    if (!installed)
      return {
        approved: false,
        detail: `${CLAUDE_WORKER_PLUGIN_ID} is not installed on ${fleet.id}.`,
        fix: prepareFix(fleet.id),
      };
    if (!policiesApproveWorker(output.policies))
      return {
        approved: false,
        detail: `${fleet.id}'s managed policy does not approve the ${CLAUDE_WORKER_PLUGIN_ID} channel, and a development channel would stop at a warning only the owner may accept.`,
        fix: prepareFix(fleet.id),
      };
    return { approved: true };
  };
}

/** Whether `cwd` is `root` or inside it, by that machine's path rules. */
function within(fleet: HerdrFleet, root: string, cwd: string): boolean {
  if (fleet.ssh.shell === "powershell") {
    const normal = (path: string) => path.replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
    const [base, path] = [normal(root), normal(cwd)];
    return path === base || path.startsWith(`${base}\\`);
  }
  const base = root.replace(/\/+$/u, "");
  return cwd === base || cwd.startsWith(`${base}/`);
}

/** Tracker deny rules from that machine's own `~/.claude.json` (user and project scopes). */
export function remoteClaudeTrackerDeny(fleet: HerdrFleet, shell: FleetShellRun) {
  return async (cwd: string): Promise<readonly string[]> => {
    const raw = await shell(
      fleet.ssh.shell === "powershell"
        ? powershellScriptCommand(
            "$path = Join-Path $env:USERPROFILE '.claude.json'; if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllText($path) }",
          )
        : posixScriptCommand('cat "$HOME/.claude.json" 2>/dev/null || true'),
    );
    let state: { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } = {};
    try {
      state = raw.trim() === "" ? {} : (JSON.parse(raw) as typeof state);
    } catch {
      // Launch configuration that cannot be read cannot be proven isolated.
      throw new Error(`Could not read Claude's configuration on ${fleet.id} to switch off Linear connectors`);
    }
    const projects = Object.entries(state.projects ?? {})
      .filter(([root]) => within(fleet, root, cwd))
      .map(([, project]) => project?.mcpServers);
    return claudeTrackerRulesFor([state.mcpServers, ...projects]);
  };
}

/** Writes the launch's settings JSON on that machine and returns its path. */
function remoteClaudeSettings(fleet: HerdrFleet, shell: FleetShellRun) {
  return async (json: string): Promise<string> => {
    const name = `${randomUUID()}.json`;
    const stdout = await shell(
      fleet.ssh.shell === "powershell"
        ? powershellScriptCommand(
            [
              "$ErrorActionPreference = 'Stop'",
              "$dir = Join-Path $env:LOCALAPPDATA 'clankie\\claude-settings'",
              "New-Item -ItemType Directory -Force $dir | Out-Null",
              `$path = Join-Path $dir ${powershellLiteral(name)}`,
              `[IO.File]::WriteAllText($path, ${powershellLiteral(json)}, (New-Object Text.UTF8Encoding $false))`,
              "Write-Output $path",
            ].join("; "),
          )
        : posixScriptCommand(
            [
              "set -e",
              "umask 077",
              'dir="$HOME/.clankie/claude-settings"',
              'mkdir -p "$dir"',
              `printf '%s' ${posixQuote(json)} > "$dir/${name}"`,
              `printf '%s\\n' "$dir/${name}"`,
            ].join("\n"),
          ),
    );
    const path = stdout.trim().split(/\r?\n/u).at(-1)?.trim();
    if (!path) throw new Error(`${fleet.id} did not report where it wrote the launch settings`);
    if (/\s/u.test(path))
      throw new Error(`unsupported: the launch settings path on ${fleet.id} contains spaces`);
    return path;
  };
}

/** Claude control for one remote fleet, sharing the service's hook log and mailboxes. */
export function createRemoteClaudeWorkerSeatAdapter(
  fleet: HerdrFleet,
  shell: FleetShellRun,
  deps: Pick<ClaudeWorkerSeatDeps, "hooks" | "agent" | "transcript" | "mailbox" | "timing">,
): HarnessSeatAdapter {
  return createClaudeWorkerSeatAdapter({
    ...deps,
    consent: remoteClaudeConsent(fleet, shell),
    trackerDeny: remoteClaudeTrackerDeny(fleet, shell),
    settingsArg: remoteClaudeSettings(fleet, shell),
  });
}
