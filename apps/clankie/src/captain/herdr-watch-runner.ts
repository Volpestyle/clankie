import { nativeHerdrRead } from "../herdr-native-read.ts";
import { nativeAgentWait } from "../herdr-native-wait.ts";
import { createHireLayout } from "./hire-layout.ts";
import { codexProxyControl, codexProxySettled } from "./external-codex-control.ts";
import type { OpenCodeCommandTab } from "./opencode-native-host.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHerdrForegroundProcesses } from "./codex-seat.ts";
import { recoverLocalCodexSession, type HerdrCensusRunner } from "./herdr-census.ts";
import { HerdrFleetError } from "../herdr-fleet.ts";
import { herdrKeyRuns } from "./herdr-keys.ts";
import { readHerdrSeatTranscript, type HerdrAgentSession } from "./herdr-transcript.ts";
import {
  SETTLED_STATUSES,
  AGENT_STATUSES,
  HERDR_COMMAND_TIMEOUT_MS,
  SEAT_REPLY_READ_LINES,
  SPAWN_CHANNEL_DIALOG_WAIT_MS,
  SPAWN_READY_WAIT_MS,
  shellWord,
} from "./herdr-watch-shared.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function titleOf(agent: Record<string, unknown>): string {
  for (const key of ["title", "terminal_title_stripped", "terminal_title"] as const) {
    const value = agent[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

export class HerdrAgentResponseError extends Error {
  public readonly code = "invalid_herdr_agent_response";

  public constructor(message: string) {
    super(message);
    this.name = "HerdrAgentResponseError";
  }
}

function snapshotOf(value: unknown): HerdrAgentSnapshot {
  if (!isRecord(value)) throw new HerdrAgentResponseError("Herdr response did not include an agent");
  const paneId = value.pane_id;
  const terminalId = value.terminal_id;
  if (typeof paneId !== "string" || typeof terminalId !== "string") {
    throw new HerdrAgentResponseError("Herdr response did not identify the agent pane");
  }
  const rawSession = isRecord(value.agent_session) ? value.agent_session : undefined;
  const session: HerdrAgentSession | undefined =
    typeof rawSession?.source === "string" &&
    (rawSession.kind === "id" || rawSession.kind === "path") &&
    typeof rawSession.value === "string"
      ? { source: rawSession.source, kind: rawSession.kind, value: rawSession.value }
      : undefined;
  return {
    paneId,
    terminalId,
    ...(typeof value.name === "string" && value.name.length > 0 ? { name: value.name } : {}),
    agent: typeof value.agent === "string" ? value.agent : "unknown",
    status: typeof value.agent_status === "string" ? value.agent_status : "unknown",
    title: titleOf(value),
    ...(typeof value.completion_seq === "number" &&
    Number.isSafeInteger(value.completion_seq) &&
    value.completion_seq >= 0
      ? { completionSeq: value.completion_seq }
      : {}),
    ...(typeof value.state_change_seq === "number" &&
    Number.isSafeInteger(value.state_change_seq) &&
    value.state_change_seq >= 0
      ? { stateChangeSeq: value.state_change_seq }
      : {}),
    ...(session === undefined ? {} : { session }),
    ...(typeof value.cwd === "string" ? { workingDirectory: value.cwd } : {}),
    ...(typeof value.foreground_cwd === "string" ? { foregroundWorkingDirectory: value.foreground_cwd } : {}),
  };
}

export function parseHerdrAgentResult(stdout: string): HerdrAgentSnapshot {
  const parsed = JSON.parse(stdout) as { result?: { agent?: unknown } };
  return snapshotOf(parsed.result?.agent);
}

export function parseHerdrForegroundProcessId(stdout: string): number | undefined {
  const parsed: unknown = JSON.parse(stdout);
  const result = isRecord(parsed) ? parsed.result : undefined;
  const processInfo = isRecord(result) ? result.process_info : undefined;
  const processes =
    isRecord(processInfo) && Array.isArray(processInfo.foreground_processes)
      ? processInfo.foreground_processes
      : [];
  const process = processes.find(isRecord);
  return process !== undefined && typeof process.pid === "number" ? process.pid : undefined;
}

/** Bad rows do not hide valid peers; a direct agent lookup still validates strictly. */
export function parseHerdrPaneList(stdout: string, strict = false): HerdrAgentSnapshot[] {
  const parsed = JSON.parse(stdout) as { result?: { panes?: unknown } };
  const panes = Array.isArray(parsed.result?.panes) ? parsed.result.panes : [];
  if (strict && !Array.isArray(parsed.result?.panes))
    throw new Error("Herdr did not return a complete pane inventory");
  return panes.flatMap((pane, index) => {
    try {
      return [snapshotOf(pane)];
    } catch (error) {
      if (strict) throw error;
      if (!(error instanceof HerdrAgentResponseError)) throw error;
      console.warn("Skipping malformed Herdr pane", {
        index,
        ...(isRecord(pane) && typeof pane.pane_id === "string" ? { paneId: pane.pane_id } : {}),
        ...(isRecord(pane) && typeof pane.terminal_id === "string" ? { terminalId: pane.terminal_id } : {}),
        code: error.code,
        detail: error.message,
      });
      return [];
    }
  });
}

function execHerdr(
  args: readonly string[],
  signal?: AbortSignal,
  timeoutMs = HERDR_COMMAND_TIMEOUT_MS,
  beforeDispatch?: () => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    beforeDispatch?.();
    execFile(
      "herdr",
      [...args],
      {
        maxBuffer: 1024 * 1024,
        ...(signal === undefined ? { timeout: timeoutMs } : { signal }),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (signal?.aborted === true) {
            reject(error);
            return;
          }
          reject(
            new Error(
              error.killed
                ? `Herdr ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs} ms`
                : String(stderr).trim() || error.message,
            ),
          );
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

/** Herdr's error codes for refusing `agent prompt` before it types anything. */
const HERDR_PROMPT_REFUSALS = new Set([
  "agent_blocked",
  "agent_not_ready",
  "agent_not_found",
  "blocked",
  "pane_not_found",
  "terminal_not_found",
]);

/**
 * Herdr's refusal of `agent prompt`, as a definite not-sent (ADR 0334). Only Herdr's own
 * error code counts, read from its JSON error or a remote fleet's parsed one: a timeout, or
 * a failure whose text is the command line (which carries the message), proves nothing
 * about whether the paste landed.
 */
function herdrPromptRefusal(error: unknown): HerdrFleetError | undefined {
  let code: string | undefined;
  if (error instanceof HerdrFleetError) code = error.code;
  else {
    const message = error instanceof Error ? error.message : String(error);
    // Node's own failure text is the command line, which holds the message's text.
    if (!message.startsWith("Command failed"))
      try {
        const value = JSON.parse(message.slice(message.indexOf("{"))) as { error?: { code?: unknown } };
        if (typeof value.error?.code === "string") code = value.error.code;
      } catch {
        // Not Herdr's JSON error: the outcome is unknown.
      }
  }
  return code !== undefined && HERDR_PROMPT_REFUSALS.has(code)
    ? new HerdrFleetError(code, "Herdr refused to type the message", "not_sent")
    : undefined;
}

function runExecFile(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ readonly status: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { maxBuffer: 1024 * 1024, timeout: HERDR_COMMAND_TIMEOUT_MS, ...(env ? { env } : {}) },
      (error, stdout, stderr) => {
        if (error !== null && error.code === "ENOENT") {
          reject(new Error(`${command}: command not found`));
          return;
        }
        resolve({
          status: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

export function createHerdrWatchRunner(
  available?: () => boolean,
  /** Where each Herdr call runs; a remote fleet passes its ssh transport (ADR 0184). */
  exec: (
    args: readonly string[],
    signal?: AbortSignal,
    timeoutMs?: number,
    beforeDispatch?: () => void,
  ) => Promise<string> = execHerdr,
  createCommandTab?: (input: OpenCodeCommandTab) => Promise<string>,
  observation: {
    readonly localCodexRecovery?: false;
    readonly localCodexRecordsPath?: string;
    readonly localCodexBinding?: () => Promise<{ socketPath: string; session: string } | undefined>;
    /** Current configured socket for local read-only roster/process observations. */
    readonly localReadBinding?: () => Promise<{ socketPath: string; session: string } | undefined>;
    readonly runLocalCommand?: HerdrCensusRunner;
    /** Session identity Herdr cannot hold (Prime Agent), for panes the host itself bound. */
    readonly boundSession?: (
      agent: HerdrAgentSnapshot,
    ) => { readonly harness: string; readonly session: HerdrAgentSession } | undefined;
  } = {},
): HerdrWatchRunner {
  const runHerdr = async (
    args: readonly string[],
    signal?: AbortSignal,
    timeoutMs?: number,
    beforeDispatch?: () => void,
  ): Promise<string> => {
    if (available?.() === false) throw new Error("Herdr execution is unavailable");
    if (observation.localReadBinding) {
      const binding = await observation.localReadBinding();
      if (binding === undefined) throw new Error("Herdr execution is unavailable");
      const read = nativeHerdrRead({ runtime: "external", ...binding }, args, {
        ...(signal ? { signal } : {}),
        timeoutMs: timeoutMs ?? HERDR_COMMAND_TIMEOUT_MS,
      });
      if (read !== undefined) return read;
    }
    beforeDispatch?.();
    return beforeDispatch ? exec(args, signal, timeoutMs, beforeDispatch) : exec(args, signal, timeoutMs);
  };
  /**
   * `herdr agent wait` (no `until` keeps its idle/done/blocked default). On the
   * configured local socket it is a Herdr event subscription inside this
   * process, not a subprocess per waiting seat (VUH-2391); elsewhere the CLI.
   */
  const waitHerdr = async (
    target: string,
    until: readonly string[] | undefined,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<string> => {
    if (available?.() === false) throw new Error("Herdr execution is unavailable");
    if (observation.localReadBinding) {
      const binding = await observation.localReadBinding();
      if (binding === undefined) throw new Error("Herdr execution is unavailable");
      return nativeAgentWait({ runtime: "external", ...binding }, target, until ?? [...SETTLED_STATUSES], {
        signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    }
    return exec(
      [
        "agent",
        "wait",
        target,
        ...(until ?? []).flatMap((status) => ["--until", status]),
        ...(timeoutMs === undefined ? [] : ["--timeout", String(timeoutMs)]),
      ],
      signal,
    );
  };
  const createTab = createHireLayout(runHerdr, createCommandTab);
  const recover = async (agent: HerdrAgentSnapshot): Promise<HerdrAgentSnapshot> => {
    const bound = agent.session === undefined ? observation.boundSession?.(agent) : undefined;
    if (bound !== undefined) return { ...agent, agent: bound.harness, session: bound.session };
    if (observation.localCodexRecovery === false || agent.agent !== "codex" || agent.session !== undefined)
      return agent;
    const binding = await observation.localCodexBinding?.();
    if (observation.localCodexBinding && binding === undefined) return agent;
    const session = await recoverLocalCodexSession(agent, {
      ...(binding === undefined ? {} : { bridgeSocket: binding.socketPath, herdrSession: binding.session }),
      ...(observation.localCodexRecordsPath === undefined
        ? {}
        : { localCodexRecordsPath: observation.localCodexRecordsPath }),
      runCommand: async (command, args) =>
        command === "herdr"
          ? { stdout: await runHerdr(args), stderr: "" }
          : observation.runLocalCommand
            ? observation.runLocalCommand(command, args)
            : runExecFile(command, args).then(({ stdout, stderr, status }) => {
                if (status !== 0) throw new Error("Local native observation unavailable");
                return { stdout, stderr };
              }),
    });
    return session === undefined ? agent : { ...agent, session };
  };
  return {
    list: async () => Promise.all(parseHerdrPaneList(await runHerdr(["pane", "list"]), true).map(recover)),
    get: async (target) => recover(parseHerdrAgentResult(await runHerdr(["agent", "get", target]))),
    renamePane: async (target, label) => {
      await runHerdr(["pane", "rename", target, label]);
    },
    resolveTerminal: async (terminalId) => {
      const agent = parseHerdrPaneList(await runHerdr(["pane", "list"])).find(
        (pane) => pane.terminalId === terminalId || pane.paneId === terminalId,
      );
      return agent === undefined ? undefined : recover(agent);
    },
    wait: async (target, signal) =>
      recover(parseHerdrAgentResult(await waitHerdr(target, undefined, signal))),
    waitUntilIdle: async (target, signal) =>
      recover(
        parseHerdrAgentResult(
          await waitHerdr(target, ["idle", "working", "done"], signal, SPAWN_CHANNEL_DIALOG_WAIT_MS),
        ),
      ),
    waitForChange: async (target, currentStatus, signal) =>
      recover(
        parseHerdrAgentResult(
          await waitHerdr(
            target,
            AGENT_STATUSES.filter((status) => status !== currentStatus),
            signal,
          ),
        ),
      ),
    transcript: async (agent) => {
      const processId =
        agent.agent === "grok" && agent.session === undefined
          ? parseHerdrForegroundProcessId(await runHerdr(["pane", "process-info", "--pane", agent.paneId]))
          : undefined;
      return readHerdrSeatTranscript(agent.agent, agent.session, processId);
    },
    read: (target, harness, source) =>
      runHerdr([
        "agent",
        "read",
        target,
        "--source",
        source,
        ...(source === "visible" ? [] : ["--lines", String(SEAT_REPLY_READ_LINES)]),
        ...(harness === "pi" ? ["--format", "ansi"] : []),
      ]),
    readPane: (target, source, format) =>
      runHerdr(["pane", "read", target, "--source", source, "--format", format]),
    sendKeys: async (paneId, keys) => {
      for (const run of herdrKeyRuns(keys))
        await runHerdr(
          "keys" in run
            ? ["pane", "send-keys", paneId, ...run.keys]
            : ["pane", "send-text", paneId, run.text],
        );
    },
    sendText: (paneId, text) => runHerdr(["pane", "send-text", paneId, text]).then(() => undefined),
    promptAgent: (paneId, text) =>
      runHerdr(["agent", "prompt", paneId, text]).then(
        () => undefined,
        (error: unknown) => {
          throw herdrPromptRefusal(error) ?? error;
        },
      ),
    paneProcesses: async (paneId) =>
      parseHerdrForegroundProcesses(await runHerdr(["pane", "process-info", "--pane", paneId])),
    paneShell: async (paneId) => {
      const stdout = await runHerdr(["pane", "process-info", "--pane", paneId]);
      const info = (
        JSON.parse(stdout) as { result?: { process_info?: { pane_id?: unknown; shell_pid?: unknown } } }
      ).result?.process_info;
      if (info?.pane_id !== paneId) throw new Error("Herdr process info did not identify the pane");
      return {
        ...(typeof info.shell_pid === "number" ? { shellPid: info.shell_pid } : {}),
        foreground: parseHerdrForegroundProcesses(stdout),
      };
    },
    openFiles: async (pid) => {
      const result = await runExecFile("lsof", ["-p", String(pid), "-Fn"]);
      if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `lsof -p ${String(pid)} failed`);
      }
      return result.stdout;
    },
    codexControl: codexProxyControl(),
    codexQueue: async (sessionId, text, codexHome, endpoint, beforeDispatch) =>
      (await codexProxyControl("codex", ["app-server", "proxy"], 5000, "queue")(
        sessionId,
        text,
        codexHome,
        endpoint,
        beforeDispatch,
      )) ?? {
        outcome: "undelivered",
        deliveryStage: "unavailable",
        detail: "Original Codex queue unavailable; nothing was sent.",
      },
    codexSettled: codexProxySettled,
    closePane: async (target, guard) => {
      await guard?.();
      await runHerdr(["pane", "close", target], undefined, undefined, guard?.assertCurrent);
    },
    runInPane: (paneId, argv) =>
      runHerdr(["pane", "run", paneId, argv.map(shellWord).join(" ")]).then(() => undefined),
    installPiIntegration: async () => {
      // herdr refuses a missing default extensions directory ("install pi
      // first"), which is exactly a fresh home such as a hosted body's.
      const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
      mkdirSync(join(agentDir, "extensions"), { recursive: true });
      await runHerdr(["integration", "install", "pi"]);
    },
    configurePiProvider: async (id, config) => {
      const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
      const path = join(agentDir, "models.json");
      const current: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        throw new Error("pi models.json is not an object");
      }
      const providers = (current as { providers?: unknown }).providers ?? {};
      if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
        throw new Error("pi models.json providers is not an object");
      }
      mkdirSync(agentDir, { recursive: true });
      const next = { ...current, providers: { ...providers, [id]: config } };
      const tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    },
    createTab,
    startAgent: ({ name, kind, paneId, args }) =>
      // Returns only once herdr has detected the harness and considers it ready
      // for input, so a resolved call means the seat can actually be messaged.
      runHerdr(
        [
          "agent",
          "start",
          name,
          "--kind",
          kind,
          "--pane",
          paneId,
          "--timeout",
          String(SPAWN_READY_WAIT_MS),
          ...(args === undefined || args.length === 0 ? [] : ["--", ...args]),
        ],
        undefined,
        // Let Herdr return its typed startup failure before the process watchdog fires.
        SPAWN_READY_WAIT_MS + HERDR_COMMAND_TIMEOUT_MS,
      ).then(() => undefined),
  };
}
