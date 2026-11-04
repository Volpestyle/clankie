import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { createResourceGovernor, defaultResourcePolicy } from "@clankie/fleet-resources";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  FOREIGN_HEAVY_PERMITS_PATH,
  ForeignHeavyPermitsSnapshotSchema,
} from "@clankie/protocol/owner-settings";
import { SettingsStore } from "@clankie/settings";
import { createForeignHeavyPermits } from "../src/foreign-heavy-permits.ts";
import { createForeignHeavyPermitsRoutes } from "../src/foreign-heavy-permits-routes.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";

// The CI account's permit socket (#562), over a real unix socket, the real
// governor in a scratch registry and the real native peer check. The test
// process is the peer, so "the permitted user" is whoever runs the test.
const repoRoot = resolve(import.meta.dirname, "../../..");
const me = userInfo().username;
const cleanups: (() => Promise<void>)[] = [];
const exec = promisify(execFile);

beforeAll(async () => {
  // The checkout's helper may predate `--peer-uid`; the build is a no-op when current.
  await exec(process.execPath, [join(repoRoot, "scripts/build-fleet-proof.mjs")]);
}, 120_000);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { minuteMs?: number } = {}) {
  // Short: a unix socket path must fit in 104 bytes.
  const root = await realpath(await mkdtemp(join(tmpdir(), "fhp-")));
  const governor = createResourceGovernor({
    directory: join(root, "registry"),
    probe: async () => ({ loadRatio: 0.1, availableMemoryMb: 64_000 }),
    heavyJobSettleMs: 0,
  });
  await governor.configure({
    ...defaultResourcePolicy(),
    heavySlots: 1,
    minAvailableMemoryMb: 0,
    minFreeDiskGb: 0,
  });
  const directory = join(root, "permits");
  const permits = createForeignHeavyPermits({
    governor,
    helper: fleetProcessHelper(repoRoot),
    directory,
    ...options,
  });
  cleanups.push(async () => {
    await permits.close();
    await governor.close();
    await rm(root, { recursive: true, force: true });
  });
  const used = async () => (await governor.snapshot()).capacity.used;
  return { root, directory, governor, permits, used };
}

function client(path: string) {
  const socket = connect(path);
  const lines: Record<string, string>[] = [];
  let buffer = "";
  let closed = false;
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, newline)) as Record<string, string>);
      buffer = buffer.slice(newline + 1);
    }
  });
  socket.on("error", () => undefined);
  socket.once("close", () => (closed = true));
  const until = async (state: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = lines.find((line) => line.state === state);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(`Expected ${state}; got ${JSON.stringify(lines)} closed=${closed}`);
      await delay(20);
    }
  };
  return {
    socket: socket as Socket,
    lines,
    until,
    closed: () => closed,
    send: (value: unknown) => socket.write(`${JSON.stringify(value)}\n`),
  };
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Condition never held");
    await delay(25);
  }
}

const acl = async (path: string) => (await exec("/bin/ls", ["-led", path])).stdout;

describe.runIf(process.platform === "darwin")("foreign heavy permits", () => {
  it("is off until the owner turns it on, then makes a private directory with one user ACL and a socket only that user can reach", async () => {
    const { directory, permits } = await fixture();
    expect(permits.snapshot()).toMatchObject({ enabled: false, listening: false });
    const snapshot = await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 60 });
    expect(snapshot).toMatchObject({
      enabled: true,
      listening: true,
      socketPath: join(directory, "heavy.sock"),
    });
    const dir = await lstat(directory);
    expect(dir.mode & 0o777).toBe(0o700);
    const sock = await lstat(join(directory, "heavy.sock"));
    expect(sock.isSocket()).toBe(true);
    expect(sock.mode & 0o777).toBe(0o702);
    const dirAcl = await acl(directory);
    expect(dirAcl).toContain(`user:${me} allow search`);
    expect(dirAcl.match(/^ \d+: /gmu)).toHaveLength(1);
    expect((await acl(join(directory, "heavy.sock"))).match(/^ \d+: /gmu)).toBeNull();
  });

  it("holds a full slot for the permitted peer and releases it when the connection closes", async () => {
    const { directory, permits, used, governor } = await fixture();
    await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 60 });
    const ci = client(join(directory, "heavy.sock"));
    ci.send({ op: "acquire", lane: "full", label: "run/42\u001b[31m\nfake log line" });
    await ci.until("granted");
    expect(await used()).toBe(1);
    const lease = (await governor.snapshot()).leases.find((entry) =>
      entry.holderId?.startsWith("ci-permit:"),
    );
    // The label reaches the journal as a plain name: no escape, no newline.
    expect(lease?.holderId).toBe("ci-permit:run/42__31m_fake log line");
    ci.socket.destroy();
    await eventually(async () => (await used()) === 0);
  });

  it("refuses a peer that is not the permitted user, by the kernel's uid, not the ACL", async () => {
    const { directory, permits, used } = await fixture();
    // The owner can always reach his own 0700 socket; only the peer check refuses him.
    await permits.apply({ user: "daemon", maxLeases: 1, maxHoldMinutes: 60 });
    expect(await acl(directory)).toContain("user:daemon allow search");
    const ci = client(join(directory, "heavy.sock"));
    ci.send({ op: "acquire", lane: "full", label: "x" });
    expect(await ci.until("refused")).toMatchObject({ reason: "peer_not_permitted" });
    expect(await used()).toBe(0);
  });

  it("refuses a silent client at the deadline, an oversized line, a bad request and another lane", async () => {
    const { directory, permits, used } = await fixture();
    await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 60 });
    const path = join(directory, "heavy.sock");
    const silent = client(path);
    const huge = client(path);
    huge.socket.write("x".repeat(2048));
    const malformed = client(path);
    malformed.send({ op: "acquire", lane: "full", label: "x", command: "rm -rf /" });
    const light = client(path);
    light.send({ op: "acquire", lane: "light", label: "x" });
    expect(await huge.until("refused")).toMatchObject({ reason: "request_too_large" });
    expect(await malformed.until("refused")).toMatchObject({ reason: "malformed" });
    expect(await light.until("refused")).toMatchObject({ reason: "lane_not_allowed" });
    const started = Date.now();
    expect(await silent.until("refused", 10_000)).toMatchObject({ reason: "request_deadline" });
    expect(Date.now() - started).toBeLessThan(7_000);
    expect(await used()).toBe(0);
  });

  it("holds at most maxLeases foreign leases and queues the rest in order", async () => {
    const { directory, permits, used } = await fixture();
    await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 60 });
    const path = join(directory, "heavy.sock");
    const first = client(path);
    first.send({ op: "acquire", lane: "full", label: "first" });
    await first.until("granted");
    const second = client(path);
    second.send({ op: "acquire", lane: "full", label: "second" });
    expect(await second.until("waiting")).toMatchObject({ reason: "foreign_cap" });
    expect(await used()).toBe(1);
    first.socket.destroy();
    await second.until("granted");
    expect(await used()).toBe(1);
  });

  it("a caller that hangs up while waiting leaves the queue, so abandoned places never fill it", async () => {
    const { directory, permits } = await fixture();
    await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 60 });
    const path = join(directory, "heavy.sock");
    const holder = client(path);
    holder.send({ op: "acquire", lane: "full", label: "holder" });
    await holder.until("granted");
    // Fill the whole queue (four places per lease), then hang up every one.
    for (let round = 0; round < 2; round++) {
      const waiters = Array.from({ length: 4 }, () => client(path));
      for (const waiter of waiters) waiter.send({ op: "acquire", lane: "full", label: "waiter" });
      for (const waiter of waiters) await waiter.until("waiting");
      for (const waiter of waiters) waiter.socket.destroy();
      await eventually(async () => waiters.every((waiter) => waiter.closed()));
      await delay(100);
    }
    const next = client(path);
    next.send({ op: "acquire", lane: "full", label: "next" });
    expect(await next.until("waiting")).toMatchObject({ reason: "foreign_cap" });
  });

  it("takes the lease back at the maximum hold and says it is lost", async () => {
    const { directory, permits, used } = await fixture({ minuteMs: 300 });
    await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 1 });
    const ci = client(join(directory, "heavy.sock"));
    ci.send({ op: "acquire", lane: "full", label: "long" });
    await ci.until("granted");
    expect(await ci.until("lost")).toMatchObject({ reason: "max_hold" });
    await eventually(async () => (await used()) === 0);
  });

  it("turning it off closes the socket, ends held leases as lost and removes the socket file", async () => {
    const { directory, permits, used } = await fixture();
    await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 60 });
    const ci = client(join(directory, "heavy.sock"));
    ci.send({ op: "acquire", lane: "full", label: "held" });
    await ci.until("granted");
    expect(await permits.apply(undefined)).toMatchObject({ enabled: false, listening: false });
    expect(await ci.until("lost")).toMatchObject({ reason: "disabled" });
    await eventually(async () => ci.closed());
    await eventually(async () => (await used()) === 0);
    await expect(lstat(join(directory, "heavy.sock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("the CI client runs its command under the permit and stops it when the permit is lost", async () => {
    const { directory, permits, used } = await fixture({ minuteMs: 1_500 });
    await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 1 });
    const script = join(repoRoot, "scripts/ci-heavy.mjs");
    const socket = join(directory, "heavy.sock");
    const ran = await exec(process.execPath, [
      script,
      "--socket",
      socket,
      "--label",
      "ok",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write('ran');process.exitCode=3",
    ]).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(ran).toMatchObject({ code: 3, stdout: "ran" });
    expect((ran as { stderr: string }).stderr).toContain("heavy permit granted");
    await eventually(async () => (await used()) === 0);
    const started = Date.now();
    const held = await exec(process.execPath, [
      script,
      "--socket",
      socket,
      "--label",
      "long",
      "--",
      process.execPath,
      "-e",
      "setInterval(()=>{},1000)",
    ]).catch((error: { code: number; stderr: string }) => error);
    expect(held).toMatchObject({ code: 1 });
    expect((held as { stderr: string }).stderr).toContain("permit lost (max_hold)");
    expect(Date.now() - started).toBeLessThan(10_000);
    await eventually(async () => (await used()) === 0);
  });

  it("refuses a symlinked or loosened permits directory instead of using it", async () => {
    const { root, directory, permits } = await fixture();
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, directory);
    expect(await permits.apply({ user: me, maxLeases: 1, maxHoldMinutes: 60 })).toMatchObject({
      enabled: true,
      listening: false,
      unavailable: "directory_not_owned",
    });
    await rm(directory);
    await mkdir(directory, { mode: 0o700 });
    await chmod(directory, 0o770);
    expect(await permits.apply({ user: me, maxLeases: 2, maxHoldMinutes: 60 })).toMatchObject({
      listening: false,
      unavailable: "directory_mode",
    });
  });
});

it("only the owner turns permits on or off, and the setting persists (#562)", async () => {
  const root = await mkdtemp(join(tmpdir(), "fhp-route-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  // Not macOS, so turning it on never touches /Users/Shared and reports why.
  const permits = createForeignHeavyPermits({
    governor: { runHeavy: async () => 0 },
    helper: "/nonexistent",
    directory: join(root, "permits"),
    platform: "linux",
  });
  cleanups.push(() => permits.close());
  let allowed: true | "forbidden" | "authentication_required" = true;
  const app = createForeignHeavyPermitsRoutes(async () => allowed, settings, permits);
  const request = (method: "GET" | "POST", body?: unknown) =>
    app.fetch(
      new Request(`http://owner.test${FOREIGN_HEAVY_PERMITS_PATH}`, {
        method,
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      }),
    );
  const on = {
    schemaVersion: 1,
    enabled: true,
    settings: { user: "clankie-ci", maxLeases: 1, maxHoldMinutes: 60 },
  };

  expect(ForeignHeavyPermitsSnapshotSchema.parse(await (await request("GET")).json())).toMatchObject({
    enabled: false,
  });
  for (const refusal of ["forbidden", "authentication_required"] as const) {
    allowed = refusal;
    expect((await request("GET")).status).toBe(refusal === "forbidden" ? 403 : 401);
    expect((await request("POST", on)).status).toBe(refusal === "forbidden" ? 403 : 401);
  }
  expect((await settings.load()).foreignHeavyPermits).toBeUndefined();

  allowed = true;
  for (const body of [
    { ...on, settings: { ...on.settings, user: "root; rm" } },
    { ...on, settings: { ...on.settings, maxLeases: 99 } },
    { schemaVersion: 1, enabled: true },
    { schemaVersion: 1, enabled: false, settings: on.settings },
  ])
    expect((await request("POST", body)).status).toBe(400);
  const enabled = await request("POST", on);
  expect(ForeignHeavyPermitsSnapshotSchema.parse(await enabled.json())).toMatchObject({
    enabled: true,
    listening: false,
    unavailable: "darwin_only",
  });
  expect((await new SettingsStore(settings.path).load()).foreignHeavyPermits).toEqual(on.settings);
  const off = await request("POST", { schemaVersion: 1, enabled: false });
  expect(ForeignHeavyPermitsSnapshotSchema.parse(await off.json())).toMatchObject({ enabled: false });
  expect((await settings.load()).foreignHeavyPermits).toBeUndefined();
});
