import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : {};

export interface CodexSeatEvent {
  method: string;
  params: RecordValue;
}

/** One connection to one owned app-server, never the shared Codex daemon. */
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

  request(method: string, params: RecordValue): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Delivery is uncertain: callers must never retry through a terminal.
        reject(new Error(`Codex app-server ${method} timed out; delivery is uncertain`));
      }, this.timeoutMs);
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
  send(message: string): Promise<{ turnId: string; state: "started" | "steered" }>;
  interrupt(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * One dedicated app-server, wherever it runs. `endpoint` is what the native
 * TUI dials from its own machine; `connect` opens a protocol socket from this
 * one, and resolves undefined while the server is not listening yet.
 */
interface CodexServerConnection {
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
  /** The server exited or its link dropped; `code` is the exit status when known. */
  readonly onExit: (code: number | null) => void;
}) => Promise<CodexServerConnection>;

/**
 * Unix transport is WebSocket over HTTP Upgrade (not JSONL). The private socket
 * avoids a shared daemon losing the pane identity (VUH-1398), and TCP exposure.
 */
const localCodexServer: CodexServerLauncher = async (input) => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-codex-"));
  const socketPath = join(directory, "rpc.sock");
  // The supervisor must not lend its own pane identity or Swarm enrollment to
  // the child. Explicit worker launch settings (including CODEX_HOME) survive.
  const env = Object.fromEntries(
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
export function openCodexSocket(address: string): Promise<WebSocket | undefined> {
  return new Promise<WebSocket | undefined>((resolve) => {
    const attempt = new WebSocket(address, { handshakeTimeout: 1_000 });
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
  signal?: AbortSignal;
  env?: Readonly<Record<string, string>>;
  /** Where the dedicated server runs; this machine unless a fleet supplies its own. */
  server?: CodexServerLauncher;
  /** How long the server may take to listen; a remote one starts over ssh. */
  listenTimeoutMs?: number;
  /** Start the native TUI on this server before sending any model input. */
  startView: (args: readonly string[]) => Promise<void>;
  onEvent?: (event: CodexSeatEvent) => void;
}): Promise<CodexAppServerSeat> {
  options.signal?.throwIfAborted();
  const configArgs = (options.config ?? []).flatMap((value) => ["-c", value]);
  let client: CodexAppServerClient | undefined;
  let closed = false;
  const server = await (options.server ?? localCodexServer)({
    cwd: options.cwd,
    configArgs,
    ...(options.env === undefined ? {} : { env: options.env }),
    onExit: (code) => {
      client?.close();
      options.onEvent?.({ method: "connection/closed", params: { code } });
    },
  });
  const endpoint = server.endpoint;
  const close = async () => {
    if (closed) return;
    closed = true;
    client?.close();
    await server.close();
  };
  try {
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
      if (event.params.threadId === threadId) {
        const turn = record(event.params.turn);
        if (event.method === "turn/started" && typeof turn.id === "string") activeTurn = turn.id;
        if (event.method === "turn/completed" && turn.id === activeTurn) activeTurn = undefined;
      }
      options.onEvent?.(event);
    };
    client = new CodexAppServerClient(socket, observe);
    await client.initialize();
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
    await options.startView(viewArgs);
    const threadDeadline = Date.now() + (options.threadStartTimeoutMs ?? 15_000);
    while (!threadId) {
      options.signal?.throwIfAborted();
      const loaded = record(await client.request("thread/loaded/list", {}));
      const ids = Array.isArray(loaded.data) ? loaded.data : [];
      if (ids.length > 1) throw new Error("Codex seat has more than one initial native thread");
      if (typeof ids[0] === "string") {
        if (options.resumeThreadId && ids[0] !== options.resumeThreadId)
          throw new Error("Codex TUI resumed a different thread");
        threadId = ids[0];
      } else {
        if (Date.now() >= threadDeadline) throw new Error("Codex TUI did not create its thread");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    options.signal?.throwIfAborted();
    const result = record(await client.request("thread/read", { threadId, includeTurns: false }));
    const thread = record(result.thread);
    if (typeof thread.id !== "string") throw new Error("Codex app-server returned no thread identity");
    threadId = thread.id;
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
    let sending: Promise<unknown> = Promise.resolve();
    return {
      threadId,
      ...(typeof thread.path === "string" ? { transcriptPath: thread.path } : {}),
      viewArgs,
      send(message) {
        const send = async () => {
          // The owner may have started a native turn before the first delivery.
          // Subscribe first when its rollout exists so we steer that turn.
          await subscribe(false);
          const input = [{ type: "text", text: message, text_elements: [] }];
          // Serialize dispatch so simultaneous messages cannot start two turns.
          // A failed steer is not retried: only the server knows if it applied.
          const steering = activeTurn;
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
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
