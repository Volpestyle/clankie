import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type JsonObject = Record<string, unknown>;
export type JsonlMessageHandler = (message: JsonObject) => void;

export interface JsonlRpcTransport {
  onMessage(handler: JsonlMessageHandler): () => void;
  notify(message: JsonObject): void;
  request(message: JsonObject, timeoutMs?: number): Promise<JsonObject>;
  close(signal?: NodeJS.Signals): Promise<void>;
}

/**
 * Strict LF-delimited JSON parser. It intentionally does not use node:readline,
 * because several agent protocols permit Unicode line separators inside JSON strings.
 */
export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";

  public push(chunk: Uint8Array): JsonObject[] {
    this.buffered += this.decoder.write(Buffer.from(chunk));
    return this.drainCompleteLines();
  }

  public end(chunk?: Uint8Array): JsonObject[] {
    if (chunk) this.buffered += this.decoder.end(Buffer.from(chunk));
    else this.buffered += this.decoder.end();
    const messages = this.drainCompleteLines();
    const trailing = this.buffered.trim();
    this.buffered = "";
    if (trailing.length > 0) messages.push(parseLine(trailing));
    return messages;
  }

  private drainCompleteLines(): JsonObject[] {
    const result: JsonObject[] = [];
    while (true) {
      const boundary = this.buffered.indexOf("\n");
      if (boundary < 0) break;
      let line = this.buffered.slice(0, boundary);
      this.buffered = this.buffered.slice(boundary + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim().length > 0) result.push(parseLine(line));
    }
    return result;
  }
}

function parseLine(line: string): JsonObject {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSONL protocol record must be an object");
  }
  return value as JsonObject;
}

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface JsonlRpcProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnOptions?: Omit<SpawnOptionsWithoutStdio, "cwd" | "env">;
}

/**
 * Lightweight subprocess transport shared by Pi RPC and Codex App Server.
 * It owns framing, correlation, stderr capture, exit propagation, and listener cleanup.
 */
export class JsonlRpcProcess implements JsonlRpcTransport {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly decoder = new StrictJsonlDecoder();
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly listeners = new Set<JsonlMessageHandler>();
  private requestCounter = 0;
  private readonly requestTimeoutMs: number;
  private stderrTail = "";
  private closed = false;

  public constructor(options: JsonlRpcProcessOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.process = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      ...options.spawnOptions,
    });

    this.process.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.decoder.push(chunk)) this.handle(message);
      } catch (error) {
        this.failAll(new Error(`Invalid JSONL from ${options.command}: ${asMessage(error)}`));
      }
    });
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-32_768);
    });
    this.process.once("error", (error) => this.failAll(error));
    this.process.once("exit", (code, signal) => {
      this.closed = true;
      const suffix = this.stderrTail.trim() ? `\nstderr:\n${this.stderrTail.trim()}` : "";
      this.failAll(
        new Error(`${options.command} exited with code ${String(code)} signal ${String(signal)}${suffix}`),
      );
    });
  }

  public get pid(): number | undefined {
    return this.process.pid;
  }

  public onMessage(handler: JsonlMessageHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  public notify(message: JsonObject): void {
    this.write(message);
  }

  public request(message: JsonObject, timeoutMs = this.requestTimeoutMs): Promise<JsonObject> {
    const id =
      typeof message.id === "string" || typeof message.id === "number" ? message.id : ++this.requestCounter;
    const withId = { ...message, id };
    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSONL RPC request ${String(id)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
      this.write(withId);
    });
  }

  public async close(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.process.kill(signal);
    this.failAll(new Error("JSONL RPC process closed"));
  }

  public getStderrTail(): string {
    return this.stderrTail;
  }

  private write(message: JsonObject): void {
    if (this.closed || this.process.stdin.destroyed) throw new Error("JSONL RPC process is closed");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handle(message: JsonObject): void {
    const id = message.id;
    if ((typeof id === "string" || typeof id === "number") && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message);
      }
    }
    for (const listener of this.listeners) listener(message);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export function waitForMessage(
  process: Pick<JsonlRpcTransport, "onMessage">,
  predicate: (message: JsonObject) => boolean,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    let unsubscribe: () => void = () => undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribe();
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Message wait aborted"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for JSONL message after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();
    unsubscribe = process.onMessage((message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
