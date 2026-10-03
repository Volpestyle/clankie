import type { RemoteCodexRegistration } from "../remote-codex-seats.ts";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import WebSocket from "ws";
import type { Duplex } from "node:stream";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : {};

export interface CodexSeatEvent {
  method: string;
  params: RecordValue;
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
        this.event({ method: message.method, params: record(message.params) });
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

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "clankie", title: "Clankie", version: "0.2.1" } });
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

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
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
  interrupt(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * One dedicated app-server, wherever it runs. `endpoint` is what the native
 * TUI dials from its own machine; `connect` opens a protocol socket from this
 * one, and resolves undefined while the server is not listening yet.
 */
interface CodexServerConnection {
  /** Local child identity; remote launchers must not expose a remote PID here. */
  readonly pid?: number;
  readonly remoteRegistration?: RemoteCodexRegistration;
  readonly waitForClankieCatalog?: true;
  readonly endpoint: string;
  connect(): Promise<WebSocket | undefined>;
  /** Why the server is gone, once it is. */
  failure(): Error | undefined;
  /** Recent server output, for a startup error. */
  output(): string;
  close(): Promise<void>;
}

export type CodexServerLauncher = (input: {
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
    child = spawn("codex", [...input.configArgs, "app-server", "--listen", `unix://${socketPath}`], {
      cwd: input.cwd,
      env: { ...env, ...input.env },
      detached: true,
      stdio: ["ignore", "ignore", stderrFd],
    });
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
  policy?: CodexNativePolicy;
}): Promise<CodexAppServerSeat> {
  options.signal?.throwIfAborted();
  const launch = options.policy?.launch;
  const configArgs = [...(options.config ?? []), ...(launch?.config ?? [])].flatMap((value) => ["-c", value]);
  let client: CodexAppServerClient | undefined;
  let closed = false;
  let stopped = false;
  const stoppedServer = () => {
    if (stopped) return;
    stopped = true;
    options.onServerStopped?.();
  };
  const server = await (options.server ?? localCodexServer)({
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
    let threadId: string | undefined;
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
        if (event.method === "turn/started" && typeof turn.id === "string") activeTurn = turn.id;
        if (event.method === "turn/completed" && turn.id === activeTurn) activeTurn = undefined;
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
    await client.initialize();
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
    const viewArgs = [
      ...configArgs,
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
      if (!options.onThreadPending || !/agent_not_ready/u.test(String(error))) throw error;
    }
    const threadDeadline = Date.now() + (options.threadStartTimeoutMs ?? 15_000);
    let pendingReported = false;
    while (!threadId) {
      options.signal?.throwIfAborted();
      const loaded = record(await client.request("thread/loaded/list", {}));
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
    const subscribe = async (waitForRollout = true) => {
      if (subscribed) return;
      // The TUI owns the initial subscription. Its new thread becomes
      // resumable once the first turn persists; resume adds this client
      // as an observer without replaying input. Hydrate the last turn in
      // case it completed before the subscription was established.
      const deadline = Date.now() + 5_000;
      let resumed: RecordValue;
      for (;;) {
        try {
          resumed = record(await client!.request("thread/resume", { threadId }));
          break;
        } catch (error) {
          // Codex reports a not-yet-persisted rollout as either "no rollout
          // found" or, since 0.159, a present-but-empty rollout file.
          if (!/no rollout found|rollout at .* is empty/u.test(String(error))) throw error;
          if (!waitForRollout) return;
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      subscribed = true;
      const turns = record(resumed.thread).turns;
      const turn = Array.isArray(turns) ? record(turns.at(-1)) : {};
      if (typeof turn.id === "string")
        observe({
          method: turn.status === "inProgress" ? "turn/started" : "turn/completed",
          params: { threadId, turn },
        });
    };
    if (options.resumeThreadId) await subscribe();
    let catalogReady = !server.waitForClankieCatalog;
    let expectedTools: readonly string[] = ["message_clankie"];
    const waitForCatalog = async () => {
      if (catalogReady) return;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        if (closed || stopped || server.failure())
          throw new Error("Private Codex server disconnected before catalog readiness");
        try {
          const status = record(
            await client!.request(
              "mcpServerStatus/list",
              { threadId, detail: "toolsAndAuthOnly" },
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
    let sending: Promise<unknown> = Promise.resolve();
    return {
      expectTools(names) {
        expectedTools = [...new Set(["message_clankie", ...names])];
        catalogReady = !server.waitForClankieCatalog;
      },
      threadId,
      ...(typeof thread.path === "string" ? { transcriptPath: thread.path } : {}),
      viewArgs,
      send(message, guard) {
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
          // Initial brief authority expires independently of later follow-up turns.
          await guard?.();
          const steering = activeTurn;
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
            }),
          );
          const turnId = steering ? response.turnId : record(response.turn).id;
          if (typeof turnId !== "string")
            throw new Error("Codex did not confirm the turn identity; delivery is uncertain");
          await subscribe();
          return { turnId, state: steering ? ("steered" as const) : ("started" as const) };
        };
        const next = sending.then(send);
        sending = next.catch(() => undefined);
        return next;
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
