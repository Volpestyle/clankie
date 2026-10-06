import type { RemoteCodexRegistration } from "../remote-codex-seats.ts";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import type { Duplex } from "node:stream";
import { trustInstalledCodexWorkerHooks } from "./codex-hook-trust.ts";
import { isolatedCodexConfig } from "./codex-catalog-refresh.ts";
import type { SeatQuestion, SeatQuestionAnswer, SeatQuestionResult } from "@clankie/agent-hosts";
import { isDeepStrictEqual } from "node:util";
import {
  codexQuestion,
  codexAsyncQuestion,
  codexAsyncQuestionAnswer,
  codexAnsweredAsyncQuestionIds,
  recordedCodexAnswer,
  recordedCodexAsyncAnswer,
  SeatQuestionAnswerSchema,
  type CodexAsyncAnswerReceipt,
} from "./codex-user-input.ts";
import {
  codexToolCatalogReport,
  type CodexToolCatalogReport,
} from "../../../../integrations/claude-plugin/worker/bin/codex-tool-catalog.mjs";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : {};

function herdrStartupTimedOut(error: unknown): boolean {
  const text = String(error);
  try {
    const failure = record(record(JSON.parse(text.slice(text.indexOf("{")))).error);
    return failure.code === "timeout" && failure.message === "timed out waiting for agent startup";
  } catch {
    return false;
  }
}

export interface CodexSeatEvent {
  method: string;
  params: RecordValue;
  requestId?: string | number;
}

/** Reads from this exact native server; callers cannot dispatch through this facade. */
interface CodexNativeRead {
  request(
    method: "account/read" | "account/rateLimits/read" | "thread/list" | "config/read",
    params: RecordValue,
  ): Promise<unknown>;
}

/** Optional trusted controller policy. Never supplied by worker input or settings. */
export interface CodexNativePolicy {
  /** Complete trusted environment and final native permission overrides. */
  readonly launch?: {
    readonly environment: Readonly<Record<string, string>>;
    readonly socketRoot: string;
    readonly config: readonly string[];
  };
  /** Install independent monitoring before the interactive client can start a turn. */
  connected(read: CodexNativeRead): Promise<void>;
  bound?(input: { threadId: string; read: CodexNativeRead }): Promise<void>;
  beforeTurn(input: { threadId: string; read: CodexNativeRead }): Promise<void>;
  /** Synchronous final latch, after source guards and immediately before physical turn RPC. */
  dispatch?(input: { threadId: string; method: "turn/start" | "turn/steer"; turnId?: string }): void;
  /** Includes descendant events, before the seat's root-thread filtering. */
  audit(event: CodexSeatEvent): Promise<void>;
  /** Must revoke the exact enclosing execution boundary, including native TUI turns. */
  failed(error: unknown): Promise<void>;
}

/** One connection to one selected app-server; requests never select another server. */
export class CodexAppServerClient {
  private readonly socket: WebSocket;
  private readonly event: (event: CodexSeatEvent) => void;
  private readonly timeoutMs: number;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private failure?: Error;
  private readonly questions = new Map<
    string | number,
    {
      threadId: string;
      question: SeatQuestion;
      protocol: "serverRequest" | "asyncMessage";
      answering: boolean;
      resolved?: (error?: Error) => void;
    }
  >();
  private readonly retiredQuestions = new Set<string>();

  constructor(socket: WebSocket, event: (event: CodexSeatEvent) => void, timeoutMs = 30_000) {
    this.socket = socket;
    this.event = event;
    this.timeoutMs = timeoutMs;
    socket.on("message", (bytes) => {
      let message: RecordValue;
      try {
        message = record(JSON.parse(bytes.toString()));
      } catch {
        this.fail(new Error("Codex app-server sent invalid JSON"));
        return;
      }
      if (typeof message.method === "string") {
        // Approval requests are also delivered to the attached native TUI. Do
        // not approve them or manufacture answers on the owner's behalf.
        const params = record(message.params);
        if (message.method === "item/tool/requestUserInput") {
          const question = codexQuestion(message.id, params);
          if (question && !this.questions.has(question.requestId))
            this.questions.set(question.requestId, {
              threadId: String(params.threadId),
              question,
              protocol: "serverRequest",
              answering: false,
            });
        } else if (message.method === "serverRequest/resolved") {
          const id = params.requestId;
          if (typeof id === "string" || typeof id === "number") {
            const pending = this.questions.get(id);
            if (pending && pending.protocol === "serverRequest" && pending.threadId === params.threadId) {
              this.questions.delete(id);
              pending.resolved?.();
            }
          }
        } else if (message.method === "item/started" || message.method === "item/completed") {
          this.observeQuestionItem(params);
        }
        this.event({
          method: message.method,
          params,
          ...(typeof message.id === "string" || typeof message.id === "number"
            ? { requestId: message.id }
            : {}),
        });
        return;
      }
      const pending = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (!pending) return;
      this.pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.error !== undefined)
        pending.reject(
          new Error(`Codex app-server: ${String(record(message.error).message ?? "request failed")}`),
        );
      else pending.resolve(message.result);
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Codex app-server disconnected")));
  }

  async initialize(experimentalApi = false): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "clankie", title: "Clankie", version: "0.2.1" },
      ...(experimentalApi ? { capabilities: { experimentalApi: true } } : {}),
    });
    this.socket.send(JSON.stringify({ method: "initialized", params: {} }));
  }

  request(method: string, params: RecordValue, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Delivery is uncertain: callers must never retry through a terminal.
        reject(new Error(`Codex app-server ${method} timed out; delivery is uncertain`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) this.fail(error);
      });
    });
  }

  close(): void {
    this.fail(new Error("Codex app-server connection closed"));
    this.socket.close();
  }

  pendingQuestion(threadId: string, requestId: string | number): SeatQuestion | undefined {
    const pending = this.questions.get(requestId);
    return pending?.threadId === threadId ? pending.question : undefined;
  }

  hasPendingQuestion(threadId: string): boolean {
    return this.hasPendingBlockingQuestion(threadId);
  }

  hasPendingBlockingQuestion(threadId: string): boolean {
    return [...this.questions.values()].some(
      (pending) => pending.threadId === threadId && pending.question.isBlocking,
    );
  }

  isAsyncQuestion(threadId: string, requestId: string | number): boolean {
    const pending = this.questions.get(requestId);
    return pending?.threadId === threadId && pending.protocol === "asyncMessage";
  }

  /** Normal completion preserves async reply identity; interruption and failure revoke it. */
  retireTurn(threadId: string, turnId: string, status: "completed" | "interrupted" | "failed"): void {
    for (const [id, pending] of this.questions) {
      if (
        pending.threadId !== threadId ||
        pending.question.turnId !== turnId ||
        (!pending.question.isBlocking && status === "completed")
      )
        continue;
      if (pending.protocol === "asyncMessage") this.completeAsyncQuestion(threadId, id);
      else this.questions.delete(id);
      pending.resolved?.(new Error("native_question_turn_ended: no replacement answer was sent"));
    }
  }

  completeAsyncQuestion(threadId: string, requestId: string | number, notify = true): void {
    if (!this.isAsyncQuestion(threadId, requestId)) return;
    this.questions.delete(requestId);
    this.retiredQuestions.add(JSON.stringify([threadId, requestId]));
    if (this.retiredQuestions.size > 256)
      this.retiredQuestions.delete(this.retiredQuestions.values().next().value!);
    if (notify) this.event({ method: "clankie/question/resolved", params: { threadId, requestId } });
  }

  /** Reconcile persisted native items without replaying their input or answered questions. */
  hydrateQuestions(threadId: string, value: unknown): void {
    const thread = record(record(value).thread);
    if (thread.id !== threadId || !Array.isArray(thread.turns)) return;
    const before = new Map(
      [...this.questions]
        .filter(([, pending]) => pending.threadId === threadId)
        .map(([id, pending]) => [id, pending.question]),
    );
    const latestTurnId = record(thread.turns.at(-1)).id;
    for (const value of thread.turns) {
      const turn = record(value);
      if (typeof turn.id !== "string" || !Array.isArray(turn.items)) continue;
      // A cold subscription must not reopen old completed-turn prompts. Live
      // pending questions already in this client survive normal completion.
      const discoverQuestions = turn.status !== "completed" || turn.id === latestTurnId;
      for (const item of turn.items)
        this.observeQuestionItem({ threadId, turnId: turn.id, item }, false, discoverQuestions);
      if (turn.status === "interrupted" || turn.status === "failed")
        for (const [id, pending] of this.questions)
          if (
            pending.threadId === threadId &&
            pending.question.turnId === turn.id &&
            pending.protocol === "asyncMessage"
          )
            this.completeAsyncQuestion(threadId, id, false);
    }
    for (const [id] of before)
      if (!this.questions.has(id))
        this.event({ method: "clankie/question/resolved", params: { threadId, requestId: id } });
    for (const [id, pending] of this.questions)
      if (pending.threadId === threadId && !isDeepStrictEqual(before.get(id), pending.question))
        this.event({
          method: "clankie/question/updated",
          requestId: id,
          params: { threadId, ...pending.question },
        });
  }

  private observeQuestionItem(params: RecordValue, notify = true, discoverQuestions = true): void {
    const question = codexAsyncQuestion(params);
    if (
      question &&
      discoverQuestions &&
      !this.questions.has(question.requestId) &&
      !this.retiredQuestions.has(JSON.stringify([params.threadId, question.requestId]))
    )
      this.questions.set(question.requestId, {
        threadId: String(params.threadId),
        question,
        protocol: "asyncMessage",
        answering: false,
      });
    const answeredIds = codexAnsweredAsyncQuestionIds(params.item);
    if (answeredIds.length === 0) return;
    for (const [id, pending] of this.questions) {
      if (pending.threadId !== params.threadId || pending.protocol !== "asyncMessage") continue;
      const remaining = pending.question.questions.filter(
        (question) => !answeredIds.includes(question.id) && !answeredIds.includes(pending.question.itemId),
      );
      if (remaining.length === pending.question.questions.length) continue;
      if (remaining.length === 0) this.completeAsyncQuestion(pending.threadId, id, notify);
      else {
        pending.question = { ...pending.question, questions: remaining };
        if (notify)
          this.event({
            method: "clankie/question/updated",
            requestId: id,
            params: { threadId: pending.threadId, ...pending.question },
          });
      }
    }
  }

  async answerQuestion(
    threadId: string,
    answer: SeatQuestionAnswer,
    beforeDispatch?: () => Promise<void>,
    asyncDispatch?: (question: SeatQuestion) => Promise<CodexAsyncAnswerReceipt>,
  ): Promise<
    | { outcome: "resolved" }
    | ({ outcome: "dispatched" } & CodexAsyncAnswerReceipt)
    | Exclude<SeatQuestionResult, { outcome: "answered" }>
  > {
    const parsed = SeatQuestionAnswerSchema.safeParse(answer);
    if (!parsed.success) return { outcome: "refused", detail: "native_question_answer_invalid" };
    answer = parsed.data;
    const pending = this.questions.get(answer.requestId);
    if (!pending || pending.threadId !== threadId)
      return {
        outcome: "refused",
        detail: "native_question_already_resolved_or_unknown: no answer was sent",
      };
    if (pending.answering)
      return {
        outcome: "refused",
        detail: "native_question_answer_already_dispatched: no second answer was sent",
      };
    const ids = pending.question.questions.map((question) => question.id).sort();
    if (!isDeepStrictEqual(ids, Object.keys(answer.answers).sort()))
      return {
        outcome: "refused",
        detail: "native_question_answer_ids_mismatch: answer every question exactly once",
      };
    try {
      await beforeDispatch?.();
    } catch (error) {
      return { outcome: "refused", detail: String(error) };
    }
    if (this.failure) return { outcome: "offline", detail: this.failure.message };
    // Owner replies and concurrent lead replies may resolve it during the guard.
    if (
      this.questions.get(answer.requestId) !== pending ||
      pending.answering ||
      !isDeepStrictEqual(pending.question.questions.map((question) => question.id).sort(), ids)
    )
      return {
        outcome: "refused",
        detail: "native_question_already_resolved_or_answering: no answer was sent",
      };
    if (pending.protocol === "asyncMessage" && !asyncDispatch)
      return { outcome: "refused", detail: "native_async_question_input_transport_unavailable" };
    pending.answering = true;
    if (pending.protocol === "asyncMessage") {
      try {
        return { outcome: "dispatched", ...(await asyncDispatch!(pending.question)) };
      } catch (error) {
        // Ordinary native input has no server-request arbitration. An uncertain
        // dispatch keeps its latch even if the original turn ends meanwhile.
        return { outcome: "unconfirmed", detail: String(error) };
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        pending.resolved = (error) => (error ? reject(error) : resolve());
        timer = setTimeout(
          () => reject(new Error("native_question_resolution_unconfirmed: do not resend")),
          this.timeoutMs,
        );
        // This is the response to the server's request, not a new turn RPC.
        this.socket.send(
          JSON.stringify({ id: answer.requestId, result: { answers: answer.answers } }),
          (error) => {
            if (error) reject(error);
          },
        );
      });
      return { outcome: "resolved" };
    } catch (error) {
      return { outcome: "unconfirmed", detail: String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
    for (const question of this.questions.values()) question.resolved?.(error);
    this.questions.clear();
    this.event({ method: "connection/closed", params: { code: null } });
  }
}

export interface CodexAppServerSeat {
  threadId: string;
  transcriptPath?: string;
  /** Native TUI observes and can operate this exact server and thread. */
  viewArgs: readonly string[];
  send(
    message: string,
    guard?: () => Promise<void>,
  ): Promise<{ turnId: string; state: "started" | "steered" }>;
  /** Controller-owned catalog expectation; never an authorization credential. */
  expectTools?(names: readonly string[]): void;
  /** Observe this original thread after its bridge binding is in place. */
  checkTools?(): Promise<void>;
  answerQuestion?(
    answer: SeatQuestionAnswer,
    beforeDispatch?: () => Promise<void>,
  ): Promise<SeatQuestionResult>;
  interrupt(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * One dedicated app-server, wherever it runs. `endpoint` is what the native
 * TUI dials from its own machine; `connect` opens a protocol socket from this
 * one, and resolves undefined while the server is not listening yet.
 */
interface CodexServerConnection {
  readonly catalogSignalPath?: string;
  /** Local child identity; remote launchers must not expose a remote PID here. */
  readonly pid?: number;
  readonly remoteRegistration?: RemoteCodexRegistration;
  readonly waitForClankieCatalog?: true;
  readonly viewConfigArgs?: readonly string[];
  validateCatalog?(): Promise<void>;
  readonly endpoint: string;
  connect(): Promise<WebSocket | undefined>;
  /** Why the server is gone, once it is. */
  failure(): Error | undefined;
  /** Recent server output, for a startup error. */
  output(): string;
  close(): Promise<void>;
}

export type CodexServerLauncher = (input: {
  readonly catalogRefresh?: true;
  readonly cwd: string;
  /** `-c key=value` pairs, already flattened. */
  readonly configArgs: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly inheritEnvironment?: false;
  readonly socketRoot?: string;
  /** The server exited or its link dropped; `code` is the exit status when known. */
  readonly onExit: (code: number | null) => void;
}) => Promise<CodexServerConnection>;

/**
 * Unix transport is WebSocket over HTTP Upgrade (not JSONL). The private socket
 * avoids a shared daemon losing the pane identity (VUH-1398), and TCP exposure.
 */
const localCodexServer: CodexServerLauncher = async (input) => {
  if (input.socketRoot !== undefined) {
    for (let current = input.socketRoot; ; current = dirname(current)) {
      const ancestor = await lstat(current);
      if (!ancestor.isDirectory() || ancestor.isSymbolicLink())
        throw new Error("Codex socket root has symbolic ancestry");
      if (dirname(current) === current) break;
    }
    const stat = await lstat(input.socketRoot);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      (await realpath(input.socketRoot)) !== input.socketRoot
    )
      throw new Error("Codex socket root must be a canonical private controller directory");
  }
  const directory = await mkdtemp(join(input.socketRoot ?? tmpdir(), "clankie-codex-"));
  const socketPath = join(directory, "rpc.sock");
  const catalogSignalPath = join(directory, "catalog-changed");
  // The supervisor must not lend its own pane identity or Swarm enrollment to
  // the child. Explicit worker launch settings (including CODEX_HOME) survive.
  const env =
    input.inheritEnvironment === false
      ? {}
      : Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !/^(?:HERDR_|SWARM_|CLANKIE_SWARM_)/u.test(key)),
        );
  // `clankie restart` signals the service's whole process group. The native
  // TUI stays in Herdr, so its app-server must also outlive a service restart.
  // Redirect stderr to a file: a pipe back to the service would break on exit.
  const stderrPath = join(directory, "app-server.log");
  const stderrFd = openSync(stderrPath, "a", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(
      "codex",
      [
        ...input.configArgs,
        ...(input.catalogRefresh
          ? [
              "-c",
              `mcp_servers.clankie.env.CLANKIE_CODEX_CATALOG_SIGNAL=${JSON.stringify(catalogSignalPath)}`,
            ]
          : []),
        "app-server",
        "--listen",
        `unix://${socketPath}`,
      ],
      {
        cwd: input.cwd,
        env: { ...env, ...input.env },
        detached: true,
        stdio: ["ignore", "ignore", stderrFd],
      },
    );
    child.unref();
  } finally {
    closeSync(stderrFd);
  }
  let failure: Error | undefined;
  const output = () => {
    try {
      return readFileSync(stderrPath, "utf8").slice(-8_192);
    } catch {
      return "";
    }
  };
  child.on("error", (error) => {
    failure = error;
    input.onExit(null);
  });
  child.on("exit", (code) => {
    failure = new Error(`Codex app-server exited (${String(code)}): ${output()}`);
    input.onExit(code);
  });
  return {
    ...(input.catalogRefresh ? { catalogSignalPath } : {}),
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    endpoint: `unix://${socketPath}`,
    connect: () => openCodexSocket(`ws+unix://${socketPath}:/`),
    failure: () => failure,
    output,
    async close() {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill("SIGTERM");
        });
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** One attempt to open a protocol socket; undefined while nothing listens. */
export function openCodexSocket(address: string, stream?: Duplex): Promise<WebSocket | undefined> {
  return new Promise<WebSocket | undefined>((resolve) => {
    const attempt = new WebSocket(address, {
      handshakeTimeout: 1_000,
      ...(stream === undefined ? {} : { createConnection: () => stream }),
    });
    attempt.once("open", () => resolve(attempt));
    attempt.once("error", () => {
      attempt.terminate();
      resolve(undefined);
    });
  });
}

/** Protocol reference: https://developers.openai.com/codex/app-server */
export async function startCodexAppServerSeat(options: {
  /** Copied local worker home; no owner or remote config is rewritten. */
  catalogRefreshHome?: string;
  cwd: string;
  model?: string;
  effort?: string;
  /** Native TOML key=value overrides, applied to server and interactive client. */
  config?: readonly string[];
  resumeThreadId?: string;
  /** Operator seats may need time for native hook trust before thread creation. */
  threadStartTimeoutMs?: number;
  /** Report a pending native prompt and keep waiting on the same live server. */
  onThreadPending?: () => void;
  /** Server-owned local process identity, including while owner trust is pending. */
  onServerStarted?: (pid: number) => void;
  /** Drop any process binding on exit or explicit close (called at most once). */
  onServerStopped?: () => void;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string>>;
  /** Where the dedicated server runs; this machine unless a fleet supplies its own. */
  server?: CodexServerLauncher;
  /** How long the server may take to listen; a remote one starts over ssh. */
  listenTimeoutMs?: number;
  /** Start the native TUI on this server before sending any model input. */
  startView: (args: readonly string[]) => Promise<void>;
  onEvent?: (event: CodexSeatEvent) => void;
  /** Native startup evidence; report failure without taking away the pane's agency. */
  onCatalog?: (report: CodexToolCatalogReport) => Promise<void> | void;
  catalogBridge?: "worker" | "operator";
  policy?: CodexNativePolicy;
}): Promise<CodexAppServerSeat> {
  options.signal?.throwIfAborted();
  const launch = options.policy?.launch;
  const configArgs = [...(options.config ?? []), ...(launch?.config ?? [])].flatMap((value) => ["-c", value]);
  let client: CodexAppServerClient | undefined;
  let closed = false;
  let stopped = false;
  if (
    options.catalogRefreshHome &&
    options.catalogRefreshHome !==
      (launch === undefined ? options.env?.CODEX_HOME : launch.environment.CODEX_HOME)
  )
    throw new Error("Codex catalog refresh configuration must belong to this exact server");
  const catalogConfig = options.catalogRefreshHome
    ? await isolatedCodexConfig(options.catalogRefreshHome)
    : undefined;
  const stoppedServer = () => {
    if (stopped) return;
    stopped = true;
    options.onServerStopped?.();
  };
  const server = await (options.server ?? localCodexServer)({
    ...(catalogConfig === undefined ? {} : { catalogRefresh: true as const }),
    cwd: options.cwd,
    configArgs,
    ...(launch === undefined
      ? options.env === undefined
        ? {}
        : { env: options.env }
      : {
          env: { ...launch.environment },
          inheritEnvironment: false as const,
          socketRoot: launch.socketRoot,
        }),
    onExit: (code) => {
      stoppedServer();
      client?.close();
      options.onEvent?.({ method: "connection/closed", params: { code } });
    },
  });
  const endpoint = server.endpoint;
  const close = async () => {
    if (closed) return;
    closed = true;
    client?.close();
    try {
      await server.close();
    } finally {
      stoppedServer();
    }
  };
  let policyFailure: unknown;
  let policyFailed = false;
  let stopping: Promise<void> | undefined;
  let auditTail: Promise<void> = Promise.resolve();
  const failPolicy = (error: unknown): Promise<void> => {
    if (stopping) return stopping;
    policyFailed = true;
    policyFailure = error;
    // Observe every rejection and retain stop failures for the next operation/close.
    stopping = (async () => {
      try {
        await options.policy?.failed(error);
      } catch (stopError) {
        policyFailure = new AggregateError([error, stopError], "Native policy containment failed");
      } finally {
        await close();
      }
    })().catch((closeError: unknown) => {
      policyFailure = new AggregateError([policyFailure, closeError], "Native policy close failed");
    });
    return stopping;
  };
  const checkPolicy = async () => {
    await auditTail;
    if (stopping) await stopping;
    if (policyFailed) throw policyFailure;
    if (closed) throw new Error("Codex native seat is closed");
  };
  try {
    if (server.pid !== undefined && !stopped) options.onServerStarted?.(server.pid);
    const deadline = Date.now() + (options.listenTimeoutMs ?? 15_000);
    let socket: WebSocket | undefined;
    while (!socket) {
      options.signal?.throwIfAborted();
      const failure = server.failure();
      if (failure) throw failure;
      if (Date.now() >= deadline)
        throw new Error(`Codex app-server did not open its socket: ${server.output()}`);
      socket = await server.connect();
      if (!socket) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let activeTurn: string | undefined;
    let turnObservation = 0;
    let threadId: string | undefined;
    let turnRevision = 0;
    const turnChanges = new Set<() => void>();
    const changedTurn = () => {
      turnRevision += 1;
      for (const resolve of turnChanges) resolve();
      turnChanges.clear();
    };
    const terminalTurns = new Map<string, CodexSeatEvent>();
    let idleReconciliation: Promise<void> = Promise.resolve();
    const reconcileIdle = () => {
      const expected = activeTurn;
      const revision = turnRevision;
      if (!expected) return;
      idleReconciliation = idleReconciliation
        .catch(() => undefined)
        .then(async () => {
          if (closed || activeTurn !== expected || turnRevision !== revision) return;
          // An idle notification has no turn ID. A native snapshot must prove the
          // exact terminal turn before it can release dispatch or blocking input.
          const response = record(await client!.request("thread/read", { threadId, includeTurns: true }));
          const thread = record(response.thread);
          const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
          const turn = turns.at(-1);
          if (
            closed ||
            thread.id !== threadId ||
            activeTurn !== expected ||
            turnRevision !== revision ||
            turn?.id !== expected ||
            !["completed", "interrupted", "failed"].includes(String(turn.status)) ||
            turns.some((candidate) => candidate.status === "inProgress")
          )
            return;
          client!.hydrateQuestions(threadId!, response);
          observe({ method: "turn/completed", params: { threadId, turn } });
        });
      // A missing snapshot supplies no completion proof and never causes replay.
      void idleReconciliation.catch(() => undefined);
    };
    const observe = (event: CodexSeatEvent) => {
      if (options.policy && !closed && !policyFailed) {
        auditTail = auditTail
          .then(async () => {
            if (!policyFailed) await options.policy!.audit(event);
          })
          .catch(failPolicy);
      }
      if (event.params.threadId === threadId) {
        const turn = record(event.params.turn);
        if (event.method === "turn/started" || event.method === "turn/completed") turnObservation++;
        if (event.method === "turn/started" && typeof turn.id === "string" && !terminalTurns.has(turn.id)) {
          activeTurn = turn.id;
          changedTurn();
        }
        if (
          event.method === "turn/completed" &&
          typeof turn.id === "string" &&
          ["completed", "interrupted", "failed"].includes(String(turn.status))
        ) {
          terminalTurns.set(turn.id, event);
          if (terminalTurns.size > 64) terminalTurns.delete(terminalTurns.keys().next().value!);
          if (turn.id === activeTurn) {
            activeTurn = undefined;
            changedTurn();
            client?.retireTurn(threadId!, turn.id, turn.status as "completed" | "interrupted" | "failed");
          }
        }
        if (event.method === "thread/status/changed" && record(event.params.status).type === "idle")
          reconcileIdle();
      }
      const eventThread =
        typeof event.params.threadId === "string"
          ? event.params.threadId
          : typeof record(event.params.thread).id === "string"
            ? String(record(event.params.thread).id)
            : undefined;
      if (eventThread) server.remoteRegistration?.observeThread(eventThread);
      options.onEvent?.(event);
    };
    client = new CodexAppServerClient(socket, observe);
    await client.initialize(true);
    // The durable local seat coordinator owns catalog signals, including after
    // this service heap dies. A second per-launch watcher must never race it.
    const read: CodexNativeRead = {
      request(method, params) {
        if (!["account/read", "account/rateLimits/read", "thread/list", "config/read"].includes(method))
          return Promise.reject(new Error("Native policy RPC is not read-only"));
        if (
          method === "config/read" &&
          (params.includeLayers !== true ||
            typeof params.cwd !== "string" ||
            Object.keys(params).some((key) => key !== "cwd" && key !== "includeLayers"))
        )
          throw new Error("Native config provenance requires an explicit cwd and complete layers");
        if (method === "account/read" && params.refreshToken !== false)
          return Promise.reject(new Error("Native policy cannot refresh authentication"));
        if (closed || policyFailed) return Promise.reject(new Error("Native policy connection is closed"));
        return client!.request(method, params);
      },
    };
    if (options.policy) {
      try {
        await options.policy.connected(read);
        await checkPolicy();
      } catch (error) {
        await failPolicy(error);
        throw policyFailure;
      }
    }
    if (options.catalogRefreshHome) {
      await trustInstalledCodexWorkerHooks({
        home: options.catalogRefreshHome,
        cwd: options.cwd,
        request: (method, params) => client!.request(method, params),
      });
    }
    const viewArgs = [
      ...configArgs,
      ...(server.viewConfigArgs ?? []),
      "--remote",
      endpoint,
      ...(options.model ? ["--model", options.model] : []),
      ...(options.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []),
      ...(options.resumeThreadId ? ["resume", options.resumeThreadId] : []),
    ];
    // An empty app-server-created thread has no rollout, so `codex resume`
    // cannot bootstrap it. Let the real TUI create its own thread. Only one
    // native root can exist before we send the first brief.
    options.signal?.throwIfAborted();
    try {
      await options.startView(viewArgs);
    } catch (error) {
      // Herdr keeps a launched native agent alive when a startup dialog blocks it.
      // Only that typed result establishes a live view; other launch errors fail.
      // Herdr's bounded readiness wait may expire while a large saved thread
      // restores. The timeout does not mean the native process failed: keep its
      // dedicated server and prove the exact loaded thread below. Closing it
      // here strands the TUI in an automatic reconnect loop.
      if (
        !options.onThreadPending ||
        (!/agent_not_ready|trust_required/u.test(String(error)) &&
          !(options.resumeThreadId && herdrStartupTimedOut(error)))
      )
        throw error;
    }
    const threadDeadline = Date.now() + (options.threadStartTimeoutMs ?? 15_000);
    let pendingReported = false;
    while (!threadId) {
      options.signal?.throwIfAborted();
      let loaded: RecordValue;
      try {
        loaded = record(await client.request("thread/loaded/list", {}, 2_000));
      } catch (error) {
        // This is a read-only query. A busy restore may delay it, and repeating
        // the observation cannot duplicate a brief or start a second writer.
        if (!options.resumeThreadId || !String(error).includes("thread/loaded/list timed out;")) throw error;
        if (!pendingReported && Date.now() >= threadDeadline) {
          if (!options.onThreadPending) throw new Error("Codex TUI did not restore its thread");
          pendingReported = true;
          options.onThreadPending();
        }
        options.signal?.throwIfAborted();
        const failure = server.failure();
        if (failure) throw failure;
        continue;
      }
      const ids = Array.isArray(loaded.data) ? loaded.data : [];
      if (ids.length > 1 || loaded.nextCursor != null)
        throw new Error("Codex seat has more than one initial native thread");
      if (typeof ids[0] === "string") {
        if (options.resumeThreadId && ids[0] !== options.resumeThreadId)
          throw new Error("Codex TUI resumed a different thread");
        threadId = ids[0];
      } else {
        if (!pendingReported && Date.now() >= threadDeadline) {
          if (!options.onThreadPending) throw new Error("Codex TUI did not create its thread");
          pendingReported = true;
          options.onThreadPending();
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    options.signal?.throwIfAborted();
    const result = record(await client.request("thread/read", { threadId, includeTurns: false }));
    const thread = record(result.thread);
    if (typeof thread.id !== "string") throw new Error("Codex app-server returned no thread identity");
    if (thread.id !== threadId) throw new Error("Native thread/read identity changed");
    client.hydrateQuestions(threadId, result);
    server.remoteRegistration?.bindThread(threadId, async () => {
      if (closed || stopped || server.failure()) return false;
      const loaded = record(await client!.request("thread/loaded/list", {}, 2_000));
      return (
        Array.isArray(loaded.data) &&
        loaded.data.length === 1 &&
        loaded.data[0] === threadId &&
        loaded.nextCursor == null
      );
    });
    if (options.policy?.bound) {
      try {
        await options.policy.bound({ threadId, read });
        await checkPolicy();
      } catch (error) {
        await failPolicy(error);
        throw policyFailure;
      }
    }
    let subscribed = false;
    let metadataOnly = true;
    const historyUnsupported = (error: unknown) =>
      /unknown field.*excludeTurns|excludeTurns.*(?:experimentalApi|unsupported)|thread\/turns\/list.*(?:unknown|unsupported)|unknown (?:method|variant).*thread\/turns\/list|method not found/iu.test(
        String(error),
      );
    const subscribe = async (waitForRollout = true) => {
      if (subscribed) return;
      // The TUI owns the initial subscription. Its new thread becomes
      // resumable once the first turn persists; resume adds this client
      // as an observer without replaying input. Hydrate the last turn in
      // case it completed before the subscription was established.
      const deadline = Date.now() + 5_000;
      const observedBefore = turnObservation;
      let resumed: RecordValue;
      for (;;) {
        try {
          resumed = record(
            await client!.request(
              "thread/resume",
              { threadId, ...(metadataOnly ? { excludeTurns: true } : {}) },
              options.resumeThreadId ? 120_000 : 30_000,
            ),
          );
          break;
        } catch (error) {
          // A rejected subscription never replays model input.
          if (metadataOnly && historyUnsupported(error)) {
            metadataOnly = false;
            continue;
          }
          // Codex reports a not-yet-persisted rollout as either "no rollout
          // found" or, since 0.159, a present-but-empty rollout file.
          if (!/no rollout found|rollout at .* is empty/u.test(String(error))) throw error;
          if (!waitForRollout) return;
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      const resumedThread = record(resumed.thread);
      if (resumedThread.id !== threadId) throw new Error("Native thread/resume identity changed");
      client!.hydrateQuestions(threadId!, resumed);
      subscribed = true;
      let turn: RecordValue;
      if (metadataOnly) {
        try {
          // Load only the newest turn, retaining its native question and answer items
          // without reconstructing or transmitting a whole large rollout.
          const latest = record(
            await client!.request("thread/turns/list", {
              threadId,
              limit: 1,
              sortDirection: "desc",
              itemsView: "full",
            }),
          );
          turn = Array.isArray(latest.data) ? record(latest.data[0]) : {};
        } catch (error) {
          if (!historyUnsupported(error)) throw error;
          metadataOnly = false;
          const legacy = record(
            await client!.request("thread/resume", { threadId }, options.resumeThreadId ? 120_000 : 30_000),
          );
          const turns = record(legacy.thread).turns;
          turn = Array.isArray(turns) ? record(turns.at(-1)) : {};
        }
      } else {
        const turns = record(resumed.thread).turns;
        turn = Array.isArray(turns) ? record(turns.at(-1)) : {};
      }
      if (turnObservation === observedBefore && typeof turn.id === "string") {
        client!.hydrateQuestions(threadId!, { thread: { id: threadId, turns: [turn] } });
        observe({
          method: turn.status === "inProgress" ? "turn/started" : "turn/completed",
          params: { threadId, turn },
        });
      }
    };
    if (options.resumeThreadId) await subscribe();
    let catalogReady = !server.waitForClankieCatalog;
    let expectedTools: readonly string[] = ["message_clankie"];
    const checkTools = async () => {
      if (!options.onCatalog) return;
      const deadline = Date.now() + 20_000;
      let report: CodexToolCatalogReport;
      do {
        report = await codexToolCatalogReport({
          sessionId: threadId!,
          bridge: options.catalogBridge ?? "worker",
          request: (method, params) =>
            client!.request(method, params, Math.max(1, Math.min(2_000, deadline - Date.now()))),
        });
        if (closed || stopped || options.signal?.aborted) return;
        if (
          !report.error &&
          report.tools.length > 0 &&
          (options.catalogBridge === "operator" || expectedTools.every((name) => report.tools.includes(name)))
        )
          break;
        if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < deadline);
      try {
        await options.onCatalog(report);
      } catch (error) {
        console.warn("Codex native catalog report failed:", threadId, String(error));
      }
    };
    const waitForCatalog = async () => {
      if (catalogReady) return;
      await server.validateCatalog?.();
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        if (closed || stopped || server.failure())
          throw new Error("Private Codex server disconnected before catalog readiness");
        try {
          const status = record(
            await client!.request(
              "mcpServerStatus/list",
              { threadId, serverName: "clankie", detail: "toolsAndAuthOnly" },
              Math.min(2_000, deadline - Date.now()),
            ),
          );
          const rows = Array.isArray(status.data) ? status.data.map(record) : [];
          const matches = rows.filter((row) => row.name === "clankie");
          if (
            status.nextCursor == null &&
            matches.length === 1 &&
            matches[0]!.runtimeStatus === "connected" &&
            matches[0]!.toolsError == null &&
            expectedTools.every((name) => Object.hasOwn(record(matches[0]!.tools), name))
          ) {
            catalogReady = true;
            return;
          }
        } catch {
          /* Read-only readiness checks can be retried within this deadline. */
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))),
        );
      }
      throw new Error("Private Codex Clankie catalog was not ready; no first turn was sent");
    };
    let firstDispatch = true;
    let sending: Promise<unknown> = Promise.resolve();
    const sendNative = (
      message: string,
      guard?: () => Promise<void>,
      answer?: { requestId: string | number; clientUserMessageId: string },
    ) => {
      const send = async () => {
        await waitForCatalog();
        // The owner may have started a native turn before the first delivery.
        // Subscribe first when its rollout exists so we steer that turn.
        await subscribe(false);
        const input = [{ type: "text", text: message, text_elements: [] }];
        // Serialize dispatch so simultaneous messages cannot start two turns.
        // A failed steer is not retried: only the server knows if it applied.
        await checkPolicy();
        if (options.policy) {
          try {
            await options.policy.beforeTurn({ threadId: threadId!, read });
          } catch (error) {
            await failPolicy(error);
            throw policyFailure;
          }
          await checkPolicy();
        }
        // Recheck the installed contract after every startup/catalog await.
        if (firstDispatch) await server.validateCatalog?.();
        // Initial brief authority expires independently of later follow-up turns.
        if (activeTurn !== undefined) {
          let release!: () => void;
          const changed = new Promise<void>((resolve) => {
            release = resolve;
            turnChanges.add(resolve);
          });
          try {
            // Matching terminal proof releases a send immediately, even if
            // an earlier idle snapshot is still waiting on its read reply.
            await Promise.race([idleReconciliation.catch(() => undefined), changed]);
          } finally {
            turnChanges.delete(release);
          }
        }
        await guard?.();
        if (
          (answer === undefined && client!.hasPendingQuestion(threadId!)) ||
          (answer !== undefined &&
            (!client!.isAsyncQuestion(threadId!, answer.requestId) ||
              client!.hasPendingBlockingQuestion(threadId!)))
        )
          throw new Error(
            "Codex has a pending native question; answer its request instead of sending a new turn.",
          );
        const steering = activeTurn;
        const dispatchRevision = turnRevision;
        try {
          const result: unknown = options.policy?.dispatch?.({
            threadId: threadId!,
            method: steering ? "turn/steer" : "turn/start",
            ...(steering ? { turnId: steering } : {}),
          });
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => {});
            throw new Error("Native dispatch policy must be synchronous");
          }
        } catch (error) {
          await failPolicy(error);
          throw policyFailure;
        }
        const response = record(
          await client!.request(steering ? "turn/steer" : "turn/start", {
            threadId,
            input,
            ...(steering ? { expectedTurnId: steering } : {}),
            ...(answer === undefined ? {} : { clientUserMessageId: answer.clientUserMessageId }),
          }),
        );
        const turnId = steering ? response.turnId : record(response.turn).id;
        firstDispatch = false;
        if (typeof turnId !== "string")
          throw new Error("Codex did not confirm the turn identity; delivery is uncertain");
        if (!steering && turnRevision === dispatchRevision) {
          // The RPC itself is authentic turn identity, including when a
          // subscription did not deliver its started notification.
          observe({ method: "turn/started", params: { threadId, turn: { id: turnId } } });
          const terminal = terminalTurns.get(turnId);
          if (terminal) {
            activeTurn = turnId;
            observe(terminal);
          }
        }
        await subscribe();
        return { turnId, state: steering ? ("steered" as const) : ("started" as const) };
      };
      const next = sending.then(send);
      sending = next.catch(() => undefined);
      return next;
    };
    return {
      checkTools,
      async answerQuestion(answer, guard) {
        const parsed = SeatQuestionAnswerSchema.safeParse(answer);
        if (!parsed.success) return { outcome: "refused", detail: "native_question_answer_invalid" };
        answer = parsed.data;
        const request = client!.pendingQuestion(threadId!, answer.requestId);
        if (!request)
          return {
            outcome: "refused",
            detail: "native_question_already_resolved_or_unknown: no answer was sent",
          };
        const result = await client!.answerQuestion(
          threadId!,
          answer,
          async () => {
            await checkPolicy();
            await guard?.();
          },
          async (question) => {
            const text = codexAsyncQuestionAnswer(question, answer);
            const clientUserMessageId = randomUUID();
            const sent = await sendNative(
              text,
              async () => {
                await guard?.();
                const current = client!.pendingQuestion(threadId!, answer.requestId);
                if (
                  !current ||
                  !isDeepStrictEqual(
                    current.questions.map((question) => question.id),
                    question.questions.map((question) => question.id),
                  )
                )
                  throw new Error("native_async_question_already_answered: no replacement input was sent");
              },
              { requestId: answer.requestId, clientUserMessageId },
            );
            return { text, clientUserMessageId, turnId: sent.turnId };
          },
        );
        if (result.outcome === "dispatched") {
          // Async questions return immediately. Confirm our attributed native
          // input, rather than treating the tool's accepted:true as an answer.
          const deadline = Date.now() + 2_000;
          while (!closed && Date.now() < deadline) {
            const record = await client!
              .request("thread/read", { threadId, includeTurns: true }, Math.max(1, deadline - Date.now()))
              .catch(() => undefined);
            const confirmation = recordedCodexAsyncAnswer(record, threadId!, result);
            if (confirmation !== "unobserved") {
              client!.completeAsyncQuestion(threadId!, answer.requestId);
              if (confirmation === "answered_concurrently_by_owner")
                return { outcome: "unconfirmed", detail: "answered_concurrently_by_owner" };
              return { outcome: "answered", deliveryStage: "responded" };
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return {
            outcome: "unconfirmed",
            detail: "native_async_answer_input_unobserved: do not resend or queue a replacement",
          };
        }
        if (result.outcome !== "resolved") return result;
        // Resolution alone does not identify which client won. Check Codex's
        // persisted tool output before calling our requested answer accepted.
        const deadline = Date.now() + 2_000;
        while (!closed && Date.now() < deadline) {
          const record = await client!
            .request("thread/read", { threadId, includeTurns: true }, Math.max(1, deadline - Date.now()))
            .catch(() => undefined);
          const accepted = recordedCodexAnswer(record, request, threadId!);
          if (accepted !== undefined)
            return isDeepStrictEqual(accepted, answer.answers)
              ? { outcome: "answered", deliveryStage: "responded" }
              : {
                  outcome: "refused",
                  detail: "native_question_resolved_with_different_answer: the first native answer won",
                };
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          outcome: "unconfirmed",
          detail:
            "native_question_resolved_but_winning_answer_unobserved: do not resend or queue a replacement",
        };
      },
      expectTools(names) {
        expectedTools = [...new Set(["message_clankie", ...names])];
        catalogReady = !server.waitForClankieCatalog;
      },
      threadId,
      ...(typeof thread.path === "string" ? { transcriptPath: thread.path } : {}),
      viewArgs,
      send(message, guard) {
        return sendNative(message, guard);
      },
      async interrupt() {
        if (!activeTurn) return false;
        await client!.request("turn/interrupt", { threadId, turnId: activeTurn });
        return true;
      },
      async close() {
        await close();
        await auditTail;
        if (stopping) await stopping;
        if (policyFailed) throw policyFailure;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
