import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createConnection, createServer, type Socket } from "node:net";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteFleetRelay } from "../src/remote-fleet-relay.ts";
import { windowsFleetRelayCommand } from "../src/windows-fleet-relay.ts";

function frame(kind: number, id: number, body = Buffer.alloc(0)) {
  const bytes = Buffer.alloc(9 + body.length);
  bytes[0] = kind;
  bytes.writeUInt32LE(id, 1);
  bytes.writeUInt32LE(body.length, 5);
  body.copy(bytes, 9);
  return bytes;
}
function ports(...values: number[]) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
  return bytes;
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function setup() {
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: vi.fn(),
  });
  const ready = vi.fn();
  const relay = new RemoteFleetRelay({
    child: child as unknown as ChildProcess,
    localPort: address.port,
    ready,
  });
  cleanup.push(() => {
    relay.close();
    sockets.forEach((socket) => socket.destroy());
    server.close();
  });
  child.stdout.write(frame(0, 0, ports(1234)));
  return { child, relay, ready, sockets, serverPort: address.port };
}
async function settle(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true));
}
describe("trusted remote SSH relay", () => {
  it("binds each accepted service socket to its own exact remote TCP tuple", async () => {
    const { child, relay, ready, sockets } = await setup();
    child.stdout.write(frame(1, 1, ports(4321, 1234)));
    child.stdout.write(frame(1, 2, ports(4322, 1234)));
    await settle(() => sockets.length === 2);
    expect(ready).toHaveBeenCalledWith(1234);
    expect(relay.stream(sockets[0]!)).toMatchObject({ clientPort: 4321, serverPort: 1234 });
    expect(relay.stream(sockets[1]!)).toMatchObject({ clientPort: 4322, serverPort: 1234 });
    const proof = relay.stream(sockets[0]!)!;
    child.stdout.write(frame(3, 1));
    expect(proof.alive()).toBe(false);
    expect(relay.stream(sockets[1]!)?.alive()).toBe(true);
  });
  it("never admits an unrelated direct connection despite sharing the local listener", async () => {
    const { relay, sockets, serverPort } = await setup();
    const attacker = createConnection({ host: "127.0.0.1", port: serverPort });
    cleanup.push(() => attacker.destroy());
    await settle(() => sockets.length === 1);
    attacker.write(
      "POST /v1/fleet/mcp HTTP/1.1\r\nx-clankie-peer-port: 4321\r\nx-clankie-pane: w3:p8\r\n\r\n",
    );
    expect(relay.stream(sockets[0]!)).toBeUndefined();
  });
  it("client bytes resembling control frames remain bytes on that stream", async () => {
    const { child, relay, sockets } = await setup();
    child.stdout.write(frame(1, 1, ports(4321, 1234)));
    await settle(() => sockets.length === 1);
    const received: Buffer[] = [];
    sockets[0]!.on("data", (data) => received.push(data));
    const forged = frame(1, 999, ports(5000, 1234));
    child.stdout.write(frame(2, 1, forged));
    await settle(() => received.length > 0);
    expect(Buffer.concat(received)).toEqual(forged);
    expect(relay.stream(sockets[0]!)?.clientPort).toBe(4321);
  });
  it.each([
    ["replayed stream ID", () => frame(1, 1, ports(4322, 1234))],
    ["wrong listening port", () => frame(1, 2, ports(4322, 1235))],
    ["invalid port", () => frame(1, 2, ports(70000, 1234))],
    [
      "oversized frame",
      () => {
        const bytes = Buffer.alloc(9);
        bytes.writeUInt32LE(65537, 5);
        return bytes;
      },
    ],
    ["unknown frame kind", () => frame(9, 1)],
  ])("drops all proof on %s", async (_name, forged) => {
    const { child, relay, sockets } = await setup();
    child.stdout.write(frame(1, 1, ports(4321, 1234)));
    await settle(() => sockets.length === 1);
    const proof = relay.stream(sockets[0]!)!;
    child.stdout.write(forged());
    expect(proof.alive()).toBe(false);
    expect(child.kill).toHaveBeenCalled();
  });
  it("invalidates held proof on SSH loss", async () => {
    const { child, relay, sockets } = await setup();
    child.stdout.write(frame(1, 1, ports(4321, 1234)));
    await settle(() => sockets.length === 1);
    const proof = relay.stream(sockets[0]!)!;
    child.emit("exit", 1);
    expect(proof.alive()).toBe(false);
  });
  it("an observation timeout fails only that caller; late replies cannot become fresh proof", async () => {
    const { child, relay, sockets } = await setup();
    child.stdout.write(frame(1, 1, ports(4321, 1234)));
    await settle(() => sockets.length === 1);
    const proof = relay.stream(sockets[0]!)!;
    const command =
      "powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
      Buffer.from("'read-only'", "utf16le").toString("base64");
    await expect(relay.execute(command, 10)).rejects.toThrow("Remote observation timed out");
    expect(proof.alive()).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    const next = relay.execute(command);
    child.stdout.write(frame(4, 1, Buffer.from("expired-proof")));
    child.stdout.write(frame(4, 2, Buffer.from("fresh-proof")));
    await expect(next).resolves.toBe("fresh-proof");
    const bytes: Buffer[] = [];
    sockets[0]!.on("data", (data) => bytes.push(data));
    child.stdout.write(frame(2, 1, Buffer.from("other-pane-still-connected")));
    await settle(() => bytes.length > 0);
    expect(Buffer.concat(bytes).toString()).toBe("other-pane-still-connected");
    expect(proof.alive()).toBe(true);
    // A replay of an already settled identity still invalidates the relay.
    child.stdout.write(frame(4, 1, Buffer.from("replayed-expired-proof")));
    expect(proof.alive()).toBe(false);
  });
  it("expired observations keep their bounded capacity and drain identity until original replies settle", async () => {
    const { child, relay } = await setup();
    const command =
      "powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
      Buffer.from("'read-only'", "utf16le").toString("base64");
    const attempts = Array.from({ length: 16 }, () =>
      relay.execute(command, 10).catch((error: Error) => error.message),
    );
    expect(await Promise.all(attempts)).toEqual(Array(16).fill("Remote observation timed out"));
    await expect(relay.execute(command)).rejects.toThrow("Remote observer unavailable");
    const drained = vi.fn();
    relay.drain(drained);
    child.stdout.write(frame(6, 0));
    expect(drained).not.toHaveBeenCalled();
    for (let id = 1; id <= 16; id++) child.stdout.write(frame(4, id, Buffer.from("late-proof")));
    expect(drained).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("a genuinely stalled observer has bounded grace and cannot retain a retired relay indefinitely", async () => {
    const { child, relay, sockets } = await setup();
    child.stdout.write(frame(1, 1, ports(4321, 1234)));
    await settle(() => sockets.length === 1);
    const proof = relay.stream(sockets[0]!)!;
    const command =
      "powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
      Buffer.from("'read-only'", "utf16le").toString("base64");
    await expect(relay.execute(command, 10)).rejects.toThrow("Remote observation timed out");
    const drained = vi.fn();
    relay.drain(drained);
    child.stdout.write(frame(6, 0));
    expect(proof.alive()).toBe(true);
    expect(drained).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1), { timeout: 32_000 });
    expect(proof.alive()).toBe(false);
    expect(drained).toHaveBeenCalledTimes(1);
    await expect(relay.execute(command)).rejects.toThrow("unavailable");
  }, 35_000);
  it("binds the return channel to a one-use nonce learned only from SSH stdout", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server");
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(),
    });
    const ready = vi.fn();
    const relay = new RemoteFleetRelay({
      child: child as unknown as ChildProcess,
      localPort: 1,
      responseServer: server,
      ready,
    });
    cleanup.push(() => {
      relay.close();
      server.close();
    });
    const nonce = Buffer.alloc(32, 7);
    child.stdout.write(frame(5, 0, nonce));
    child.stdout.write(frame(0, 0, ports(1234)));
    const forged = createConnection({ host: "127.0.0.1", port: address.port });
    forged.on("error", () => {});
    cleanup.push(() => forged.destroy());
    forged.write(Buffer.alloc(32, 9));
    await settle(() => forged.destroyed);
    expect(ready).not.toHaveBeenCalled();
    const genuine = createConnection({ host: "127.0.0.1", port: address.port });
    genuine.on("error", () => {});
    cleanup.push(() => genuine.destroy());
    genuine.write(nonce);
    await settle(() => ready.mock.calls.length === 1);
    const replay = createConnection({ host: "127.0.0.1", port: address.port });
    replay.on("error", () => {});
    cleanup.push(() => replay.destroy());
    replay.write(nonce);
    await settle(() => replay.destroyed);
    expect(ready).toHaveBeenCalledTimes(1);
    const request = relay.execute(
      "powershell.exe -NoProfile -NonInteractive -EncodedCommand " +
        Buffer.from("'result'", "utf16le").toString("base64"),
    );
    child.stdout.write(frame(4, 1, Buffer.from("fresh-result")));
    await expect(request).resolves.toBe("fresh-result");
    genuine.destroy();
    await settle(() => child.kill.mock.calls.length > 0);
    await expect(relay.execute("arbitrary request")).rejects.toThrow("unavailable");
  });

  it("ships a relay that derives endpoints exclusively from accepted kernel sockets", () => {
    const command = windowsFleetRelayCommand(1234);
    const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    expect(script).toContain("AcceptTcpClient");
    expect(script).toContain("client.Client.RemoteEndPoint");
    expect(script).toContain("Console.OpenStandardOutput");
    expect(script).toContain("clients.Count >= 64");
    expect(script).not.toContain("Authorization");
    expect(script).not.toContain("x-clankie");
  });
});
