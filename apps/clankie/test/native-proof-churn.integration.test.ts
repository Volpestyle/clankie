import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";
import {
  fleetProcessHelper,
  observeNativeBirth,
  NativeProcessDiagnosticSchema,
} from "../src/local-fleet-process.ts";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";

const exec = promisify(execFile);
const enabled = process.platform === "darwin" && process.env.FLEET_PROOF_NATIVE_TEST === "1";
const local = resolve(".local/project-proof/churn/native/integration");
const fixture = resolve(local, "processes");
const fdChurn = resolve(local, "fd-churn");
type Birth = [string, string];
interface Facts {
  schemaVersion: 1;
  owner: { pid: number; uid: number; birth: Birth; socket: string };
  ancestors: Array<{ pid: number; ppid: number; birth: Birth }>;
}
interface Reply {
  id: number;
  ok: boolean;
  result: Facts | null;
  stderr: string;
  elapsedMs: number;
}

class Native {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: AsyncIterator<string>;
  private id = 0;
  readonly evidence: Reply[] = [];
  readonly metrics = new FleetHealthMetrics();
  constructor() {
    this.child = spawn(fleetProcessHelper(), ["--serve"], { stdio: "pipe" });
    this.lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]();
  }
  async request(args: Array<string | number>): Promise<Reply> {
    const id = ++this.id;
    const started = performance.now();
    this.child.stdin.write(`${id} ${args.join(" ")} --diagnostics\n`);
    const next = await this.lines.next();
    expect(next.done).toBe(false);
    const reply = { ...JSON.parse(next.value!), elapsedMs: performance.now() - started } as Reply;
    expect(reply.id).toBe(id);
    expect(reply.ok).toBe(reply.result !== null);
    expect(reply.elapsedMs).toBeLessThan(1_000);
    this.evidence.push(reply);
    for (const line of reply.stderr.split("\n")) {
      const prefix = "Native process proof diagnostic: ";
      if (line.startsWith(prefix))
        this.metrics.observeProof("fleet", {
          source: "native",
          checkpoint: "initial",
          event: NativeProcessDiagnosticSchema.parse(JSON.parse(line.slice(prefix.length))),
        });
    }
    return reply;
  }
  async close() {
    if (this.child.exitCode !== null) return;
    const closed = once(this.child, "close");
    this.child.stdin.end();
    await closed;
  }
}

async function ready(child: ChildProcessWithoutNullStreams): Promise<string> {
  const reader = createInterface({ input: child.stdout });
  const [line] = await once(reader, "line");
  reader.close();
  return String(line);
}
async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.stdin.end("q");
  await exited;
}
async function sockets() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing owned listener");
  const accepted = once(server, "connection");
  const client = createConnection(address.port, "127.0.0.1");
  await once(client, "connect");
  const [peer] = (await accepted) as [Socket];
  return { server, client, peer, ports: [client.localPort!, address.port] };
}
async function closeSockets(s: Awaited<ReturnType<typeof sockets>>) {
  s.client.destroy();
  s.peer.destroy();
  await new Promise<void>((done, reject) => s.server.close((error) => (error ? reject(error) : done())));
}
function transient(reply: Reply) {
  return !reply.ok && /"reason":"(?:attempts_exhausted|budget_exhausted)"/u.test(reply.stderr);
}
async function observed(native: Native, args: Array<string | number>, ok: (reply: Reply) => boolean) {
  // Retain every separate read-only refusal; these observations dispatch no action.
  for (let i = 0; i < 8; ++i) {
    const reply = await native.request(args);
    if (ok(reply)) return reply;
    expect(transient(reply)).toBe(true);
  }
  throw new Error("Owned native observation remained unavailable; retained evidence has every refusal");
}

describe.skipIf(!enabled)("native socket proof under unrelated churn", () => {
  let native: Native;
  beforeAll(async () => {
    await mkdir(local, { recursive: true });
    await exec("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-mmacosx-version-min=14.0",
      "apps/clankie/test/helpers/native-proof-churn/processes.c",
      "-o",
      fixture,
    ]);
    await exec("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-mmacosx-version-min=14.0",
      "-pthread",
      "apps/clankie/test/fixtures/local-fleet-proof/fd-churn.c",
      "-o",
      fdChurn,
    ]);
    native = new Native();
  });
  afterAll(async () => {
    if (native) {
      await writeFile(resolve(local, "requests.json"), JSON.stringify(native.evidence, null, 2) + "\n");
      await native.close();
      await closeNativeProcessObservers();
    }
  });

  test("fresh full proofs remain available through real unrelated births and exits", async () => {
    const s = await sockets();
    const workers = [0, 1].map(() => spawn(fixture, ["churn"], { stdio: "pipe" }));
    try {
      for (const worker of workers) expect(await ready(worker)).toBe("ready");
      const before = await observed(native, s.ports, (reply) => reply.ok);
      expect(before.result!.owner.pid).toBe(process.pid);
      let accepted = 0;
      for (let i = 0; i < 30; ++i) {
        const reply = await native.request(s.ports);
        if (reply.ok) {
          ++accepted;
          expect(reply.result).toEqual(before.result);
        } else expect(transient(reply)).toBe(true);
      }
      // Opt-in availability check; every rejection remains in the evidence.
      expect(accepted).toBeGreaterThanOrEqual(27);
    } finally {
      for (const worker of workers) await stop(worker);
      await closeSockets(s);
    }
  }, 15_000);

  test("a second real PID holding the client FD never passes, including during FD churn", async () => {
    const s = await sockets();
    const first = await observed(native, s.ports, (reply) => reply.ok);
    const owner = first.result!.owner;
    // Exercise the retry cap before a second owner can cause an earlier hard
    // refusal. A complete census may legitimately succeed amid unrelated FD
    // churn; either result must be bounded and every refusal remains retained.
    const burst = spawn(fdChurn, [], { stdio: "pipe" });
    try {
      expect(await ready(burst)).toBe("ready");
      const stressed = await native.request(s.ports);
      if (stressed.ok) expect(stressed.result).toEqual(first.result);
      else expect(transient(stressed)).toBe(true);
    } finally {
      await stop(burst);
    }
    const fd = (s.client as Socket & { _handle?: { fd?: number } })._handle?.fd;
    if (fd === undefined || fd < 0) throw new Error("Missing actual connected FD");
    const sharer = spawn(fixture, ["share"], {
      stdio: ["pipe", "pipe", "pipe", fd],
    }) as ChildProcessWithoutNullStreams;
    let churn: ChildProcessWithoutNullStreams | undefined;
    try {
      expect(await ready(sharer)).toBe("ready");
      const denied = await observed(
        native,
        s.ports,
        (reply) => !reply.ok && reply.stderr.includes('"reason":"multiple_owners"'),
      );
      expect(denied.result).toBeNull();
      churn = spawn(fdChurn, [], { stdio: "pipe" });
      expect(await ready(churn)).toBe("ready");
      for (let i = 0; i < 3; ++i) {
        const reply = await native.request(s.ports);
        expect(reply.ok).toBe(false);
        expect(reply.result).toBeNull();
      }
      await stop(churn);
      churn = undefined;
      await stop(sharer);
      const recovery = await observed(native, s.ports, (reply) => reply.ok);
      expect(recovery.result).toEqual(first.result);
      const stale = await observed(
        native,
        [...s.ports, owner.pid, String(BigInt(owner.birth[0]) + 1n), owner.birth[1], owner.socket],
        (reply) => !reply.ok && reply.stderr.includes('"reason":"owner_mismatch"'),
      );
      expect(stale.result).toBeNull();
      const socketMismatch = await observed(
        native,
        [...s.ports, owner.pid, ...owner.birth, "1:1:1"],
        (reply) => !reply.ok && reply.stderr.includes('"reason":"socket_mismatch"'),
      );
      expect(socketMismatch.result).toBeNull();
      const counters = native.metrics.snapshot().totals;
      expect(counters.nativeDiagnostics.multiple_owners).toBeGreaterThan(0);
      expect(counters.nativeDiagnostics.owner_mismatch).toBeGreaterThan(0);
      expect(counters.nativeDiagnostics.socket_mismatch).toBeGreaterThan(0);
      // Retry diagnostics remain separate from the terminal fleet proof denominator.
      expect(counters.proof).toEqual({ attempts: 0, refusals: 0, byReason: {} });
    } finally {
      if (churn) await stop(churn);
      await stop(sharer);
      await closeSockets(s);
    }
  }, 15_000);

  test("a real parent exit is reflected in fresh ancestry despite unchanged owner birth", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing owned listener");
    const accepted = once(server, "connection");
    const parent = spawn(fixture, ["descendant", String(address.port)], { stdio: "pipe" });
    const parentClosed = once(parent, "close");
    let ownerPid: number | undefined, ownerBirth: Birth | undefined, peer: Socket | undefined;
    try {
      const line = await ready(parent);
      const match = /^ready (\d+) (\d+)$/u.exec(line);
      if (!match) throw new Error("Missing owned descendant readiness");
      ownerPid = Number(match[1]);
      [peer] = (await accepted) as [Socket];
      const ports = [Number(match[2]), address.port];
      const first = await observed(native, ports, (reply) => reply.ok);
      expect(first.result!.owner.pid).toBe(ownerPid);
      ownerBirth = first.result!.owner.birth;
      const ancestor = first.result!.ancestors.find((entry) => entry.pid === parent.pid);
      expect(ancestor).toBeDefined();
      await stop(parent);
      expect(() => process.kill(parent.pid!, 0)).toThrow();
      const changed = await observed(native, ports, (reply) => reply.ok);
      expect(changed.result!.owner).toEqual(first.result!.owner);
      // The original parent lifetime is no longer available to the caller's
      // membership fence. Native retries cannot cache that former ancestry.
      expect(
        changed.result!.ancestors.some(
          (entry) => entry.pid === ancestor!.pid && entry.birth.join(".") === ancestor!.birth.join("."),
        ),
      ).toBe(false);
    } finally {
      if (
        ownerPid !== undefined &&
        ownerBirth &&
        (await observeNativeBirth(ownerPid))?.join(".") === ownerBirth.join(".")
      ) {
        try {
          process.kill(ownerPid, "SIGTERM");
        } catch {
          /* Owned child already exited. */
        }
      }
      await stop(parent);
      await parentClosed;
      if (ownerPid !== undefined) {
        let absent = false;
        for (let i = 0; i < 100; ++i) {
          try {
            process.kill(ownerPid, 0);
          } catch (error) {
            absent = (error as NodeJS.ErrnoException).code === "ESRCH";
            if (absent) break;
          }
          await new Promise((done) => setTimeout(done, 10));
        }
        expect(absent).toBe(true);
      }
      peer?.destroy();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    }
  }, 15_000);
});
