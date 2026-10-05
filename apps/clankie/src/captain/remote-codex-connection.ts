import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { freeLoopbackPort, forwardSshArgs, type HerdrFleet } from "../herdr-fleet.ts";
import { windowsCodexForwardCommand } from "../windows-process-probe.ts";

const READY = "CLANKIE_CODEX_FORWARD_READY";
const PREFIX = "CLANKIE_CODEX_CONNECTION ";

export interface RemoteCodexConnection {
  readonly socket: WebSocket;
  readonly connection: { clientPort: number; serverPort: number };
  alive(): boolean;
  close(): void;
}

/** Only host facts travel on stdout. Protocol bytes use native SSH forwarding. */
function observeForward(child: ChildProcess, serverPort: number, timeoutMs: number) {
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let tupleResolve!: (tuple: RemoteCodexConnection["connection"]) => void;
  let tupleReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const tuple = new Promise<RemoteCodexConnection["connection"]>((resolve, reject) => {
    tupleResolve = resolve;
    tupleReject = reject;
  });
  // A native process may fail before either phase's consumer begins awaiting it.
  void ready.catch(() => {});
  void tuple.catch(() => {});
  const stdout = child.stdout;
  let pending = "";
  let seenReady = false;
  const stop = () => {
    clearTimeout(timer);
    stdout?.off("data", receive);
    stdout?.off("end", ended);
    child.off("error", failed);
    child.off("exit", ended);
  };
  const failed = (error: Error) => {
    stop();
    readyReject(error);
    tupleReject(error);
  };
  const ended = () => failed(new Error("Native SSH forward closed before its tuple"));
  const timer = setTimeout(() => failed(new Error("Native SSH forward timed out")), timeoutMs);
  const receive = (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    if (pending.length > 4096) return failed(new Error("Invalid native SSH forward prelude"));
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      if (!seenReady && line === READY) {
        seenReady = true;
        readyResolve();
        continue;
      }
      try {
        if (!seenReady || !line.startsWith(PREFIX)) throw new Error("Native SSH forward tuple is missing");
        const value = JSON.parse(line.slice(PREFIX.length)) as {
          clientPort?: unknown;
          serverPort?: unknown;
        };
        if (
          typeof value.clientPort !== "number" ||
          !Number.isSafeInteger(value.clientPort) ||
          value.clientPort < 1 ||
          value.clientPort > 65_535 ||
          value.clientPort === serverPort ||
          value.serverPort !== serverPort
        )
          throw new Error("Native SSH forward tuple does not match the selected endpoint");
        stop();
        tupleResolve({ clientPort: value.clientPort, serverPort });
        return;
      } catch (error) {
        failed(error instanceof Error ? error : new Error("Invalid native SSH forward tuple"));
        return;
      }
    }
  };
  if (!stdout) failed(new Error("Native SSH forward observation is unavailable"));
  else {
    stdout.on("data", receive);
    stdout.once("end", ended);
    child.once("error", failed);
    child.once("exit", ended);
  }
  return { ready, tuple };
}

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      socket.off("open", opened);
      socket.off("error", failed);
      socket.off("close", closed);
    };
    const opened = () => {
      stop();
      resolve();
    };
    const failed = (error: Error) => {
      stop();
      reject(error);
    };
    const closed = () => failed(new Error("Native SSH WebSocket closed before opening"));
    const timer = setTimeout(() => failed(new Error("Native SSH WebSocket timed out")), timeoutMs);
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("close", closed);
  });
}

/** Connect only to the independently observed pane's backend over its registered fleet. */
export async function openRemoteCodexConnection(
  fleet: HerdrFleet,
  endpoint: string,
  timeoutMs = 10_000,
  start: typeof spawn = spawn,
): Promise<RemoteCodexConnection | undefined> {
  const match = /^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u.exec(endpoint);
  if (fleet.ssh.shell !== "powershell" || !match || Number(match[1]) > 65_535) return undefined;
  const port = Number(match[1]);
  let child: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    socket?.terminate();
    // The bounded host observer exits after its TCP row disappears. Let SSH
    // close normally rather than sending a signal into the remote shell.
    if (child?.exitCode === null && child.signalCode === null) {
      const selectedChild = child;
      const timer = setTimeout(() => selectedChild.kill("SIGTERM"), 15_000);
      timer.unref();
      selectedChild.once("exit", () => clearTimeout(timer));
    }
  };
  try {
    const localPort = await freeLoopbackPort();
    child = start(
      "ssh",
      [
        ...forwardSshArgs(fleet, localPort, port).filter((arg) => arg !== "-N"),
        windowsCodexForwardCommand(port),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const observed = observeForward(child, port, timeoutMs);
    // ExitOnForwardFailure establishes the local listener before the remote command starts.
    await observed.ready;
    socket = new WebSocket(`ws://127.0.0.1:${String(localPort)}/`, { handshakeTimeout: timeoutMs });
    socket.on("error", () => {});
    child.on("error", close);
    child.on("exit", close);
    const [, connection] = await Promise.all([waitForOpen(socket, timeoutMs), observed.tuple]);
    const selectedChild = child;
    const selectedSocket = socket;
    return {
      socket,
      connection,
      alive: () => selectedChild.exitCode === null && selectedSocket.readyState === WebSocket.OPEN,
      close,
    };
  } catch {
    close();
    return undefined;
  }
}
