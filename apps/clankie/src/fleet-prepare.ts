import { execFile } from "node:child_process";
import { join } from "node:path";
import { CLAUDE_WORKER_PLUGIN, CLAUDE_WORKER_PLUGIN_ID } from "@clankie/protocol";
import {
  SSH_BASE_OPTIONS,
  posixQuote,
  posixScriptCommand,
  powershellLiteral,
  powershellScriptCommand,
  type FleetShellRun,
  type HerdrFleet,
} from "./herdr-fleet.ts";

/**
 * The owner's one step for Claude workers on another machine (VUH-1527):
 * `clankie herdr prepare NAME`. Running it is the owner's approval. It ships
 * this Clankie's own worker plugin to that machine as a local `clankie`
 * marketplace (so its version always matches this service), installs it off
 * by default (each hire enables it for its own session), and approves its
 * channel in that machine's managed policy, keeping any entries already there.
 * Policy is machine-wide, so the ssh account must be that machine's
 * administrator; otherwise the step fails and says so.
 */

export interface FleetPrepareResult {
  readonly fleet: string;
  readonly plugin: string;
  readonly marketplace: string;
  readonly policy: { readonly path: string; readonly changed: boolean };
  /** Codex agents there reach the same bridge as an MCP server; false when Codex is absent. */
  readonly codex: { readonly registered: boolean; readonly changed: boolean };
}

const MARKETPLACE_DIR = ".clankie/claude-plugin";
const STAGING_DIR = ".clankie/claude-plugin.new";

/** A marketplace holding only the worker plugin; the operator seat stays on the owner's Mac. */
export function workerMarketplace(): string {
  return JSON.stringify(
    {
      name: CLAUDE_WORKER_PLUGIN.marketplace,
      description: "Clankie's worker channel, shipped by `clankie herdr prepare`.",
      owner: { name: "Clankie" },
      plugins: [{ name: CLAUDE_WORKER_PLUGIN.plugin, source: "./worker" }],
    },
    null,
    2,
  );
}

/** The managed policy with the worker channel approved and every other entry kept. */
export function approveWorkerChannel(existing: string): {
  readonly content: string;
  readonly changed: boolean;
} {
  let value: Record<string, unknown> = {};
  if (existing.trim() !== "") {
    const parsed = JSON.parse(existing) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("The managed policy is not a JSON object; leaving it untouched");
    value = parsed as Record<string, unknown>;
  }
  const allowed = Array.isArray(value.allowedChannelPlugins) ? [...value.allowedChannelPlugins] : [];
  const present = allowed.some(
    (entry) =>
      (entry as { marketplace?: unknown })?.marketplace === CLAUDE_WORKER_PLUGIN.marketplace &&
      (entry as { plugin?: unknown })?.plugin === CLAUDE_WORKER_PLUGIN.plugin,
  );
  if (value.channelsEnabled === true && present) return { content: existing, changed: false };
  const next = {
    ...value,
    channelsEnabled: true,
    allowedChannelPlugins: present
      ? allowed
      : [...allowed, { marketplace: CLAUDE_WORKER_PLUGIN.marketplace, plugin: CLAUDE_WORKER_PLUGIN.plugin }],
  };
  return { content: `${JSON.stringify(next, null, 2)}\n`, changed: true };
}

function policyPathScript(fleet: HerdrFleet): string {
  return fleet.ssh.shell === "powershell"
    ? "$policy = 'C:\\Program Files\\ClaudeCode\\managed-settings.json'"
    : 'if [ "$(uname)" = Darwin ]; then policy="/Library/Application Support/ClaudeCode/managed-settings.json"; else policy=/etc/claude-code/managed-settings.json; fi';
}

const POLICY_MARK = "---CLANKIE-POLICY-PATH---";

function readPolicyCommand(fleet: HerdrFleet): string {
  return fleet.ssh.shell === "powershell"
    ? powershellScriptCommand(
        [
          policyPathScript(fleet),
          `Write-Output (${powershellLiteral(POLICY_MARK)} + $policy)`,
          "if (Test-Path -LiteralPath $policy) { [IO.File]::ReadAllText($policy) }",
        ].join("; "),
      )
    : posixScriptCommand(
        [
          policyPathScript(fleet),
          `printf '%s%s\\n' ${posixQuote(POLICY_MARK)} "$policy"`,
          'cat "$policy" 2>/dev/null || true',
        ].join("\n"),
      );
}

function writePolicyCommand(fleet: HerdrFleet, content: string): string {
  return fleet.ssh.shell === "powershell"
    ? powershellScriptCommand(
        [
          "$ErrorActionPreference = 'Stop'",
          policyPathScript(fleet),
          "New-Item -ItemType Directory -Force (Split-Path $policy) | Out-Null",
          `[IO.File]::WriteAllText($policy, ${powershellLiteral(content)}, (New-Object Text.UTF8Encoding $false))`,
        ].join("; "),
      )
    : posixScriptCommand(
        [
          "set -e",
          policyPathScript(fleet),
          'mkdir -p "$(dirname "$policy")"',
          `printf '%s' ${posixQuote(content)} > "$policy"`,
        ].join("\n"),
      );
}

function stageCommand(fleet: HerdrFleet): string {
  const marketplace = workerMarketplace();
  return fleet.ssh.shell === "powershell"
    ? powershellScriptCommand(
        [
          "$ErrorActionPreference = 'Stop'",
          `$stage = Join-Path $env:USERPROFILE ${powershellLiteral(STAGING_DIR.replaceAll("/", "\\"))}`,
          "if (Test-Path -LiteralPath $stage) { Remove-Item -Recurse -Force -LiteralPath $stage }",
          "New-Item -ItemType Directory -Force (Join-Path $stage '.claude-plugin') | Out-Null",
          `[IO.File]::WriteAllText((Join-Path $stage '.claude-plugin\\marketplace.json'), ${powershellLiteral(marketplace)}, (New-Object Text.UTF8Encoding $false))`,
        ].join("; "),
      )
    : posixScriptCommand(
        [
          "set -e",
          `stage="$HOME/${STAGING_DIR}"`,
          'rm -rf "$stage"',
          'mkdir -p "$stage/.claude-plugin"',
          `printf '%s' ${posixQuote(marketplace)} > "$stage/.claude-plugin/marketplace.json"`,
        ].join("\n"),
      );
}

/** Swap the staged marketplace in, then add or refresh it and install the plugin off by default. */
function installCommand(fleet: HerdrFleet): string {
  const id = CLAUDE_WORKER_PLUGIN_ID;
  const name = CLAUDE_WORKER_PLUGIN.marketplace;
  return fleet.ssh.shell === "powershell"
    ? powershellScriptCommand(
        [
          "$ErrorActionPreference = 'Stop'",
          `$stage = Join-Path $env:USERPROFILE ${powershellLiteral(STAGING_DIR.replaceAll("/", "\\"))}`,
          `$target = Join-Path $env:USERPROFILE ${powershellLiteral(MARKETPLACE_DIR.replaceAll("/", "\\"))}`,
          "if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }",
          "Move-Item -LiteralPath $stage -Destination $target",
          "$ErrorActionPreference = 'Continue'",
          `$known = (& claude plugin marketplace list 2>&1 | Out-String) -match ${powershellLiteral(`(?m)^\\s*\\S*\\s*${name}\\s*$`)}`,
          `if ($known) { & claude plugin marketplace update ${name} 2>&1 | Out-Null } else { & claude plugin marketplace add $target 2>&1 | Out-Null }`,
          `& claude plugin install ${id} 2>&1 | Out-Null`,
          `& claude plugin update ${id} 2>&1 | Out-Null`,
          `& claude plugin disable ${id} 2>&1 | Out-Null`,
          "Write-Output $target",
        ].join("; "),
      )
    : posixScriptCommand(
        [
          "set -e",
          `stage="$HOME/${STAGING_DIR}"`,
          `target="$HOME/${MARKETPLACE_DIR}"`,
          'rm -rf "$target"',
          'mv "$stage" "$target"',
          "set +e",
          `if claude plugin marketplace list 2>/dev/null | grep -Eq '^[[:space:]]*[^[:space:]]*[[:space:]]*${name}[[:space:]]*$'; then claude plugin marketplace update ${name} >/dev/null 2>&1; else claude plugin marketplace add "$target" >/dev/null 2>&1; fi`,
          `claude plugin install ${id} >/dev/null 2>&1`,
          `claude plugin update ${id} >/dev/null 2>&1`,
          `claude plugin disable ${id} >/dev/null 2>&1`,
          "printf '%s\\n' \"$target\"",
        ].join("\n"),
      );
}

/**
 * The same bridge for Codex agents on that machine, which load no Claude
 * plugins: an MCP server named `clankie` in its Codex config, inheriting the
 * pane's Herdr identity so it finds its session's link. Added once; Codex's
 * own entry is left alone if the owner already has one.
 */
function registerCodexCommand(fleet: HerdrFleet): string {
  const env = '["HERDR_PANE_ID", "HERDR_SOCKET_PATH"]';
  return fleet.ssh.shell === "powershell"
    ? powershellScriptCommand(
        [
          "$ErrorActionPreference = 'Stop'",
          "if (-not (Get-Command codex -ErrorAction SilentlyContinue)) { Write-Output 'absent'; exit 0 }",
          "$home_ = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }",
          "New-Item -ItemType Directory -Force $home_ | Out-Null",
          "$config = Join-Path $home_ 'config.toml'",
          "$current = if (Test-Path -LiteralPath $config) { [IO.File]::ReadAllText($config) } else { '' }",
          `if ($current -match '(?m)^\\[\\s*(mcp_servers\\.clankie|"mcp_servers"\\."clankie")\\s*\\]') { Write-Output 'present'; exit 0 }`,
          `$bridge = Join-Path $env:USERPROFILE ${powershellLiteral(`${MARKETPLACE_DIR.replaceAll("/", "\\")}\\worker\\bin\\swarm-mcp.mjs`)}`,
          `$table = [Environment]::NewLine + '[mcp_servers.clankie]' + [Environment]::NewLine + 'command = "node"' + [Environment]::NewLine + "args = ['" + $bridge + "']" + [Environment]::NewLine + 'env_vars = ${env}' + [Environment]::NewLine`,
          "[IO.File]::AppendAllText($config, $table, (New-Object Text.UTF8Encoding $false))",
          "Write-Output 'added'",
        ].join("; "),
      )
    : posixScriptCommand(
        [
          "set -e",
          "command -v codex >/dev/null 2>&1 || { echo absent; exit 0; }",
          'config="${CODEX_HOME:-$HOME/.codex}/config.toml"',
          'mkdir -p "$(dirname "$config")"',
          `if [ -f "$config" ] && grep -Eq '^\\[[[:space:]]*(mcp_servers\\.clankie|"mcp_servers"\\."clankie")[[:space:]]*\\]' "$config"; then echo present; exit 0; fi`,
          `printf '\\n[mcp_servers.clankie]\\ncommand = "node"\\nargs = ["%s"]\\nenv_vars = ${env}\\n' "$HOME/${MARKETPLACE_DIR}/worker/bin/swarm-mcp.mjs" >> "$config"`,
          "echo added",
        ].join("\n"),
      );
}

const LIST_COMMAND = (fleet: HerdrFleet) =>
  fleet.ssh.shell === "powershell"
    ? powershellScriptCommand("& claude plugin list --json 2>$null")
    : posixScriptCommand("claude plugin list --json 2>/dev/null || true");

export async function prepareFleet(
  fleet: HerdrFleet,
  options: {
    readonly shell: FleetShellRun;
    /** Clankie's own worker plugin directory (`integrations/claude-plugin/worker`). */
    readonly workerPluginDir: string;
    /** Copies a directory to a path relative to the remote home; scp by default. */
    readonly copy?: (source: string, destination: string) => Promise<void>;
  },
): Promise<FleetPrepareResult> {
  const copy =
    options.copy ??
    ((source: string, destination: string) =>
      new Promise<void>((resolve, reject) =>
        execFile(
          "scp",
          [
            ...SSH_BASE_OPTIONS.filter((option) => option !== "-T"),
            "-q",
            "-r",
            source,
            `${fleet.ssh.host}:${destination}`,
          ],
          { timeout: 120_000 },
          (error, _stdout, stderr) =>
            error === null
              ? resolve()
              : reject(
                  new Error(`copying the worker plugin failed: ${String(stderr).trim() || error.message}`),
                ),
        ),
      ));
  await options.shell(stageCommand(fleet), 60_000);
  await copy(options.workerPluginDir, `${STAGING_DIR}/worker`);
  const marketplace =
    (await options.shell(installCommand(fleet), 180_000)).trim().split(/\r?\n/u).at(-1) ?? "";
  const listed = await options.shell(LIST_COMMAND(fleet), 60_000);
  let installed = false;
  try {
    const plugins = JSON.parse(listed.slice(listed.indexOf("["))) as unknown;
    installed =
      Array.isArray(plugins) &&
      plugins.some((entry) => (entry as { id?: unknown })?.id === CLAUDE_WORKER_PLUGIN_ID);
  } catch {
    installed = false;
  }
  if (!installed)
    throw new Error(
      `${CLAUDE_WORKER_PLUGIN_ID} did not install on ${fleet.id}; run claude plugin list there`,
    );
  const read = await options.shell(readPolicyCommand(fleet), 30_000);
  const marked = read.indexOf(POLICY_MARK);
  const afterMark = marked < 0 ? "" : read.slice(marked + POLICY_MARK.length);
  const newline = afterMark.search(/\r?\n/u);
  const path = (newline < 0 ? afterMark : afterMark.slice(0, newline)).trim();
  const existing = newline < 0 ? "" : afterMark.slice(newline).trim();
  const approved = approveWorkerChannel(existing);
  if (approved.changed)
    await options.shell(writePolicyCommand(fleet, approved.content), 30_000).catch((error: unknown) => {
      throw new Error(
        `Could not write ${path} on ${fleet.id}; the ssh account must be that machine's administrator (${error instanceof Error ? error.message : String(error)})`,
      );
    });
  const codex = (await options.shell(registerCodexCommand(fleet), 60_000)).trim().split(/\r?\n/u).at(-1);
  return {
    fleet: fleet.id,
    plugin: CLAUDE_WORKER_PLUGIN_ID,
    marketplace,
    policy: { path, changed: approved.changed },
    codex: { registered: codex === "added" || codex === "present", changed: codex === "added" },
  };
}

/** This checkout's or release's worker plugin. */
export function workerPluginDir(repoRoot: string): string {
  return join(repoRoot, "integrations", "claude-plugin", "worker");
}
