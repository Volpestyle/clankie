import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { RemoteLeadLaunch } from "@clankie/protocol/remote-leads";
import type { SettingsStore } from "@clankie/settings";
import type { ExecutionConnections } from "./herdr-session.ts";
import type { CaptainPort } from "./captain/port.ts";
import { redactSensitiveText } from "@clankie/observability";
import { logger } from "./app/log.ts";
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

// The bridge bundles node:sqlite, experimental on the PC's Node 22. Its warning is
// the first stderr line a hook shows, hiding the real outcome (VUH-2036).
const NO_SQLITE_WARNING = "--disable-warning=ExperimentalWarning";

export class RemoteLeadBuildMissing extends Error {
  constructor() {
    super(
      "Remote lead bridge missing; run clankie heavy -- node scripts/build-remote-lead.mjs in the runtime checkout",
    );
  }
}

/** Owns launch intent and process-bound authority, never owns existing remote panes. */
export class RemoteProjectLeads {
  readonly delegations: RemoteLeadDelegations;
  private readonly options: RemoteProjectLeadOptions;
  constructor(options: RemoteProjectLeadOptions) {
    this.options = options;
    this.delegations = new RemoteLeadDelegations(
      async (binding) => {
        await options.runtimes.requireAccess(binding.fleet, "workers");
        const settings = await options.settings.load();
        const connection = settings.execution.connections.find((entry) => entry.id === binding.fleet);
        if (
          !connection?.enabled ||
          connection.machine !== binding.machine ||
          !connection.ssh ||
          connectionKey(connection) !== binding.connectionKey ||
          !(await options.runtimes.remoteWorkspace(binding.fleet, binding.workingDirectory)) ||
          options.captain.seatContext(binding.conversationId)?.machineId !== binding.machine ||
          options.captain.seatContext(binding.conversationId)?.cwd !== binding.workingDirectory
        )
          throw new Error("remote_lead_binding_unavailable");
      },
      join(options.directory, "delegations"),
    );
  }

  private async fleet(id: string) {
    await this.options.runtimes.requireAccess(id, "workers");
    const fleet = (await this.options.runtimes.fleets()).find((entry) => entry.id === id);
    if (!fleet || fleet.ssh.shell !== "powershell")
      throw new Error("Remote leads currently require a linked Windows fleet");
    return fleet;
  }

  async prepare(id: string, ownerGuard: () => Promise<void> = async () => {}) {
    const fleet = await this.fleet(id);
    const root = this.options.repoRoot;
    const bridge = await readFile(join(root, "apps/tui/bin/remote-lead-mcp.js")).catch(() =>
      readFile(join(root, ".local/remote-lead/remote-lead-mcp.mjs")).catch(() => {
        throw new RemoteLeadBuildMissing();
      }),
    );
    const files = {
      "bridge.mjs": bridge.toString("base64"),
      "bootstrap.mjs": (await readFile(join(root, "integrations/remote-lead/bootstrap.mjs"))).toString(
        "base64",
      ),
      "claude-setup.mjs": (await readFile(join(root, "integrations/remote-lead/claude-setup.mjs"))).toString(
        "base64",
      ),
      "output-styles/clankie.md": (
        await readFile(join(root, "integrations/claude-plugin/output-styles/clankie.md"))
      ).toString("base64"),
      ".claude-plugin/plugin.json": Buffer.from(
        JSON.stringify({
          name: "clankie-remote-lead",
          version: "0.1.0-" + createHash("sha256").update(bridge).digest("hex").slice(0, 16),
          description: "Clankie's project lead over an authenticated fleet link",
        }),
      ).toString("base64"),
      ".claude-plugin/marketplace.json": Buffer.from(
        JSON.stringify({
          name: "clankie-remote-leads",
          owner: { name: "Clankie" },
          plugins: [{ name: "clankie-remote-lead", source: "./" }],
        }),
      ).toString("base64"),
      ".mcp.json": Buffer.from(
        JSON.stringify({
          mcpServers: {
            lead: {
              command: "node",
              args: [NO_SQLITE_WARNING, "${CLAUDE_PLUGIN_ROOT}/bridge.mjs"],
            },
          },
        }),
      ).toString("base64"),
      "hooks/hooks.json": Buffer.from(
        JSON.stringify({
          hooks: Object.fromEntries(
            [
              "SessionStart",
              "UserPromptSubmit",
              "PostToolUse",
              "Stop",
              "StopFailure",
              "SessionEnd",
              "PreCompact",
              "Interrupt",
            ].map((event) => [
              event,
              [
                {
                  hooks: [
                    ...(event === "SessionStart"
                      ? [
                          {
                            type: "command",
                            command: "node",
                            args: [NO_SQLITE_WARNING, "${CLAUDE_PLUGIN_ROOT}/bridge.mjs", "--prompt"],
                            timeout: 60,
                          },
                        ]
                      : []),
                    {
                      type: "command",
                      command: "node",
                      args: [NO_SQLITE_WARNING, "${CLAUDE_PLUGIN_ROOT}/bridge.mjs", "--sync"],
                      timeout: 60,
                    },
                  ],
                },
              ],
            ]),
          ),
        }),
      ).toString("base64"),
    };
    const manifest = JSON.parse(Buffer.from(files[".claude-plugin/plugin.json"], "base64").toString());
    // Hook/bootstrap changes must refresh the native cache too.
    manifest.version =
      "0.1.0-" + createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 16);
    files[".claude-plugin/plugin.json"] = Buffer.from(JSON.stringify(manifest)).toString("base64");
    const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    // PowerShell's Console.In can stall on large SSH frames. Node reads the
    // framed payload directly from the pipe; the command contains code only.
    const installer = `
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if(input.length > 16*1024*1024) process.exit(1); });
process.stdin.on('end', () => {
 const files = JSON.parse(input);
 const root = path.join(os.homedir(), '.clankie', 'remote-leads', '${hash}');
 const plain = target => {
  for(let cursor=target;;cursor=path.dirname(cursor)) {
   try { if(fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Redirected plugin path'); }
   catch(error) { if(error.code !== 'ENOENT') throw error; }
   if(path.dirname(cursor) === cursor) break;
  }
 };
 plain(root);
 fs.mkdirSync(root, {recursive:true});
 for(const [name, encoded] of Object.entries(files)) {
  const target = path.resolve(root, name);
  if(!target.startsWith(root + path.sep)) throw new Error('Invalid plugin path');
  plain(target);
  fs.mkdirSync(path.dirname(target), {recursive:true});
  const bytes = Buffer.from(encoded, 'base64');
  if(fs.existsSync(target)) {
   if(!fs.readFileSync(target).equals(bytes)) throw new Error('Plugin artifact changed');
  } else fs.writeFileSync(target, bytes, {flag:'wx'});
 }
 console.log(JSON.stringify({directory:root,hash:'${hash}'}));
});`;
    const evaluate = `eval(Buffer.from('${Buffer.from(installer).toString("base64")}','base64').toString())`;
    await ownerGuard();
    if (JSON.stringify(await this.fleet(id)) !== JSON.stringify(fleet))
      throw new Error("Remote lead connection changed");
    const child = this.options.runtimes.fleetStream(fleet)(
      powershellScriptCommand(`& node -e ${powershellLiteral(evaluate)}`),
    );
    const result = await collect(child, JSON.stringify(files));
    const prepared = remoteLeadFrame(result) as { directory: string; hash: string };
    if (typeof prepared.directory !== "string" || prepared.hash !== hash)
      throw new Error("Remote lead preparation unconfirmed");
    return { fleet: id, ...prepared };
  }

  async launch(input: RemoteLeadLaunch, ownerGuard: () => Promise<void>) {
    await ownerGuard();
    const fleet = await this.fleet(input.fleet);
    const initialConnection = (await this.options.settings.load()).execution.connections.find(
      (entry) => entry.id === input.fleet,
    );
    if (!initialConnection) throw new Error("Remote lead connection unavailable");
    const expectedConnection = connectionKey(initialConnection);
    const guard = async () => {
      await ownerGuard();
      const current = (await this.options.settings.load()).execution.connections.find(
        (entry) => entry.id === input.fleet,
      );
      if (
        !current ||
        connectionKey(current) !== expectedConnection ||
        JSON.stringify(await this.fleet(input.fleet)) !== JSON.stringify(fleet)
      )
        throw new Error("Remote lead connection changed");
    };
    await guard();
    if (!(await this.options.runtimes.remoteWorkspace(input.fleet, input.workingDirectory)))
      throw new Error("Remote lead needs an owner-approved working directory");
    await mkdir(this.options.directory, { recursive: true });
    const path = join(this.options.directory, `${input.requestId}.json`);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const record: Record<string, unknown> = { requestId: input.requestId, fingerprint, stage: "reserved" };
    try {
      await writeFile(path, JSON.stringify(record), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const original = JSON.parse(await readFile(path, "utf8"));
      if (original.fingerprint !== fingerprint)
        throw new Error("Remote lead request ID belongs to different intent");
      return original;
    }
    let grantId: string | undefined;
    let grantToken: string | undefined;
    let child: ChildProcess | undefined;
    try {
      await guard();
      if (initialConnection.machine !== input.fleet)
        throw new Error("Remote lead requires an exact fleet/machine binding");
      const prepared = await this.prepare(input.fleet, guard);
      await guard();
      let conversationId = input.conversationId;
      if (conversationId === undefined) {
        await guard();
        if (!(await this.options.runtimes.remoteWorkspace(input.fleet, input.workingDirectory)))
          throw new Error("Remote lead workspace approval changed");
        const conversation = this.options.captain.createRemoteWorkspaceConversation({
          title: input.title,
          workspaceId: input.workingDirectory,
          machineId: initialConnection.machine,
        });
        conversationId = conversation.conversationId;
      }
      const selected = await this.options.captain.serveOperatorConversation({
        op: "get",
        schemaVersion: 1,
        conversationId,
      });
      if (
        selected.op !== "get" ||
        selected.conversation?.scope.kind !== "workspace" ||
        selected.conversation.scope.workspaceId !== input.workingDirectory ||
        selected.conversation.scope.machineId !== initialConnection.machine
      )
        throw new Error("Remote lead requires a workspace conversation");
      const context = this.options.captain.seatContext(conversationId);
      if (
        !context ||
        context.cwd !== input.workingDirectory ||
        context.machineId !== initialConnection.machine ||
        this.options.captain.operatorSeatReady?.(conversationId)
      )
        throw new Error("Choose an unoccupied project conversation in this working directory");
      const settings = await this.options.settings.load();
      const connection = settings.execution.connections.find((entry) => entry.id === input.fleet);
      // Current Windows native proof names the registered fleet as its machine.
      if (connection?.machine !== input.fleet)
        throw new Error("Remote lead requires an exact fleet/machine binding");
      const nativeSession = randomUUID();
      // The owner's switch at launch (VUH-2048); a running lead keeps its mode.
      const maximumTrust = settings.maximumTrustMode;
      Object.assign(record, {
        conversationId,
        nativeSession,
        plugin: prepared.directory,
        maximumTrust,
        stage: "allocating",
      });
      await writeFile(path, JSON.stringify(record));
      await guard();
      await this.options.runtimes.requireAccess(input.fleet, "workers");
      child = this.options.runtimes.fleetStream(fleet)(
        powershellScriptCommand(`& node ${powershellLiteral(`${prepared.directory}\\bootstrap.mjs`)}`),
      );
      child.stderr?.resume(); // Remote errors must never echo the private input frame.
      const failed = () => child?.stdout?.destroy(new Error("Remote lead transport unavailable"));
      child.on("error", failed);
      child.stdin?.on("error", failed);
      const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity })[Symbol.asyncIterator]();
      child.stdin!.write(
        JSON.stringify({
          session: fleet.session,
          cwd: input.workingDirectory,
          title: input.title,
          fleet: input.fleet,
          account: input.account,
          nativeSession,
          plugin: prepared.directory,
          maximumTrust,
        }) + "\n",
      );
      const allocated = await nextFrame(lines);
      if (allocated.stage === "refused" && typeof allocated.error === "string")
        throw new Error(allocated.error.slice(0, 1024));
      if (
        allocated.stage !== "allocated" ||
        !/^w[\w]+:p[\w]+$/u.test(allocated.pane) ||
        !Number.isSafeInteger(allocated.shell?.pid) ||
        typeof allocated.shell?.startTime !== "string"
      )
        throw new Error("Remote lead allocation unconfirmed");
      const binding: RemoteLeadBinding = {
        fleet: input.fleet,
        machine: connection.machine,
        pane: allocated.pane,
        conversationId,
        workingDirectory: input.workingDirectory,
        connectionKey: expectedConnection,
        nativeOccupantId: occupantIdForHerdrSession({
          source: "herdr:claude",
          kind: "id",
          value: nativeSession,
        }),
        shell: allocated.shell,
      };
      Object.assign(record, { pane: `${input.fleet}/${allocated.pane}`, stage: "allocated" });
      await writeFile(path, JSON.stringify(record));
      await guard();
      const grant = await this.delegations.issue(binding);
      grantId = grant.id;
      grantToken = grant.token;
      Object.assign(record, { delegationId: grant.id, stage: "dispatching" });
      await writeFile(path, JSON.stringify(record));
      await guard();
      child.stdin!.end(JSON.stringify({ token: grant.token, conversationId }) + "\n");
      const dispatched = await nextFrame(lines);
      if (dispatched.stage !== "dispatched" || dispatched.pane !== allocated.pane)
        throw new Error("Remote lead dispatch unconfirmed");
      Object.assign(record, {
        stage: "dispatched",
        detail: "Native tool admission and channel attachment still require live proof",
      });
      await writeFile(path, JSON.stringify(record));
      return record;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const redactedError = redactSensitiveText(
        grantToken ? message.replaceAll(grantToken, "[REDACTED]") : message,
      ).slice(0, 1024);
      logger.warn(
        {
          event: "remote_lead.launch_failed",
          requestId: input.requestId,
          failedStage: record.stage,
          error: redactedError,
        },
        "Remote lead launch unconfirmed",
      );
      if (grantId) this.delegations.revoke(grantId);
      Object.assign(record, {
        failedStage: record.stage,
        error: redactedError,
        stage: "unconfirmed",
        detail: "Launch did not confirm. Inspect this original receipt and owned pane; do not replay.",
      });
      await writeFile(path, JSON.stringify(record));
      return record;
    } finally {
      child?.stdin?.end();
      child?.kill();
    }
  }
}

/** Parser errors may echo private response fragments; only retain the framing failure. */
function remoteLeadFrame(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Remote lead reply is not valid JSON");
  }
}

async function nextFrame(lines: AsyncIterator<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const next = await Promise.race([
      lines.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Remote lead reply unconfirmed")), 60000);
      }),
    ]);
    if (next.done) throw new Error("Remote lead transport closed");
    return remoteLeadFrame(next.value);
  } finally {
    clearTimeout(timer);
  }
}

function collect(child: ChildProcess, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Remote preparation timed out"));
    }, 30000);
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > 16384) {
        child.kill();
        reject(new Error("Remote preparation response too large"));
      }
    });
    child.stderr?.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Remote preparation unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error("Remote preparation failed"));
    });
    child.stdin?.on("error", () => {
      clearTimeout(timer);
      child.kill();
      reject(new Error("Remote preparation transport unavailable"));
    });
    child.stdin!.end(input);
  });
}

function connectionKey(connection: unknown): string {
  return createHash("sha256").update(JSON.stringify(connection)).digest("hex");
}
