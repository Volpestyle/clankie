import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { RemoteLeadLaunch } from "@clankie/protocol/remote-leads";
import type { SettingsStore } from "@clankie/settings";
import type { ExecutionConnections } from "./herdr-session.ts";
import type { CaptainPort } from "./captain/port.ts";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import { powershellScriptCommand, powershellLiteral } from "./herdr-fleet.ts";
import { RemoteLeadDelegations, type RemoteLeadBinding } from "./remote-lead-delegations.ts";

type Runtimes = Pick<ExecutionConnections, "fleets" | "fleetStream" | "remoteWorkspace" | "requireAccess">;
interface RemoteProjectLeadOptions {
  repoRoot: string;
  directory: string;
  settings: SettingsStore;
  runtimes: Runtimes;
  captain: CaptainPort;
}

/** Owns launch intent and ephemeral authority, never owns existing remote panes. */
export class RemoteProjectLeads {
  readonly delegations: RemoteLeadDelegations;
  private readonly options: RemoteProjectLeadOptions;
  constructor(options: RemoteProjectLeadOptions) {
    this.options = options;
    this.delegations = new RemoteLeadDelegations(async (binding) => {
      await options.runtimes.requireAccess(binding.fleet, "workers");
      const settings = await options.settings.load();
      const connection = settings.execution.connections.find((entry) => entry.id === binding.fleet);
      if (!connection?.enabled || connection.machine !== binding.machine || !connection.ssh ||
          !options.captain.seatContext(binding.conversationId)) throw new Error("remote_lead_binding_unavailable");
    });
  }

  private async fleet(id: string) {
    await this.options.runtimes.requireAccess(id, "workers");
    const fleet = (await this.options.runtimes.fleets()).find((entry) => entry.id === id);
    if (!fleet || fleet.ssh.shell !== "powershell") throw new Error("Remote leads currently require a linked Windows fleet");
    return fleet;
  }

  async prepare(id: string) {
    const fleet = await this.fleet(id);
    const root = this.options.repoRoot;
    const bridge = await readFile(join(root, "apps/tui/bin/remote-lead-mcp.js")).catch(() =>
      readFile(join(root, ".local/remote-lead/remote-lead-mcp.mjs")));
    const files = {
      "bridge.mjs": bridge.toString("base64"),
      "bootstrap.mjs": (await readFile(join(root, "integrations/remote-lead/bootstrap.mjs"))).toString("base64"),
      "output-styles/clankie.md": (await readFile(join(root, "integrations/claude-plugin/output-styles/clankie.md"))).toString("base64"),
      ".claude-plugin/plugin.json": Buffer.from(JSON.stringify({ name: "clankie-remote-lead", version: "0.1.0", description: "Clankie's project lead over an authenticated fleet link" })).toString("base64"),
      ".mcp.json": Buffer.from(JSON.stringify({ mcpServers: { lead: {
        command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bridge.mjs"],
      } } })).toString("base64"),
      "hooks/hooks.json": Buffer.from(JSON.stringify({ hooks: Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "StopFailure", "SessionEnd", "PreCompact", "Interrupt"]
          .map((event) => [event, [{ hooks: [
            ...(event === "SessionStart" ? [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bridge.mjs", "--prompt"], timeout: 60 }] : []),
            { type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/bridge.mjs", "--sync"], timeout: 60 },
          ] }]]),
      ) })).toString("base64"),
    };
    const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    const script = `$ErrorActionPreference='Stop'
$inputData=[Console]::In.ReadToEnd() | ConvertFrom-Json
$root=Join-Path $env:USERPROFILE '.clankie\\remote-leads\\${hash}'
New-Item -ItemType Directory -Force $root | Out-Null
if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected plugin root'}
foreach($file in $inputData.psobject.Properties){
 $path=Join-Path $root $file.Name
 New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
 $bytes=[Convert]::FromBase64String([string]$file.Value)
 if(Test-Path -LiteralPath $path){if([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -cne [string]$file.Value){throw 'Plugin artifact changed'}}
 else{[IO.File]::WriteAllBytes($path,$bytes)}
}
[ordered]@{directory=$root;hash='${hash}'} | ConvertTo-Json -Compress`;
    const child = this.options.runtimes.fleetStream(fleet)(powershellScriptCommand(script));
    const result = await collect(child, JSON.stringify(files));
    const prepared = JSON.parse(result) as { directory: string; hash: string };
    if (typeof prepared.directory !== "string" || prepared.hash !== hash) throw new Error("Remote lead preparation unconfirmed");
    return { fleet: id, ...prepared };
  }

  async launch(input: RemoteLeadLaunch, ownerGuard: () => Promise<void>) {
    await ownerGuard();
    const fleet = await this.fleet(input.fleet);
    if (!(await this.options.runtimes.remoteWorkspace(input.fleet, input.workingDirectory)))
      throw new Error("Remote lead needs an owner-approved working directory");
    await mkdir(this.options.directory, { recursive: true });
    const path = join(this.options.directory, `${input.requestId}.json`);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const record: Record<string, unknown> = { requestId: input.requestId, fingerprint, stage: "reserved" };
    try { await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const original = JSON.parse(await readFile(path, "utf8"));
      if (original.fingerprint !== fingerprint) throw new Error("Remote lead request ID belongs to different intent");
      return original;
    }
    let grantId: string | undefined;
    let child: ChildProcess | undefined;
    try {
      const prepared = await this.prepare(input.fleet);
      let conversationId = input.conversationId;
      if (conversationId === undefined) {
        await ownerGuard();
        const result = await this.options.captain.serveOperatorConversation({
          op: "create", schemaVersion: 1, title: input.title,
          scope: { kind: "workspace", workspaceId: input.workingDirectory },
        });
        if (result.op !== "create") throw new Error("Project conversation creation failed");
        conversationId = result.conversation.conversationId;
      }
      const context = this.options.captain.seatContext(conversationId);
      if (!context || context.cwd !== input.workingDirectory || this.options.captain.operatorSeatReady?.(conversationId))
        throw new Error("Choose an unoccupied project conversation in this working directory");
      const settings = await this.options.settings.load();
      const connection = settings.execution.connections.find((entry) => entry.id === input.fleet);
      // Current Windows native proof names the registered fleet as its machine.
      if (connection?.machine !== input.fleet) throw new Error("Remote lead requires an exact fleet/machine binding");
      const nativeSession = randomUUID();
      Object.assign(record, { conversationId, nativeSession, plugin: prepared.directory, stage: "allocating" });
      await writeFile(path, JSON.stringify(record));
      await ownerGuard();
      await this.options.runtimes.requireAccess(input.fleet, "workers");
      child = this.options.runtimes.fleetStream(fleet)(powershellScriptCommand(
        `& node ${powershellLiteral(`${prepared.directory}\\bootstrap.mjs`)}`,
      ));
      child.stderr?.resume(); // Remote errors must never echo the private input frame.
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })[Symbol.asyncIterator]();
      child.stdin!.write(JSON.stringify({
        session: fleet.session, cwd: input.workingDirectory, title: input.title,
        fleet: input.fleet, nativeSession, plugin: prepared.directory,
      }) + "\n");
      const allocated = await nextFrame(lines);
      if (allocated.stage !== "allocated" || !/^w[\w]+:p[\w]+$/u.test(allocated.pane) ||
          !Number.isSafeInteger(allocated.shell?.pid) || typeof allocated.shell?.startTime !== "string")
        throw new Error("Remote lead allocation unconfirmed");
      const binding: RemoteLeadBinding = {
        fleet: input.fleet, machine: connection.machine, pane: allocated.pane, conversationId,
        nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:claude", kind: "id", value: nativeSession }),
        shell: allocated.shell,
      };
      Object.assign(record, { pane: `${input.fleet}/${allocated.pane}`, stage: "allocated" });
      await writeFile(path, JSON.stringify(record));
      await ownerGuard();
      const grant = await this.delegations.issue(binding);
      grantId = grant.id;
      Object.assign(record, { delegationId: grant.id, stage: "dispatching" });
      await writeFile(path, JSON.stringify(record));
      child.stdin!.end(JSON.stringify({ token: grant.token, conversationId }) + "\n");
      const dispatched = await nextFrame(lines);
      if (dispatched.stage !== "dispatched" || dispatched.pane !== allocated.pane)
        throw new Error("Remote lead dispatch unconfirmed");
      Object.assign(record, { stage: "dispatched", detail: "Native tool admission and channel attachment still require live proof" });
      await writeFile(path, JSON.stringify(record));
      return record;
    } catch {
      if (grantId) this.delegations.revoke(grantId);
      Object.assign(record, { stage: "unconfirmed", detail: "Launch did not confirm. Inspect this original receipt and owned pane; do not replay." });
      await writeFile(path, JSON.stringify(record));
      return record;
    } finally {
      child?.stdin?.end();
      child?.kill();
    }
  }
}

async function nextFrame(lines: AsyncIterator<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = await Promise.race([lines.next(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Remote lead reply unconfirmed")), 60000);
    })]);
    if (next.done) throw new Error("Remote lead transport closed");
    return JSON.parse(next.value);
  } finally { clearTimeout(timer); }
}

function collect(child: ChildProcess, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Remote preparation timed out")); }, 30000);
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > 16384) { child.kill(); reject(new Error("Remote preparation response too large")); }
    });
    child.stderr?.resume();
    child.on("error", () => { clearTimeout(timer); reject(new Error("Remote preparation unavailable")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output); else reject(new Error("Remote preparation failed"));
    });
    child.stdin!.end(input);
  });
}
