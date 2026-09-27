import { execFile, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalCoordinatorRelays,
  connectRelayArgv,
  connectRelaySshArgs,
} from "../src/fleet-coordinator-relay.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";

const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "pc", shell: "powershell" } };
const target = { id: "rivals", ssh: "pc", endpoint: String.raw`\\.\pipe\swarm-mcp-owner` };

function harness() {
  const children: Array<ReturnType<typeof child>> = [];
  function child() {
    const result = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => {
        queueMicrotask(() => result.emit("exit", 255));
        return true;
      }),
    });
    return result;
  }
  const starts: string[][] = [],
    forwards: string[][] = [];
  let failForward = false;
  let fleets = [pc];
  const relays = new ExternalCoordinatorRelays({
    fleets: async () => fleets,
    spawn: ((_command: string, args: string[]) => {
      starts.push(args);
      const result = child();
      children.push(result);
      return result;
    }) as unknown as typeof spawn,
    execFile: ((_command: string, args: string[], _options: unknown, done: (error: Error | null) => void) => {
      forwards.push(args);
      const endpoint = args[args.indexOf("-L") + 1]!.split(":")[0]!;
      if (!failForward) writeFileSync(endpoint, "", { mode: 0o600 });
      queueMicrotask(() => done(failForward ? new Error("failed") : null));
    }) as unknown as typeof execFile,
  });
  return {
    relays,
    children,
    starts,
    forwards,
    fail: () => {
      failForward = true;
    },
    disable: () => {
      fleets = [];
    },
  };
}

describe("external coordinator relay", () => {
  it("uses a private dedicated master and shell-safe remote endpoint argv", () => {
    const args = connectRelaySshArgs(pc, target.endpoint, "/tmp/private/control.sock");
    expect(args).toEqual(
      expect.arrayContaining([
        "-M",
        "-S",
        "/tmp/private/control.sock",
        "ControlPersist=no",
        "StreamLocalBindMask=0177",
      ]),
    );
    expect(args.at(-1)).toMatch(/^powershell.exe -NoProfile -NonInteractive -EncodedCommand /u);
    const posix = connectRelaySshArgs(
      { ...pc, ssh: { host: "box", shell: "posix" } },
      "/tmp/a'b.sock",
      "/tmp/control",
    );
    expect(posix.at(-1)).toContain("'/tmp/a'\\''b.sock'");
  });

  it("splices loopback to a remote socket and exits with stdin even with an active client", async () => {
    const directory = await mkdtemp("/tmp/connect-splice-");
    const endpoint = `${directory}/owner.sock`;
    const owner = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => owner.listen(endpoint, resolve));
    const relay = spawn(process.execPath, connectRelayArgv(endpoint), { stdio: ["pipe", "pipe", "pipe"] });
    let client: ReturnType<typeof createConnection> | undefined;
    try {
      const [chunk] = await once(relay.stdout, "data");
      const { port } = JSON.parse(String(chunk)) as AddressInfo;
      client = createConnection({ host: "127.0.0.1", port });
      await once(client, "connect");
      const bytes = Buffer.from(`{"op":"bootstrap"}\n${"é".repeat(2000)}`);
      const echoed = new Promise<Buffer>((resolve) => {
        let result = Buffer.alloc(0);
        client!.on("data", (chunk) => {
          result = Buffer.concat([result, chunk]);
          if (result.length === bytes.length) resolve(result);
        });
      });
      client.write(bytes);
      expect(await echoed).toEqual(bytes);
      const closed = once(client, "close");
      const exit = once(relay, "exit");
      relay.stdin.end();
      expect((await exit)[0]).toBe(0);
      await closed;
      const probe = createConnection({ host: "127.0.0.1", port });
      expect((await once(probe, "error"))[0]).toMatchObject({ code: "ECONNREFUSED" });
      expect(existsSync(endpoint)).toBe(true); // remote owner belongs to someone else
    } finally {
      relay.kill();
      client?.destroy();
      owner.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares one link per connection, retries a dropped link, and removes only its own sockets", async () => {
    const h = harness();
    try {
      const first = h.relays.endpoint(target),
        concurrent = h.relays.endpoint(target);
      await expect.poll(() => h.children.length).toBe(1);
      h.children[0]!.stdout.write('{"port":43210}\n');
      const endpoint = await first;
      expect(await concurrent).toBe(endpoint);
      expect(h.relays.generation(target.id)).toBe(1);
      expect(statSync(endpoint).mode & 0o777).toBe(0o600);
      expect(h.forwards[0]).toEqual([
        "-S",
        endpoint.replace("endpoint.sock", "control.sock"),
        "-O",
        "forward",
        "-L",
        `${endpoint}:127.0.0.1:43210`,
        "--",
        "pc",
      ]);
      h.children[0]!.emit("exit", 255);
      await expect.poll(() => h.children.length, { timeout: 4000 }).toBe(2);
      h.children[1]!.stdout.write('{"port":43211}\n');
      expect(await h.relays.endpoint(target)).toBe(endpoint);
      expect(h.relays.generation(target.id)).toBe(2);
      h.relays.close(target.id);
      expect(existsSync(endpoint)).toBe(false);
      expect(h.children[1]!.kill).toHaveBeenCalled();
    } finally {
      h.relays.close();
    }
  });

  it("fails closed when forwarding fails or the fleet is disabled", async () => {
    const h = harness();
    try {
      h.fail();
      const first = h.relays.endpoint(target);
      const rejected = expect(first).rejects.toThrow("local forward failed");
      await expect.poll(() => h.children.length).toBe(1);
      h.children[0]!.stdout.write('{"port":43210}\n');
      await rejected;
      h.disable();
      await expect(h.relays.endpoint(target)).rejects.toThrow("No enabled SSH fleet");
    } finally {
      h.relays.close();
    }
  });

  it("rejects malformed remote readiness without installing a forward", async () => {
    const h = harness();
    try {
      const first = h.relays.endpoint(target);
      const rejected = expect(first).rejects.toThrow("disconnected");
      await expect.poll(() => h.children.length).toBe(1);
      h.children[0]!.stdout.write('{"port":0}\n');
      await rejected;
      expect(h.forwards).toHaveLength(0);
    } finally {
      h.relays.close();
    }
  });
});
