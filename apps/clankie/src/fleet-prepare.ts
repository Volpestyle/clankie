import { prepareWorkerSkill } from "../../../integrations/claude-plugin/worker/bin/skill-bundle.mjs";
import { readFile } from "node:fs/promises";
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
 * marketplace (so its version always matches this service), enables it for every discovered Claude profile (including CLAUDE_CONFIG_DIR), and approves its
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
  readonly installations: unknown;
  readonly harnesses: unknown;
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

/** Native installers receive the explicit owner approval from `herdr prepare`; no config append. */
function installCommand(fleet: HerdrFleet): string {
  return fleet.ssh.shell === "powershell"
    ? powershellScriptCommand(
        [
          "$ErrorActionPreference = 'Stop'",
          `$stage = Join-Path $env:USERPROFILE ${powershellLiteral(STAGING_DIR.replaceAll("/", "\\"))}`,
          `$target = Join-Path $env:USERPROFILE ${powershellLiteral(MARKETPLACE_DIR.replaceAll("/", "\\"))}`,
          "if (Test-Path -LiteralPath $target) { Remove-Item -Recurse -Force -LiteralPath $target }",
          "Move-Item -LiteralPath $stage -Destination $target",
          "& node (Join-Path $target 'worker\\bin\\harness-setup.mjs') --approved $target",
          "if ($LASTEXITCODE -ne 0) { throw 'Native harness setup failed' }",
        ].join("; "),
      )
    : posixScriptCommand(
        [
          "set -e",
          `stage="$HOME/${STAGING_DIR}"`,
          `target="$HOME/${MARKETPLACE_DIR}"`,
          'rm -rf "$target"',
          'mv "$stage" "$target"',
          'node "$target/worker/bin/harness-setup.mjs" --approved "$target"',
        ].join("\n"),
      );
}

export async function inspectFleetHarnesses(
  fleet: HerdrFleet,
  options: { shell: FleetShellRun; workerPluginDir: string },
): Promise<unknown> {
  const expected = JSON.parse(
    await readFile(join(options.workerPluginDir, ".claude-plugin", "plugin.json"), "utf8"),
  ).version as string;
  const command =
    fleet.ssh.shell === "powershell"
      ? powershellScriptCommand(
          `& node (Join-Path $env:USERPROFILE ${powershellLiteral(`${MARKETPLACE_DIR.replaceAll("/", "\\")}\\worker\\bin\\harness-inspect.mjs`)}) ${powershellLiteral(expected)}; if ($LASTEXITCODE -ne 0) { throw 'Harness inspection failed; run owner preparation' }`,
        )
      : posixScriptCommand(
          `node "$HOME/${MARKETPLACE_DIR}/worker/bin/harness-inspect.mjs" ${posixQuote(expected)}`,
        );
  return JSON.parse(await options.shell(command, 60_000));
}

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
  await prepareWorkerSkill(options.workerPluginDir);
  await options.shell(stageCommand(fleet), 60_000);
  await copy(options.workerPluginDir, `${STAGING_DIR}/worker`);
  await copy(join(options.workerPluginDir, "..", ".agents"), `${STAGING_DIR}/.agents`);
  const installations = JSON.parse(await options.shell(installCommand(fleet), 180_000));
  const harnesses = (await inspectFleetHarnesses(fleet, options)) as {
    claude: Array<{ executable: boolean; enabled: boolean; versionMatches: boolean }>;
    codex: {
      registered: boolean;
      pluginInstalled: boolean;
      versionMatches: boolean;
      enabled: boolean;
      bridge: boolean;
      identityForwarding: boolean;
    };
  };
  if (harnesses.claude.some((profile) => profile.executable && (!profile.enabled || !profile.versionMatches)))
    throw new Error(
      `A Claude profile on ${fleet.id} has a disabled or stale worker plugin; inspect clankie doctor and native plugin sources. ` +
        (Array.isArray(installations)
          ? installations
              .filter((entry: { harness?: string }) => entry.harness === "claude")
              .map(
                (entry: { profile?: string; status?: string; detail?: string }) =>
                  `${entry.profile ?? "profile"}: ${entry.status ?? "unknown"} (${(entry.detail ?? "").slice(0, 400)})`,
              )
              .join("; ")
          : "Native installer returned no profile results"),
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

  return {
    fleet: fleet.id,
    plugin: CLAUDE_WORKER_PLUGIN_ID,
    marketplace: MARKETPLACE_DIR,
    installations,
    harnesses,
    policy: { path, changed: approved.changed },
    codex: {
      registered:
        harnesses.codex.registered ||
        (harnesses.codex.pluginInstalled &&
          harnesses.codex.versionMatches &&
          harnesses.codex.enabled &&
          harnesses.codex.bridge &&
          harnesses.codex.identityForwarding),
      changed:
        Array.isArray(installations) &&
        installations.some(
          (result: { harness?: string; status?: string }) =>
            result.harness === "codex" && result.status === "installed",
        ),
    },
  };
}

/** This checkout's or release's worker plugin. */
export function workerPluginDir(repoRoot: string): string {
  return join(repoRoot, "integrations", "claude-plugin", "worker");
}
