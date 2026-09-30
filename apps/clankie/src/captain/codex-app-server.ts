import { spawn } from "node:child_process";
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
  send(message: string): Promise<{ turnId: string; state: "started" | "queued" }>;
  interrupt(): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Protocol reference: https://developers.openai.com/codex/app-server
 * Unix transport is WebSocket over HTTP Upgrade (not JSONL). The private socket
 * avoids a shared daemon losing the pane identity (VUH-1398), and TCP exposure.
 */
export async function startCodexAppServerSeat(options: {
  cwd: string;
  model?: string;
  effort?: string;
  env?: Readonly<Record<string, string>>;
  onEvent?: (event: CodexSeatEvent) => void;
}): Promise<CodexAppServerSeat> {
  const directory = await mkdtemp(join(tmpdir(), "clankie-codex-"));
  const socketPath = join(directory, "rpc.sock");
  const endpoint = `unix://${socketPath}`;
  // The supervisor must not lend its own pane identity or Swarm enrollment to
  // the child. Explicit worker launch settings (including CODEX_HOME) survive.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:HERDR_|SWARM_|CLANKIE_SWARM_)/u.test(key)),
  );
  const child = spawn("codex", ["app-server", "--listen", endpoint], {
    cwd: options.cwd,
    env: { ...env, ...options.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let failure: Error | undefined;
  let stderr = "";
  let client: CodexAppServerClient | undefined;
  let closed = false;
  child.stderr.on("data", (bytes: Buffer) => {
    stderr = (stderr + bytes.toString()).slice(-8_192);
  });
  child.on("error", (error) => {
    failure = error;
    client?.close();
  });
  child.on("exit", (code) => {
    failure = new Error(`Codex app-server exited (${String(code)}): ${stderr}`);
    client?.close();
    options.onEvent?.({ method: "connection/closed", params: { code } });
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    client?.close();
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
  };
  try {
    const deadline = Date.now() + 15_000;
    let socket: WebSocket | undefined;
    while (!socket) {
      if (failure) throw failure;
      if (Date.now() >= deadline) throw new Error(`Codex app-server did not open its socket: ${stderr}`);
      socket = await new Promise<WebSocket | undefined>((resolve) => {
        const attempt = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 1_000 });
        attempt.once("open", () => resolve(attempt));
        attempt.once("error", () => {
          attempt.terminate();
          resolve(undefined);
        });
      });
      if (!socket) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let activeTurn: string | undefined;
    let threadId: string | undefined;
    client = new CodexAppServerClient(socket, (event) => {
      if (event.params.threadId === threadId) {
        const turn = record(event.params.turn);
        if (event.method === "turn/started" && typeof turn.id === "string") activeTurn = turn.id;
        if (event.method === "turn/completed" && turn.id === activeTurn) activeTurn = undefined;
      }
      options.onEvent?.(event);
    });
    await client.initialize();
    const result = record(
      await client.request("thread/start", {
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { config: { model_reasoning_effort: options.effort } } : {}),
      }),
    );
    const thread = record(result.thread);
    if (typeof thread.id !== "string") throw new Error("Codex app-server returned no thread identity");
    threadId = thread.id;
    let sending: Promise<unknown> = Promise.resolve();
    return {
      threadId,
      ...(typeof thread.path === "string" ? { transcriptPath: thread.path } : {}),
      viewArgs: ["--remote", endpoint, "resume", threadId],
      send(message) {
        const send = async () => {
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
          return { turnId, state: steering ? ("queued" as const) : ("started" as const) };
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
