import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { HerdrBinding } from "@clankie/protocol";
import type { FleetWorkerToolRestartResult } from "@clankie/protocol/tool-catalog";
import type { SavedAgentSession } from "../agent-sessions.ts";
import { nativeRequest } from "../herdr-native-request.ts";
import {
  nativeProcessReceipt,
  observeCodexServer,
  observeNativeBirth,
  observeNativeProcesses,
} from "../local-fleet-process.ts";
import { isLocalCodexEndpoint } from "../local-codex-records.ts";
import {
  codexProcess,
  parseHerdrForegroundProcesses,
  resolveCodexHome,
  resolveCodexSessionId,
} from "./codex-seat.ts";
import { CodexAppServerClient, openCodexSocket } from "./codex-app-server.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import { paneDraftState } from "./pane-draft.ts";
import { isolatedCodexConfig } from "./codex-catalog-refresh.ts";
import { assertConversationAuthority, type ConversationAuthority } from "./conversation-owner.ts";

const Journal = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  paneId: z.string(),
  seatId: z.string(),
  threadId: z.string().uuid(),
  cwd: z.string(),
  pid: z.number().int().min(2),
  birth: z.tuple([z.string(), z.string()]),
  state: z.enum(["quit-dispatched", "exited", "resume-dispatched", "restarted"]),
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
class Refusal extends Error {}
const require = (ok: unknown, reason: string): void => {
  if (!ok) throw new Refusal(reason);
};

/** Supervised native keyboard quit, followed by one shell-ready launch in the SAME pane.
 * Durable dispatch claims deliberately survive lost replies and service restarts. */
export class SupervisedCodexRestart {
  private readonly options: {
    directory: string;
    processHelper: string;
    runner: HerdrWatchRunner;
    binding(): Promise<HerdrBinding | undefined>;
    remoteServer(
      paneId: string,
      threadId: string,
    ): { pid: number; start: string; endpoint?: string | undefined } | undefined;
    resolve(ref: string): Promise<SavedAgentSession>;
    prepare(saved: SavedAgentSession, originalHome: string): Promise<{ home: string }>;
    admitted(agent: HerdrAgentSnapshot, authority: ConversationAuthority): Promise<boolean>;
    changed(): void;
  };
  constructor(options: SupervisedCodexRestart["options"]) {
    this.options = options;
  }

  async restart(paneId: string, authority: ConversationAuthority): Promise<FleetWorkerToolRestartResult> {
    if (!/^w[\w]+:p[\w]+$/u.test(paneId)) return { outcome: "refused", reason: "invalid_pane" };
    const file = join(this.options.directory, `${createHash("sha256").update(paneId).digest("hex")}.json`);
    const lock = `${file}.lock`;
    let locked = false;
    let entry: z.infer<typeof Journal> | undefined;
    let client: CodexAppServerClient | undefined;
    const save = () => {
      const temporary = `${file}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(Journal.parse(entry)));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, file);
      const directory = openSync(this.options.directory, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.options.changed();
    };
    try {
      await assertConversationAuthority(authority);
      mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
      // Never steal a lock, including after a crash. An operator inspects that original attempt.
      const fd = openSync(lock, "wx", 0o600);
      closeSync(fd);
      locked = true;
      let previous: z.infer<typeof Journal> | undefined;
      try {
        previous = Journal.parse(JSON.parse(readFileSync(file, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      require(!previous || previous.state === "restarted", "restart_unconfirmed");
      const binding = await this.options.binding();
      require(binding, "herdr_unavailable");
      const runner = this.options.runner;
      require(runner.openFiles && runner.readPane && runner.list, "restart_unsupported");
      const fresh = async () => {
        const row = (await runner.list!()).find((seat) => seat.paneId === paneId);
        require(row?.agent === "codex" &&
          row.session?.kind === "id" &&
          z.string().uuid().safeParse(row.session.value).success, "thread_unproven");
        return row!;
      };
      const original = await fresh();
      require(await this.options.admitted(original, authority), "provenance_unknown");
      const threadId = original.session!.value;
      require(original.workingDirectory, "thread_unproven");
      const cwd = await realpath(original.workingDirectory!);
      const info = object(
        object(await nativeRequest(binding!, "pane.process_info", { pane_id: paneId })).result,
      ).process_info;
      const shellPid = Number(object(info).shell_pid);
      const nativeProcess = codexProcess(
        parseHerdrForegroundProcesses(JSON.stringify({ result: { process_info: info } })),
      );
      require(nativeProcess?.argv && nativeProcess.argv.length > 0, "process_unproven");
      const argv = nativeProcess!.argv!;
      const proof = await observeNativeProcesses(shellPid, nativeProcess!.pid);
      require(proof && basename(proof.processes[1]!.executable) === "codex", "process_unproven");
      const birth = proof!.processes[1]!.birth;
      const processCwd = async () => {
        const result = await promisify(execFile)(
          "/usr/bin/python3",
          ["-I", this.options.processHelper, String(nativeProcess!.pid)],
          { timeout: 5_000, maxBuffer: 8192 },
        );
        const facts = object(JSON.parse(result.stdout));
        require(facts.pid === nativeProcess!.pid &&
          facts.uid === process.getuid?.() &&
          same(facts.birth, birth) &&
          (await realpath(String(facts.cwd))) === cwd &&
          (await realpath(String(facts.executable))) ===
            (await realpath(proof!.processes[1]!.executable)), "process_unproven");
      };
      await processCwd();
      const files = await runner.openFiles!(nativeProcess!.pid);
      const resumed = argv.indexOf("resume");
      const saved = await this.options.resolve(`local:${threadId}`);
      require(saved.sessionId === threadId &&
        saved.file?.harness === "codex" &&
        (await realpath(saved.workingDirectory)) === cwd, "thread_unproven");
      // Preserve the observed native CLI mode and flags. Reject prompts, fork/last,
      // and unrecognized positional argv; this is never a fresh-thread launch.
      const prefix = argv.slice(1, resumed < 0 ? argv.length : resumed);
      const valueFlags = new Set([
        "--remote",
        "--model",
        "-m",
        "--sandbox",
        "-s",
        "--ask-for-approval",
        "-a",
        "--config",
        "-c",
        "--cd",
        "-C",
        "--profile",
        "-p",
      ]);
      const switches = new Set([
        "--no-daemon",
        "--no-alt-screen",
        "--full-auto",
        "--dangerously-bypass-approvals-and-sandbox",
      ]);
      for (let i = 0; i < prefix.length; i++) {
        const arg = prefix[i]!;
        if (valueFlags.has(arg)) require(typeof prefix[++i] === "string", "launch_unproven");
        else
          require(switches.has(arg) ||
            [...valueFlags].some((flag) => arg.startsWith(`${flag}=`)), "launch_unproven");
      }
      require(resumed < 0 || argv.length === resumed + 2, "launch_unproven");
      const remoteAt = prefix.indexOf("--remote");
      const endpoint =
        remoteAt >= 0 ? prefix[remoteAt + 1] : prefix.find((arg) => arg.startsWith("--remote="))?.slice(9);
      require(endpoint === undefined || isLocalCodexEndpoint(endpoint), "launch_unproven");
      if (!endpoint)
        require(resolveCodexSessionId([nativeProcess!], files, threadId) === threadId ||
          (resumed > 0 && argv[resumed + 1] === threadId), "thread_unproven");
      let originalHome = resolveCodexHome(files, threadId);
      let remoteConfig: { filePath: string; version: string } | undefined;
      if (endpoint) {
        const server = this.options.remoteServer(paneId, threadId);
        const serverBirth =
          server && (await observeCodexServer(server.pid, endpoint, await realpath(endpoint.slice(7))));
        require(server &&
          serverBirth &&
          nativeProcessReceipt(serverBirth, server.start) === server.start &&
          (!server.endpoint || server.endpoint === endpoint), "original_controller_unproven");
        const socket = await openCodexSocket(`ws+unix://${endpoint.slice(7)}:/`);
        require(socket, "thread_unproven");
        client = new CodexAppServerClient(socket!, () => {}, 5_000);
        await client.initialize(true);
        const config = object(await client.request("config/read", { cwd, includeLayers: true }));
        const users = (Array.isArray(config.layers) ? config.layers : [])
          .map(object)
          .filter(
            (layer) =>
              object(layer.name).type === "user" &&
              layer.disabledReason == null &&
              object(layer.name).profile == null,
          );
        require(users.length === 1 && typeof object(users[0]!.name).file === "string", "account_unproven");
        const home = dirname(String(object(users[0]!.name).file));
        require(!originalHome ||
          (await realpath(join(originalHome, "sessions"))) ===
            (await realpath(join(home, "sessions"))), "account_unproven");
        originalHome = home;
        const filePath = await isolatedCodexConfig(home);
        require(filePath === object(users[0]!.name).file &&
          typeof users[0]!.version === "string", "original_config_unproven");
        remoteConfig = { filePath, version: String(users[0]!.version) };
      }
      require(originalHome, "account_unproven");
      const prepared = await this.options.prepare(saved, originalHome!);
      // A shell's startup environment does not prove its current exported
      // account selection. Only the original dedicated controller fixes that
      // selection independently of mutable shell variables.
      require(endpoint, "shell_account_unproven");
      require(prepared.home === (await realpath(originalHome!)), "account_unproven");
      const nativeIdle = async (afterExit = false) => {
        if (!client) return;
        const loaded = object(await client.request("thread/loaded/list", {}));
        require((same(loaded.data, [threadId]) || (afterExit && same(loaded.data, []))) &&
          loaded.nextCursor == null, "independent_codex_loaded_root");
        const thread = object(
          object(await client.request("thread/read", { threadId, includeTurns: false })).thread,
        );
        require(thread.id === threadId && (await realpath(String(thread.cwd))) === cwd, "thread_unproven");
        require(object(thread.status).type === "idle" ||
          (afterExit && object(thread.status).type === "notLoaded"), "busy");
      };
      const guard = async () => {
        await assertConversationAuthority(authority);
        require(same(await this.options.binding(), binding), "provenance_unknown");
        const latest = await fresh();
        require(latest.terminalId === original.terminalId &&
          latest.session?.value === threadId &&
          latest.workingDirectory === original.workingDirectory &&
          (await this.options.admitted(latest, authority)), "provenance_unknown");
        // Older screen detectors may say unknown for this installed TUI. Only
        // the original native controller's independent idle proof may cover it.
        require(["idle", "waiting", "done"].includes(latest.status) ||
          (client && latest.status === "unknown"), "busy");
        require(same(await observeNativeProcesses(shellPid, nativeProcess!.pid), proof), "process_unproven");
        await processCwd();
        const currentProcesses = await runner.paneProcesses?.(paneId);
        require(currentProcesses && same(codexProcess(currentProcesses)?.argv, argv), "process_unproven");
        await nativeIdle();
        const draft = paneDraftState("codex", await runner.readPane!(paneId, "visible", "ansi"));
        require(draft === "empty", draft === "draft" ? "unsent_draft" : "draft_state_unknown");
        await assertConversationAuthority(authority);
      };
      await guard();
      entry = {
        version: 1,
        id: randomUUID(),
        paneId,
        seatId: original.terminalId,
        threadId,
        cwd,
        pid: nativeProcess!.pid,
        birth,
        state: "quit-dispatched",
      };
      // Last guard precedes the durable intent; no async preparation follows it.
      save();
      await nativeRequest(binding!, "agent.send_keys", { target: paneId, keys: ["ctrl+d", "ctrl+d"] }).catch(
        () => undefined,
      );
      const deadline = Date.now() + 30_000;
      let exited = false;
      do {
        // ESRCH from kill(pid,0) is a kernel absence observation, NOT termination.
        // Observation failure, PID reuse or missing Herdr alone never proves exit.
        try {
          processAlive(entry.pid);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") exited = true;
          else throw error;
        }
        if (!exited) {
          const currentBirth = await observeNativeBirth(entry.pid);
          require(!currentBirth || same(currentBirth, birth), "process_unproven");
          await delay(100);
        }
      } while (!exited && Date.now() < deadline);
      require(exited, "quit_unconfirmed");
      entry.state = "exited";
      save();
      await assertConversationAuthority(authority);
      require(same(await this.options.binding(), binding), "provenance_unknown");
      let shell = (await runner.list!()).find((seat) => seat.paneId === paneId);
      const shellDeadline = Date.now() + 10_000;
      while (
        shell?.terminalId === original.terminalId &&
        shell.agent !== "unknown" &&
        Date.now() < shellDeadline
      ) {
        await delay(100);
        shell = (await runner.list!()).find((seat) => seat.paneId === paneId);
      }
      require(shell?.terminalId === original.terminalId &&
        shell.agent === "unknown" &&
        (await realpath(shell.workingDirectory!)) === cwd, "pane_lifetime_changed");
      // Retained reports may still name the exited TUI. They are not an exit
      // proof or a reason to clear another occupant. Herdr's agent.start below
      // independently requires a live available shell before it sends bytes.
      const foreground = parseHerdrForegroundProcesses(
        JSON.stringify(await nativeRequest(binding!, "pane.process_info", { pane_id: paneId })),
      );
      require(foreground.length > 0 && !codexProcess(foreground), "resume_unconfirmed");
      require(same(await observeNativeBirth(shellPid), proof!.processes[0]!.birth), "process_unproven");
      await assertConversationAuthority(authority);
      entry.state = "resume-dispatched";
      save();
      // The same remote controller reloads its current on-disk plugin before
      // resumption. This dispatch is covered by the retained resume claim.
      if (client) {
        await nativeIdle(true);
        await assertConversationAuthority(authority);
        // A transport env revision replaces the old ready MCP client. Reload
        // alone can reuse it. Only this original private config is writable.
        const written = object(
          await client.request("config/value/write", {
            keyPath: "mcp_servers.clankie.env.CLANKIE_CATALOG_REVISION",
            value: entry.id,
            mergeStrategy: "upsert",
            filePath: remoteConfig!.filePath,
            expectedVersion: remoteConfig!.version,
          }),
        );
        require(written.status === "ok" &&
          written.filePath === remoteConfig!.filePath &&
          written.overriddenMetadata == null, "catalog_write_unconfirmed");
        await assertConversationAuthority(authority);
        await client.request("config/mcpServer/reload", {});
      }
      await assertConversationAuthority(authority);
      require(same(await this.options.binding(), binding), "provenance_unknown");
      const started = await nativeRequest(binding!, "agent.start", {
        name: `refresh-${entry.id.slice(0, 8)}`,
        kind: "codex",
        pane_id: paneId,
        args: [...prefix, "resume", threadId],
        timeout_ms: 30_000,
      }).catch(() => undefined);
      require(object(object(started).result).type === "agent_started", "resume_dispatch_unconfirmed");
      const resumeDeadline = Date.now() + 30_000;
      do {
        const latest = (await runner.list!()).find((seat) => seat.paneId === paneId);
        if (
          latest?.terminalId === original.terminalId &&
          latest.agent === "codex" &&
          latest.session?.value === threadId &&
          latest.workingDirectory === original.workingDirectory
        ) {
          const next = codexProcess(await runner.paneProcesses!(paneId));
          const nextProof = next && (await observeNativeProcesses(shellPid, next.pid));
          if (
            nextProof &&
            next!.pid !== entry.pid &&
            basename(nextProof.processes[1]!.executable) === "codex"
          ) {
            entry.state = "restarted";
            save();
            return { outcome: "restarted", historyId: entry.id, threadId, resumedSeatId: latest.terminalId };
          }
        }
        await delay(100);
      } while (Date.now() < resumeDeadline);
      throw new Refusal("resume_unconfirmed");
    } catch (error) {
      return {
        outcome: "refused",
        reason:
          error instanceof Refusal
            ? error.message
            : (error as NodeJS.ErrnoException).code === "EEXIST"
              ? "restart_unconfirmed"
              : "restart_observation_unavailable",
        ...(entry ? { historyId: entry.id, threadId: entry.threadId } : {}),
      };
    } finally {
      client?.close();
      if (locked) unlinkSync(lock);
    }
  }
}

function processAlive(pid: number): void {
  process.kill(pid, 0);
}
