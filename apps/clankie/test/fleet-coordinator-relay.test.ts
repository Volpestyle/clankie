import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  FleetCoordinatorRelay,
  FleetRelays,
  relayArgv,
  relaySshArgs,
} from "../src/fleet-coordinator-relay.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";

const pc: HerdrFleet = {
  id: "pc",
  session: "default",
  ssh: { host: "volpe@supedupsilly", shell: "powershell" },
};
const box: HerdrFleet = { id: "box", session: "work", ssh: { host: "box", shell: "posix" } };

describe("coordinator relay", () => {
  it("forwards only to the remote loopback, on its own connection, into the owner's socket", () => {
    const args = relaySshArgs(pc, "/Users/me/.clankie/swarm/abc/owner.sock");
    expect(args).toContain("127.0.0.1:0:/Users/me/.clankie/swarm/abc/owner.sock");
    expect(args[args.indexOf("-R") + 1]).toMatch(/^127\.0\.0\.1:0:/u);
    expect(args).toEqual(
      expect.arrayContaining(["ControlMaster=no", "ControlPath=none", "ExitOnForwardFailure=yes"]),
    );
    expect(args.at(-1)).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /u);
    expect(relaySshArgs(box, "/owner.sock").at(-1)).toMatch(/^exec node '-e' 'eval\(Buffer\.from\(/u);
  });

  it("splices a local endpoint to the forwarded port byte for byte and vanishes when the link closes", async () => {
    const home = await mkdtemp(join(tmpdir(), "clankie-relay-home-"));
    // Stands in for the port ssh forwards to the coordinator: echo every byte back.
    const upstream = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as AddressInfo).port;
    const relay = spawn(process.execPath, relayArgv("box"), {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      let stdout = "";
      const ready = new Promise<string>((resolve) =>
        relay.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          const line = stdout.split("\n")[0];
          if (stdout.includes("\n")) resolve((JSON.parse(line!) as { ready: string }).ready);
        }),
      );
      relay.stdin.write(`${JSON.stringify({ port })}\n`);
      const endpoint = await ready;
      expect(endpoint).toBe(join(home, ".clankie", "swarm-relay-box.sock"));
      const payload = Buffer.from(`{"op":"bootstrap","capability":"x"}\n✳ ${"é".repeat(1000)}`);
      const echoed = await new Promise<Buffer>((resolve, reject) => {
        const client = createConnection(endpoint);
        const chunks: Buffer[] = [];
        client.on("data", (chunk) => {
          chunks.push(chunk);
          if (Buffer.concat(chunks).length >= payload.length) {
            client.end();
            resolve(Buffer.concat(chunks));
          }
        });
        client.on("error", reject);
        client.write(payload);
      });
      expect(echoed.equals(payload)).toBe(true);
      const exited = new Promise<number | null>((resolve) => relay.on("exit", resolve));
      relay.stdin.end();
      expect(await exited).toBe(0);
      expect(existsSync(endpoint)).toBe(false);
    } finally {
      relay.kill();
      upstream.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("hands the allocated port to the remote half, reports ready, and a dropped link as unreachable", async () => {
    const children: Array<
      EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill(): void;
        written: string;
      }
    > = [];
    const fakeSpawn = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        written: "",
        kill() {},
      });
      child.stdin.on("data", (chunk: Buffer) => {
        child.written += chunk.toString();
      });
      children.push(child);
      return child;
    }) as unknown as typeof spawn;
    const relay = new FleetCoordinatorRelay(pc, "/owner.sock", { spawn: fakeSpawn });
    const ready = relay.ready(2_000);
    const child = children[0]!;
    child.stderr.write("Allocated port 43210 for remote forward to /owner.sock\n");
    await expect.poll(() => child.written).toBe('{"port":43210}\n');
    child.stdout.write(`${JSON.stringify({ ready: "\\\\.\\pipe\\clankie-swarm-pc" })}\n`);
    expect(await ready).toMatchObject({
      state: "ready",
      port: 43210,
      endpoint: "\\\\.\\pipe\\clankie-swarm-pc",
    });
    child.stderr.write("Connection to supedupsilly closed by remote host.\n");
    child.emit("exit", 255, null);
    expect(relay.status()).toMatchObject({
      state: "unreachable",
      error: "Connection to supedupsilly closed by remote host.",
    });
    relay.close();
  });

  it("restores only fleets the owner pinned to a conversation", async () => {
    const started: string[] = [];
    const relays = new FleetRelays({
      fleets: async () => [pc, box],
      relayConversation: async (fleet) => (fleet === "pc" ? "global-default" : undefined),
      ownerEndpoint: async (conversationId) => `/owners/${conversationId}.sock`,
      spawn: ((_command: string, args: readonly string[]) => {
        started.push(args[args.indexOf("-R") + 1]!);
        return Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill() {},
        });
      }) as unknown as typeof spawn,
    });
    await relays.restore();
    expect(started).toEqual(["127.0.0.1:0:/owners/global-default.sock"]);
    expect(relays.status("pc")).toMatchObject({ state: "starting" });
    expect(relays.status("box")).toBeUndefined();
    relays.close();
  });
});
