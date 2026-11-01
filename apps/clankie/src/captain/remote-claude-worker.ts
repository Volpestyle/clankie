import { stageWindowsMessage, stagedMessagePointer } from "./remote-seat-message.ts";
import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";
import { LINEAR_MCP_RESOURCE } from "@clankie/credential-broker";
import { z } from "zod";
import type { HarnessSeatAdapter } from "@clankie/agent-hosts";
import { CLAUDE_WORKER_PLUGIN_ID, OPERATOR_CONVERSATION_TEXT_MAX } from "@clankie/protocol";
import {
  posixQuote,
  posixScriptCommand,
  powershellLiteral,
  powershellScriptCommand,
  remoteProgramCommand,
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
 * machine-local steps done on that machine. Consent is read from the worker
 * files `clankie herdr prepare` staged there and its managed policy; tracker
 * isolation from its own Claude configuration; and the launch settings are
 * written there as a file. Each launch loads the staged plugin with
 * `--plugin-dir` (ADR 0317), and it reaches Clankie back through the fleet's link.
 */

const ROOT = "---CLANKIE-WORKER-ROOT---";
const POLICY = "---CLANKIE-POLICY---";
/** Where `clankie herdr prepare` stages the worker plugin, under the remote home. */
const STAGED_WORKER = ".clankie/claude-plugin/worker";

/** The owner's one step for a machine: `clankie herdr prepare` does both halves. */
function prepareFix(fleet: string): string {
  return `Run clankie herdr prepare ${fleet} once: it copies this Clankie's worker plugin to ${fleet} and approves its ${CLAUDE_WORKER_PLUGIN_ID} channel in that machine's managed policy, as its administrator.`;
}

function consentScript(fleet: HerdrFleet): string {
  if (fleet.ssh.shell === "powershell")
    return powershellScriptCommand(
      [
        `$root = Join-Path $env:USERPROFILE ${powershellLiteral(STAGED_WORKER.replaceAll("/", "\\"))}`,
        `if (Test-Path -LiteralPath (Join-Path $root '.claude-plugin\\plugin.json')) { Write-Output ${powershellLiteral(ROOT)}; Write-Output $root }`,
        "$dir = 'C:\\Program Files\\ClaudeCode'",
        "$files = @(Join-Path $dir 'managed-settings.json') + @(Get-ChildItem (Join-Path $dir 'managed-settings.d') -Filter *.json -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object { $_.FullName })",
        `foreach ($file in $files) { if (Test-Path -LiteralPath $file) { Write-Output ${powershellLiteral(POLICY)}; [IO.File]::ReadAllText($file) } }`,
      ].join("; "),
    );
  return posixScriptCommand(
    [
      `root="$HOME/${STAGED_WORKER}"`,
      `if [ -f "$root/.claude-plugin/plugin.json" ]; then echo ${posixQuote(ROOT)}; printf '%s\\n' "$root"; fi`,
      'for file in "/Library/Application Support/ClaudeCode/managed-settings.json" "/Library/Application Support/ClaudeCode/managed-settings.d/"*.json /etc/claude-code/managed-settings.json /etc/claude-code/managed-settings.d/*.json; do',
      `  if [ -f "$file" ]; then echo ${posixQuote(POLICY)}; cat "$file"; echo; fi`,
      "done",
    ].join("\n"),
  );
}

/** The staged worker root (absent when none is staged) and policy files from a consent script's output. */
export function parseConsentOutput(stdout: string): { root?: string; policies: string[] } {
  const [head = "", ...policies] = stdout.split(POLICY);
  const root = head.split(ROOT)[1]?.trim().split(/\r?\n/u)[0]?.trim();
  return {
    ...(root === undefined || root.length === 0 ? {} : { root }),
    policies: policies.map((policy) => policy.trim()),
  };
}

/** Consent, and the staged worker root each launch loads, read once per check on that machine. */
export function remoteClaudeConsent(fleet: HerdrFleet, shell: FleetShellRun) {
  let root: string | undefined;
  const consent = async (): Promise<ClaudeWorkerConsent> => {
    let output: { root?: string; policies: string[] };
    try {
      output = parseConsentOutput(await shell(consentScript(fleet), 30_000));
    } catch (error) {
      return {
        approved: false,
        detail: `Could not inspect Claude on ${fleet.id}: ${error instanceof Error ? error.message : String(error)}`,
        fix: prepareFix(fleet.id),
      };
    }
    if (output.root === undefined)
      return {
        approved: false,
        detail: `${fleet.id} has no worker plugin staged by Clankie.`,
        fix: prepareFix(fleet.id),
      };
    if (/[\p{Cc}"]/u.test(output.root))
      return {
        approved: false,
        detail: `unsupported: the worker plugin path on ${fleet.id} contains quotes or control characters`,
        fix: prepareFix(fleet.id),
      };
    if (!policiesApproveWorker(output.policies))
      return {
        approved: false,
        detail: `${fleet.id}'s managed policy does not approve the ${CLAUDE_WORKER_PLUGIN_ID} channel, and a development channel would stop at a warning only the owner may accept.`,
        fix: prepareFix(fleet.id),
      };
    root = output.root;
    return { approved: true };
  };
  return {
    consent,
    workerRoot: async (): Promise<string> => {
      if (root === undefined && !(await consent()).approved)
        throw new Error(`${fleet.id} has no approved worker plugin to load`);
      return root!;
    },
  };
}

const TRACKER_READ_TIMEOUT_MS = 10_000;
const TRACKER_OUTPUT_BYTES = 512 * 1024;
const TRACKER_HOST = new URL(LINEAR_MCP_RESOURCE).hostname.replace(/^mcp\./u, "");
const TrackerSources = z
  .object({
    schemaVersion: z.literal(1),
    sources: z
      .array(
        z.preprocess(
          // z.record drops this own JSON key; omission could silently lose a deny rule.
          (source) =>
            source !== null && typeof source === "object" && Object.hasOwn(source, "__proto__")
              ? undefined
              : source,
          z.record(
            z.string().max(512),
            z
              .object({
                url: z.string().max(512).optional(),
                command: z.string().max(512).optional(),
              })
              .strict(),
          ),
        ),
      )
      .max(128),
  })
  .strict();

// Runs once through the remote worker's existing Node prerequisite. Only server
// identifiers, URL hosts and a fixed classifier marker leave the machine.
const TRACKER_READ = String.raw`
const fs = require("node:fs"), path = require("node:path");
try {
  const input = JSON.parse(process.argv[1]);
  if ((process.platform === "win32") !== input.windows) throw Error();
  const absolute = value => {
    if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) throw Error();
    if (input.windows && (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value) || /^\\\\[?.]\\/.test(value))) throw Error();
    return path.normalize(value);
  };
  const key = value => {
    const normalized = path.normalize(value);
    const clean = normalized === path.parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/, "");
    return input.windows ? clean.toLowerCase() : clean;
  };
  const cwd = absolute(input.cwd), home = absolute(input.windows ? process.env.USERPROFILE : process.env.HOME);
  const parents = [];
  for (let p = cwd;; p = path.dirname(p)) {
    if (parents.length === 64) throw Error();
    parents.push(p);
    if (path.dirname(p) === p) break;
  }
  const parentKeys = new Set(parents.map(key)), files = new Set(), sources = [];
  let bytes = 0;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const read = name => {
    if (files.has(key(name))) return;
    if (files.size === 66) throw Error();
    files.add(key(name));
    let fd;
    try { fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); }
    catch (error) {
      if (error.code !== "ENOENT") throw Error();
      try { fs.lstatSync(name); } catch (missing) { if (missing.code === "ENOENT") return; }
      throw Error();
    }
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > 262144 || bytes + before.size > 2097152) throw Error();
      const buffer = Buffer.alloc(262145);
      let length = 0, got;
      do { got = fs.readSync(fd, buffer, length, buffer.length - length, null); length += got; } while (got && length < buffer.length);
      bytes += length;
      const after = fs.fstatSync(fd);
      if (length > 262144 || bytes > 2097152 || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw Error();
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
      if (!object(value)) throw Error();
      return value;
    } finally { fs.closeSync(fd); }
  };
  const add = servers => {
    if (servers === undefined) return;
    if (!object(servers) || Object.keys(servers).length > 1024) throw Error();
    const result = Object.create(null);
    for (const [name, entry] of Object.entries(servers)) {
      if (!name || name.length > 512 || !object(entry)) throw Error();
      if (entry.url !== undefined && typeof entry.url !== "string") throw Error();
      if (entry.command !== undefined && typeof entry.command !== "string") throw Error();
      if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== "string"))) throw Error();
      const safe = {};
      if (entry.url) { try { safe.url = "https://" + new URL(entry.url).hostname; } catch {} }
      const command = [entry.command, ...(entry.args || [])].filter(value => typeof value === "string").join(" ");
      if (command.includes(input.trackerHost) || /\blinear-mcp\b|@linear\//i.test(command)) safe.command = "linear-mcp";
      result[name] = safe;
    }
    sources.push(result);
  };
  const configs = [path.join(home, ".claude.json")];
  const configDir = input.configDir || process.env.CLAUDE_CONFIG_DIR;
  if (configDir) configs.push(path.join(absolute(configDir), ".claude.json"));
  for (const file of configs) {
    const config = read(file);
    if (!config) continue;
    add(config.mcpServers);
    if (config.projects !== undefined) {
      if (!object(config.projects)) throw Error();
      for (const [root, project] of Object.entries(config.projects)) {
        if (!parentKeys.has(key(absolute(root)))) continue;
        if (!object(project)) throw Error();
        add(project.mcpServers);
      }
    }
  }
  for (const parent of parents) add(read(path.join(parent, ".mcp.json"))?.mcpServers);
  const output = JSON.stringify({ schemaVersion: 1, sources });
  if (sources.length > 128 || Buffer.byteLength(output) > 524288) throw Error();
  process.stdout.write(output);
} catch { process.stderr.write("Claude tracker configuration unavailable\n"); process.exitCode = 1; }
`.replace(/\n[ \t]*/gu, " ");

/** Read the launch's Claude profile (its CLAUDE_CONFIG_DIR, else the SSH default) and ancestor configs. */
export function remoteClaudeTrackerDeny(fleet: HerdrFleet, shell: FleetShellRun) {
  return async (cwd: string, env?: Readonly<Record<string, string>>): Promise<readonly string[]> => {
    try {
      const windows = fleet.ssh.shell === "powershell";
      const native = windows ? win32 : posix;
      if (!native.isAbsolute(cwd) || cwd.length > 4096 || cwd.includes("\0")) throw new Error();
      const command = remoteProgramCommand(fleet.ssh.shell, "node", [
        "-e",
        TRACKER_READ,
        JSON.stringify({
          cwd,
          windows,
          trackerHost: TRACKER_HOST,
          ...(env?.CLAUDE_CONFIG_DIR === undefined ? {} : { configDir: env.CLAUDE_CONFIG_DIR }),
        }),
      ]);
      // Leave room for the Windows OpenSSH/default-shell command wrapper.
      if (windows && command.length > 30_000) throw new Error();
      const raw = await shell(command, TRACKER_READ_TIMEOUT_MS);
      if (Buffer.byteLength(raw) > TRACKER_OUTPUT_BYTES) throw new Error();
      return claudeTrackerRulesFor(TrackerSources.parse(JSON.parse(raw)).sources);
    } catch {
      // FleetShellRun failures can contain config/stderr; never forward their content.
      throw new Error(`Could not read Claude's configuration on ${fleet.id} to switch off Linear connectors`);
    }
  };
}

/** Writes the launch's settings JSON on that machine and returns its path. */
function remoteClaudeSettings(fleet: HerdrFleet, shell: FleetShellRun, prefix = "") {
  return async (json: string): Promise<string> => {
    const name = `${prefix}${randomUUID()}.json`;
    const stdout = await shell(
      fleet.ssh.shell === "powershell"
        ? powershellScriptCommand(
            [
              "$ErrorActionPreference = 'Stop'",
              "$dir = Join-Path $env:LOCALAPPDATA 'clankie\\claude-settings'",
              "New-Item -ItemType Directory -Force $dir | Out-Null",
              `$path = Join-Path $dir ${powershellLiteral(name)}`,
              // PowerShell treats typographic quotes as syntax too. Transport
              // UTF-8 bytes, never brief/settings text as PowerShell source.
              `[IO.File]::WriteAllBytes($path, [Convert]::FromBase64String('${Buffer.from(json, "utf8").toString("base64")}'))`,
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
  deps: Pick<ClaudeWorkerSeatDeps, "hooks" | "agent" | "transcript" | "pane" | "mailbox" | "timing">,
): HarnessSeatAdapter {
  return createClaudeWorkerSeatAdapter({
    ...deps,
    prepareMessage: async (text) => {
      if (fleet.ssh.shell !== "powershell" || text.length <= OPERATOR_CONVERSATION_TEXT_MAX) return undefined;
      const staged = await stageWindowsMessage(shell, text);
      return { text: stagedMessagePointer(staged, text), remove: staged.remove };
    },
    ...remoteClaudeConsent(fleet, shell),
    trackerDeny: remoteClaudeTrackerDeny(fleet, shell),
    settingsArg: remoteClaudeSettings(fleet, shell),
    briefFile: remoteClaudeSettings(fleet, shell, "clankie-brief-"),
  });
}
