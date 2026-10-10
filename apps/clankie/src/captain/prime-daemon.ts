import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

/**
 * Client for Prime Agent's supervisor daemon: one JSONL Unix socket, a
 * `daemon_hello` greeting, `command` envelopes answered by id, and pushed
 * frames (`roster_update`, `session_event`) for subscribed or attached clients.
 * This is the same public wire the `prime-agent list|send|stop|attach`
 * commands use; it never starts a headless agent.
 */

/** Daemon wire protocol checked live against Prime Agent 0.10.0. */
export const PRIME_DAEMON_PROTOCOL = 7;
/** Prime Agent releases whose daemon commands and session events were verified. */
export const PRIME_AGENT_VERSION_PREFIX = "0.10.";

const exec = promisify(execFile);

export interface PrimeAgentInstall {
  /** The `prime-agent` entry point on PATH, used for owner-visible commands. */
  readonly launcher: string;
  /** The native binary the launcher execs; a hired pane's foreground root. */
  readonly executable: string;
  readonly version: string;
  readonly socketPath: string;
  readonly agentDir: string;
  /** Environment the launcher would export, so every client reaches the same daemon. */
  readonly env: Readonly<Record<string, string>>;
}

/** The launcher's socket rule (install-rust.sh): env override, else the per-user Rust socket. */
export function primeDaemonSocket(env: NodeJS.ProcessEnv): string {
  if (env.PRIME_AGENT_DAEMON_SOCKET) return env.PRIME_AGENT_DAEMON_SOCKET;
  const uid = process.getuid?.() ?? 0;
  return join(env.TMPDIR || tmpdir(), `prime-agent-rust-${String(uid)}`, "daemon.sock");
}

export async function discoverPrimeAgent(env: NodeJS.ProcessEnv = process.env): Promise<PrimeAgentInstall> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Prime Agent control is supported on macOS and Linux only");
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const launcher = join(directory, "prime-agent");
    let resolved: string;
    try {
      resolved = await realpath(launcher);
      await access(resolved, constants.X_OK);
    } catch {
      continue;
    }
    const head = await readFile(resolved).then((bytes) => bytes.subarray(0, 2).toString("latin1"));
    // The curl installer writes a shell launcher that execs the binary beside it.
    const executable =
      head === "#!"
        ? await realpath(join(dirname(resolved), "..", "share", "prime-agent", "prime-agent"))
        : resolved;
    await access(executable, constants.X_OK);
    const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR ?? join(env.HOME ?? "", ".prime", "agent");
    const socketPath = primeDaemonSocket(env);
    const launchEnv = { PRIME_AGENT_CODING_AGENT_DIR: agentDir, PRIME_AGENT_DAEMON_SOCKET: socketPath };
    const { stdout } = await exec(executable, ["--version"], {
      env: { ...env, ...launchEnv },
      timeout: 10_000,
      maxBuffer: 4096,
    });
    const version = stdout.trim();
    if (!version.startsWith(PRIME_AGENT_VERSION_PREFIX))
      throw new Error(
        `Prime Agent ${version} is not a verified version (${PRIME_AGENT_VERSION_PREFIX}x); nothing was started`,
      );
    return { launcher, executable, version, socketPath, agentDir, env: launchEnv };
  }
  throw new Error("Prime Agent is unavailable; install it and sign in to a model provider first");
}

const Hello = z.object({
  type: z.literal("daemon_hello"),
  protocol: z.object({ name: z.literal("prime-agent.daemon"), version: z.number().int() }),
  appVersion: z.string(),
  supervisorPid: z.number().int().optional(),
});
const Response = z.object({
  type: z.literal("response"),
  id: z.string(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

/** One session's live summary, as `list`, `get_state` and roster pushes report it. */
export const PrimeSessionSummary = z
  .object({
    activeSessionId: z.string().min(1),
    sessionId: z.string().min(1),
    sessionFile: z.string().optional(),
    sessionName: z.string().optional(),
    cwd: z.string(),
    lifecycle: z.string(),
    activity: z.string(),
    isStreaming: z.boolean().optional(),
    isQuotaParked: z.boolean().optional(),
    attachedClients: z.number().int().optional(),
    workerPid: z.number().int().optional(),
    workerInstanceId: z.string().optional(),
    model: z.object({ id: z.string(), provider: z.string() }).partial().optional(),
    usage: z
      .object({ inputTokens: z.number(), outputTokens: z.number(), cost: z.number() })
      .partial()
      .optional(),
  })
  .passthrough();
export type PrimeSessionSummary = z.infer<typeof PrimeSessionSummary>;

export class PrimeDaemonError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.command = command;
  }
}

export type PrimeFrame = { readonly type: string } & Readonly<Record<string, unknown>>;

/** One socket connection. Responses settle requests; every other frame goes to listeners. */
export class PrimeDaemonConnection {
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<
    string,
    { resolve(data: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Set<(frame: PrimeFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  readonly clientId = `clankie:${randomUUID()}`;
  private readonly socket: Socket;
  readonly hello: z.infer<typeof Hello>;

  private constructor(socket: Socket, hello: z.infer<typeof Hello>) {
    this.socket = socket;
    this.hello = hello;
  }

  static async connect(socketPath: string, timeoutMs = 15_000): Promise<PrimeDaemonConnection> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const peer = createConnection(socketPath);
      peer.once("connect", () => resolve(peer));
      peer.once("error", (error) => {
        peer.destroy();
        reject(error);
      });
    });
    socket.setEncoding("utf8");
    let early = "";
    const hello = await new Promise<z.infer<typeof Hello>>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Prime Agent daemon did not greet"));
      }, timeoutMs);
      const onData = (chunk: string) => {
        early += chunk;
        let newline: number;
        while ((newline = early.indexOf("\n")) >= 0) {
          const line = early.slice(0, newline).trim();
          early = early.slice(newline + 1);
          if (!line) continue;
          const parsed = Hello.safeParse(JSON.parse(line));
          if (!parsed.success) continue;
          clearTimeout(timer);
          socket.off("data", onData);
          resolve(parsed.data);
          return;
        }
      };
      socket.on("data", onData);
      socket.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Prime Agent daemon closed before greeting"));
      });
    });
    if (hello.protocol.version !== PRIME_DAEMON_PROTOCOL) {
      socket.destroy();
      throw new Error(
        `Prime Agent daemon protocol ${String(hello.protocol.version)} is not the verified ${String(PRIME_DAEMON_PROTOCOL)}`,
      );
    }
    const connection = new PrimeDaemonConnection(socket, hello);
    connection.buffer = early;
    socket.on("data", (chunk: string) => connection.receive(chunk));
    socket.on("close", () => connection.fail());
    socket.on("error", () => connection.fail());
    connection.receive("");
    return connection;
  }

  get isClosed() {
    return this.closed;
  }

  on(listener: (frame: PrimeFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Resolve with the response data; a refusal or a lost connection rejects. */
  request(
    command: { readonly type: string } & Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new PrimeDaemonError(command.type, "Prime Agent daemon disconnected"));
    const id = `clankie_${String(++this.sequence)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PrimeDaemonError(command.type, `No ${command.type} response from the Prime Agent daemon`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const envelope = {
        type: "command",
        id,
        protocol: this.hello.protocol,
        clientId: this.clientId,
        command: { ...command, id },
      };
      this.socket.write(`${JSON.stringify(envelope)}\n`);
    });
  }

  close() {
    this.socket.end();
    this.fail();
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const response = Response.safeParse(value);
      if (response.success) {
        const waiter = this.pending.get(response.data.id);
        if (!waiter) continue;
        this.pending.delete(response.data.id);
        clearTimeout(waiter.timer);
        if (response.data.success) waiter.resolve(response.data.data);
        else
          waiter.reject(
            new PrimeDaemonError(
              response.data.command,
              response.data.error ?? "Prime Agent refused the command",
            ),
          );
        continue;
      }
      if (typeof value === "object" && value !== null && typeof (value as PrimeFrame).type === "string")
        for (const listener of this.listeners) listener(value as PrimeFrame);
    }
  }

  private fail() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new PrimeDaemonError(id, "Prime Agent daemon disconnected"));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }
}

/**
 * Connect to the owner's daemon, starting Prime's own supervisor the way its
 * TUI does when none is listening. A different protocol is refused, never replaced.
 */
export async function connectPrimeDaemon(install: PrimeAgentInstall): Promise<PrimeDaemonConnection> {
  try {
    return await PrimeDaemonConnection.connect(install.socketPath);
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  const child = spawn(install.executable, ["--mode", "daemon", "--daemon-socket", install.socketPath], {
    cwd: process.env.HOME ?? "/",
    env: { ...process.env, ...install.env },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await PrimeDaemonConnection.connect(install.socketPath);
    } catch (error) {
      if (Date.now() > deadline)
        throw new Error(`Prime Agent daemon did not start on ${install.socketPath}: ${String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function primeSessionState(
  daemon: PrimeDaemonConnection,
  activeSessionId: string,
): Promise<PrimeSessionSummary> {
  return PrimeSessionSummary.parse(await daemon.request({ type: "get_state", activeSessionId }));
}
