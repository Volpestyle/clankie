import { createConnection, type Socket, type Server } from "node:net";
import { timingSafeEqual } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { RemoteStream } from "./remote-project-proof.ts";

const MAX_FRAME = 65536;
const MAX_PENDING = 4 * 1024 * 1024;
const OBSERVATION_GRACE_MS = 30_000;
const STATS_WINDOW_MS = 5 * 60_000;
/** Herdr census reads (herdr-fleet.ts remoteHerdrObservation); everything else is a proof or path check. */
const CENSUS_SCRIPT = /Native Herdr observation failed/u;

interface Deferred {
  readonly promise: Promise<string>;
  resolve(value: string): void;
  reject(error: unknown): void;
  timeoutMs: number;
}
interface Run {
  current?: Promise<string>;
  next: Deferred | undefined;
}
function deferred(timeoutMs: number): Deferred {
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // A queued run nobody awaits after its callers timed out must not surface as unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject, timeoutMs };
}
function emptyStats() {
  return { dispatched: 0, census: 0, joined: 0, timedOut: 0 };
}
/** Safe transport reasons; never carries the observation script or its output. */
export class RemoteObservationError extends Error {
  readonly code: "remote_observation_timeout" | "remote_observer_unavailable";
  constructor(code: "remote_observation_timeout" | "remote_observer_unavailable") {
    super(
      code === "remote_observation_timeout" ? "Remote observation timed out" : "Remote observer unavailable",
    );
    this.code = code;
  }
}
interface Stream extends RemoteStream {
  socket: Socket;
  id: number;
}

/** Only authenticated SSH stdout can introduce streams; HTTP client bytes cannot introduce frames. */
export class RemoteFleetRelay {
  private buffer = Buffer.alloc(0);
  private streams = new Map<number, Stream>();
  private readonly closing = new Set<number>();
  private open = true;
  private lastId = 0;
  private remotePort: number | undefined;
  private readyNotified = false;
  private nonce: Buffer | undefined;
  private response: Socket | undefined;
  private readonly candidates = new Map<Socket, Buffer>();
  private drained: (() => void) | undefined;
  private draining = false;
  private drainAcknowledged = false;
  private commandId = 0;
  /**
   * Identical read-only observations in flight, by exact command. A caller that
   * arrives while one runs joins the next run, never the current one, so every
   * result it sees came from a script dispatched after it asked (VUH-1748).
   */
  private readonly runs = new Map<string, Run>();
  private stats = emptyStats();
  private statsTimer: ReturnType<typeof setInterval> | undefined;
  private readonly commands = new Map<
    number,
    {
      resolve(value: string): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
      expired: boolean;
    }
  >();
  private readonly options: {
    child: ChildProcess;
    localPort: number;
    ready(port: number): void;
    connect?: typeof createConnection;
    responseServer?: Server;
    log?(message: string): void;
  };
  constructor(options: RemoteFleetRelay["options"]) {
    this.options = options;
    options.responseServer?.on("connection", (socket) => {
      if (!this.open || this.response || this.candidates.size >= 4) {
        socket.destroy();
        return;
      }
      this.candidates.set(socket, Buffer.alloc(0));
      socket.setTimeout(5_000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      socket.on("close", () => {
        this.candidates.delete(socket);
        if (this.response === socket) this.close();
      });
      socket.on("data", (chunk: Buffer) => {
        const prior = this.candidates.get(socket);
        if (!prior || prior.length + chunk.length > 32) {
          socket.destroy();
          return;
        }
        this.candidates.set(socket, Buffer.concat([prior, chunk]));
        this.bindResponse();
      });
    });
    options.child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    options.child.once("exit", () => this.close());
    options.child.once("error", () => this.close());
  }

  private bindResponse(): void {
    if (!this.nonce || this.response) return;
    for (const [socket, bytes] of this.candidates) {
      if (bytes.length !== 32) continue;
      if (!timingSafeEqual(this.nonce, bytes)) {
        socket.destroy();
        this.candidates.delete(socket);
        continue;
      }
      this.response = socket;
      socket.setTimeout(0);
      this.candidates.delete(socket);
      for (const other of this.candidates.keys()) other.destroy();
      this.candidates.clear();
      this.notifyReady();
      return;
    }
  }

  private notifyReady(): void {
    if (
      this.readyNotified ||
      this.remotePort === undefined ||
      (this.options.responseServer && !this.response)
    )
      return;
    this.readyNotified = true;
    this.options.ready(this.remotePort);
  }

  /** A bounded fresh observation executed inside the service-owned relay PowerShell process. */
  alive(): boolean {
    return this.open && this.readyNotified;
  }

  /** One summary line per window measures what the serial Windows queue carries. */
  private reportStats(): void {
    if (this.statsTimer !== undefined || this.options.log === undefined) return;
    this.statsTimer = setInterval(() => {
      const { dispatched, census, joined, timedOut } = this.stats;
      this.stats = emptyStats();
      if (dispatched + joined + timedOut === 0) return;
      this.options.log?.(
        `remote observations in ${String(STATS_WINDOW_MS / 60_000)} min: dispatched ${String(dispatched)} ` +
          `(census ${String(census)}, other ${String(dispatched - census)}), joined ${String(joined)}, ` +
          `timed out ${String(timedOut)}`,
      );
    }, STATS_WINDOW_MS);
    this.statsTimer.unref?.();
  }

  /** Retain accepted HTTP streams and observations until their replies finish. */
  drain(complete: () => void): void {
    this.drained = complete;
    this.draining = true;
    this.send(6, 0);
    this.finishDrain();
  }

  private finishDrain(): void {
    if (
      !this.drained ||
      (this.open && !this.drainAcknowledged) ||
      this.streams.size > 0 ||
      this.closing.size > 0 ||
      this.commands.size > 0
    )
      return;
    const complete = this.drained;
    this.drained = undefined;
    complete();
  }

  /**
   * Windows runs observations one at a time, so duplicates queue behind each
   * other and push latency-sensitive proofs past their timeout. Coalesce exact
   * duplicates onto the next run: at most one running and one queued per
   * command, and each caller still times out from its own arrival.
   */
  execute(command: string, timeoutMs = 10_000): Promise<string> {
    const run = this.runs.get(command);
    if (run === undefined) {
      const entry: Run = { next: undefined };
      this.runs.set(command, entry);
      this.track(command, entry, this.dispatch(command, timeoutMs));
      return entry.current!;
    }
    this.stats.joined++;
    const next = (run.next ??= deferred(timeoutMs));
    next.timeoutMs = Math.max(next.timeoutMs, timeoutMs);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stats.timedOut++;
        reject(new RemoteObservationError("remote_observation_timeout"));
      }, timeoutMs);
      next.promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private track(command: string, entry: Run, current: Promise<string>): void {
    entry.current = current;
    const advance = () => {
      if (this.runs.get(command) !== entry) return;
      const next = entry.next;
      if (next === undefined) {
        this.runs.delete(command);
        return;
      }
      entry.next = undefined;
      const started = this.dispatch(command, next.timeoutMs);
      started.then(next.resolve, next.reject);
      this.track(command, entry, started);
    };
    current.then(advance, advance);
  }

  private dispatch(command: string, timeoutMs: number): Promise<string> {
    const encoded = /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/u.exec(
      command,
    )?.[1];
    if (!this.open || !this.readyNotified || !encoded || this.commands.size >= 16)
      return Promise.reject(new RemoteObservationError("remote_observer_unavailable"));
    const script = Buffer.from(Buffer.from(encoded, "base64").toString("utf16le"), "utf8");
    this.stats.dispatched++;
    if (CENSUS_SCRIPT.test(script.toString("utf8"))) this.stats.census++;
    this.reportStats();
    if (script.length > MAX_FRAME || this.commandId >= 0xffffffff)
      return Promise.reject(new Error("Remote observation too large"));
    const id = ++this.commandId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const command = this.commands.get(id);
        if (!command) return;
        // Windows executes these read-only observations serially. One queued
        // caller timing out must not kill every pane's authenticated stream.
        // Keep its exact ID and capacity until the original reply arrives;
        // an expired result can never become proof or satisfy a later request.
        command.expired = true;
        this.stats.timedOut++;
        reject(new RemoteObservationError("remote_observation_timeout"));
        this.options.log?.(`remote observation ${id} timed out after ${timeoutMs} ms; relay retained`);
        // A truly hung script stops Windows' serial observer queue. Bound the
        // original's late-reply grace, including retirement, so it cannot hold
        // an old relay or consume its 16 slots forever. Never replay it.
        command.timer = setTimeout(() => {
          this.options.log?.(
            `remote observation ${id} remained unresolved for ${OBSERVATION_GRACE_MS} ms after timeout; closing stalled relay`,
          );
          this.close();
        }, OBSERVATION_GRACE_MS);
      }, timeoutMs);
      this.commands.set(id, { resolve, reject, timer, expired: false });
      this.send(4, id, script);
    });
  }

  /** Match both ends of the locally created TCP pair while its exact stream is still alive. */
  stream(socket: Socket): RemoteStream | undefined {
    if (
      !this.open ||
      socket.destroyed ||
      socket.localAddress !== "127.0.0.1" ||
      socket.remoteAddress !== "127.0.0.1"
    )
      return undefined;
    for (const stream of this.streams.values()) {
      if (
        stream.alive() &&
        stream.socket.localPort === socket.remotePort &&
        stream.socket.remotePort === socket.localPort
      ) {
        return {
          clientPort: stream.clientPort,
          serverPort: stream.serverPort,
          alive: () => stream.alive() && !socket.destroyed && socket.readable && socket.writable,
        };
      }
    }
    return undefined;
  }

  private send(kind: number, id: number, bytes: Buffer = Buffer.alloc(0)): void {
    const input = this.options.responseServer ? this.response : this.options.child.stdin;
    if (!this.open || !input || input.destroyed) return;
    if (bytes.length > MAX_FRAME || input.writableLength > MAX_PENDING) {
      this.close();
      return;
    }
    const frame = Buffer.alloc(9 + bytes.length);
    frame[0] = kind;
    frame.writeUInt32LE(id, 1);
    frame.writeUInt32LE(bytes.length, 5);
    bytes.copy(frame, 9);
    input.write(frame);
  }

  private receive(chunk: Buffer): void {
    if (!this.open) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.buffer.length >= 9) {
        const kind = this.buffer[0]!,
          id = this.buffer.readUInt32LE(1),
          length = this.buffer.readUInt32LE(5);
        if (length > MAX_FRAME) throw new Error("Oversized relay frame");
        if (this.buffer.length < 9 + length) return;
        const bytes = this.buffer.subarray(9, 9 + length);
        this.buffer = this.buffer.subarray(9 + length);
        this.frame(kind, id, bytes);
      }
    } catch {
      this.close();
    }
  }

  private frame(kind: number, id: number, bytes: Buffer): void {
    if (kind === 6 && id === 0 && bytes.length === 0 && this.draining && !this.drainAcknowledged) {
      this.drainAcknowledged = true;
      this.finishDrain();
      return;
    }
    if (
      kind === 5 &&
      id === 0 &&
      bytes.length === 32 &&
      this.nonce === undefined &&
      this.options.responseServer
    ) {
      this.nonce = Buffer.from(bytes);
      this.bindResponse();
      return;
    }
    if (kind === 4 && id > 0) {
      const command = this.commands.get(id);
      if (!command) throw new Error("Unknown relay observation");
      this.commands.delete(id);
      clearTimeout(command.timer);
      if (!command.expired) command.resolve(bytes.toString("utf8"));
      this.finishDrain();
      return;
    }
    if (kind === 0 && id === 0 && bytes.length === 4 && this.remotePort === undefined) {
      const port = bytes.readUInt32LE();
      if (port < 1 || port > 65535) throw new Error("Invalid relay port");
      this.remotePort = port;
      this.notifyReady();
      return;
    }
    if (this.remotePort === undefined || id === 0) throw new Error("Relay not ready");
    if (kind === 1) {
      if (bytes.length !== 8 || id <= this.lastId || this.streams.size + this.closing.size >= 64)
        throw new Error("Invalid relay stream");
      this.lastId = id;
      if (this.draining) {
        this.closing.add(id);
        this.send(3, id);
        return;
      }
      const clientPort = bytes.readUInt32LE(),
        serverPort = bytes.readUInt32LE(4);
      if (serverPort !== this.remotePort || clientPort < 1 || clientPort > 65535)
        throw new Error("Invalid relay tuple");
      const socket = (this.options.connect ?? createConnection)({
        host: "127.0.0.1",
        port: this.options.localPort,
      });
      const stream: Stream = {
        id,
        socket,
        clientPort,
        serverPort,
        alive: () =>
          this.open &&
          this.streams.get(id) === stream &&
          !socket.destroyed &&
          (!this.options.responseServer || (this.response !== undefined && !this.response.destroyed)),
      };
      this.streams.set(id, stream);
      socket.on("data", (data: Buffer) => {
        for (let offset = 0; offset < data.length; offset += MAX_FRAME)
          this.send(2, id, data.subarray(offset, offset + MAX_FRAME));
      });
      socket.on("error", () => socket.destroy());
      socket.once("close", () => {
        if (this.streams.get(id) !== stream) return;
        this.streams.delete(id);
        // Remote kind 3 acknowledges the preceding response frames. A local
        // close alone does not mean those bytes have reached the remote client.
        this.closing.add(id);
        this.send(3, id);
        this.finishDrain();
      });
      return;
    }
    const stream = this.streams.get(id);
    // Closing races are normal; stale data never creates/rebinds a stream.
    if (kind === 3 && bytes.length === 0) {
      this.closing.delete(id);
      stream?.socket.destroy();
      this.streams.delete(id);
      this.finishDrain();
      return;
    }
    if (kind !== 2) throw new Error("Invalid relay frame kind");
    if (stream) {
      if (stream.socket.writableLength > MAX_PENDING) throw new Error("Relay consumer stalled");
      stream.socket.write(bytes);
    }
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    for (const stream of this.streams.values()) stream.socket.destroy();
    this.streams.clear();
    this.closing.clear();
    this.buffer = Buffer.alloc(0);
    this.response?.destroy();
    for (const socket of this.candidates.keys()) socket.destroy();
    this.candidates.clear();
    this.nonce?.fill(0);
    this.nonce = undefined;
    for (const command of this.commands.values()) {
      clearTimeout(command.timer);
      command.reject(new RemoteObservationError("remote_observer_unavailable"));
    }
    this.commands.clear();
    if (this.statsTimer !== undefined) clearInterval(this.statsTimer);
    this.statsTimer = undefined;
    this.finishDrain();
    this.options.child.stdin?.destroy();
    this.options.child.kill();
  }
}
