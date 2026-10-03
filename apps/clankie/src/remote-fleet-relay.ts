import { createConnection, type Socket } from "node:net";
import type { ChildProcess } from "node:child_process";
import type { RemoteStream } from "./remote-project-proof.ts";

const MAX_FRAME = 65536;
const MAX_PENDING = 4 * 1024 * 1024;
interface Stream extends RemoteStream {
  socket: Socket;
  id: number;
}

/** Only authenticated SSH stdout can introduce streams; HTTP client bytes cannot introduce frames. */
export class RemoteFleetRelay {
  private buffer = Buffer.alloc(0);
  private streams = new Map<number, Stream>();
  private open = true;
  private lastId = 0;
  private remotePort: number | undefined;
  private readonly options: {
    child: ChildProcess;
    localPort: number;
    ready(port: number): void;
    connect?: typeof createConnection;
  };
  constructor(options: RemoteFleetRelay["options"]) {
    this.options = options;
    options.child.stdout?.on("data", (chunk: Buffer) => this.receive(chunk));
    options.child.once("exit", () => this.close());
    options.child.once("error", () => this.close());
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
    const input = this.options.child.stdin;
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
    if (kind === 0 && id === 0 && bytes.length === 4 && this.remotePort === undefined) {
      const port = bytes.readUInt32LE();
      if (port < 1 || port > 65535) throw new Error("Invalid relay port");
      this.remotePort = port;
      this.options.ready(port);
      return;
    }
    if (this.remotePort === undefined || id === 0) throw new Error("Relay not ready");
    if (kind === 1) {
      if (bytes.length !== 8 || id <= this.lastId || this.streams.size >= 64)
        throw new Error("Invalid relay stream");
      this.lastId = id;
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
        alive: () => this.open && this.streams.get(id) === stream && !socket.destroyed,
      };
      this.streams.set(id, stream);
      socket.on("data", (data: Buffer) => {
        for (let offset = 0; offset < data.length; offset += MAX_FRAME)
          this.send(2, id, data.subarray(offset, offset + MAX_FRAME));
      });
      socket.on("error", () => socket.destroy());
      socket.once("close", () => {
        this.streams.delete(id);
        this.send(3, id);
      });
      return;
    }
    const stream = this.streams.get(id);
    // Closing races are normal; stale data never creates/rebinds a stream.
    if (kind === 3 && bytes.length === 0) {
      stream?.socket.destroy();
      this.streams.delete(id);
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
    this.buffer = Buffer.alloc(0);
    this.options.child.kill();
  }
}
