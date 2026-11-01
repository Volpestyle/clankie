// A desktop-app seat's project proof (ADR 0319) at the real kernel and TCP boundary:
// the native helper observes an actual harness process and its socket-holding child.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { readDesktopSeat } from "../src/captain/herdr-core-runner.ts";
import { localProjectProof } from "../src/local-fleet-proof.ts";
import { createProjectProcessObserver } from "../src/project-process-proof.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const script = fileURLToPath(new URL("./fixtures/desktop-seat-proof/harness.mjs", import.meta.url));
const helper = fleetProcessHelper(checkout);
// Like the other native proofs, it runs where the helper can read same-user processes'
// descriptors: FLEET_PROOF_NATIVE_TEST=1 on a Mac or an unconfined Linux host.
const proofIt = it.skipIf(
  !["darwin", "linux"].includes(process.platform) ||
    process.env.FLEET_PROOF_NATIVE_TEST !== "1" ||
    !existsSync(helper),
);

// Reading a same-user process's identity, as a hire's proof does, needs no descriptors.
const processIt = it.skipIf(!["darwin", "linux"].includes(process.platform) || !existsSync(helper));

const server = createServer();
const accepted: Socket[] = [];
server.on("connection", (socket) => accepted.push(socket));
let harness: ReturnType<typeof spawn> | undefined;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
});
afterAll(async () => {
  harness?.stdin?.end();
  for (const socket of accepted) socket.destroy();
  server.close();
  await closeNativeProcessObservers();
});

proofIt("proves a desktop-app seat from Clankie's record of its harness, not its labels", async () => {
  const port = (server.address() as { port: number }).port;
  harness = spawn(process.execPath, [script, String(port)], { stdio: ["pipe", "pipe", "inherit"] });
  await once(harness.stdout!, "data");
  const socket = accepted.at(-1)!;
  const binding = { runtime: "external" as const, session: "herdr-core", socketPath: "/tmp/core.sock" };
  let record = { pid: harness.pid!, agent: "claude", session: "0b9f3c5e-1d2a-4c8b-9e7f-6a5b4c3d2e1f" };
  const prove = localProjectProof({
    herdrBinary: "herdr",
    processHelper: helper,
    binding: async () => undefined,
    coreBinding: async () => binding,
    coreSeat: async (_binding, address) => (address === "t3" ? record : null),
    launcher: async () => ({ executable: await realpath(process.execPath), script }),
  });

  const proof = await prove(socket, "herdr-core/t3");
  expect(proof).toMatchObject({
    fleet: "default",
    pane: "herdr-core/t3",
    nativeOccupantId: occupantIdForHerdrSession({
      source: "herdr:claude",
      kind: "id",
      value: record.session,
    }),
    binding: { socketPath: binding.socketPath, session: "herdr-core" },
    processes: [{ pid: harness.pid }],
  });
  expect(proof?.nativeSessionPending).toBeUndefined();

  // Another terminal's address, or a record that no longer names this harness, proves nothing.
  expect(await prove(socket, "herdr-core/t4")).toBeUndefined();
  record = { ...record, pid: process.pid };
  expect(await prove(socket, "herdr-core/t3")).toBeUndefined();
  // Nor does a launcher other than the installed harness.
  record = { ...record, pid: harness.pid! };
  const elsewhere = localProjectProof({
    herdrBinary: "herdr",
    processHelper: helper,
    binding: async () => undefined,
    coreBinding: async () => binding,
    coreSeat: async () => record,
    launcher: async () => ({ executable: "/usr/local/bin/claude" }),
  });
  expect(await elsewhere(socket, "herdr-core/t3")).toBeUndefined();
});

processIt("proves a desktop-app hire when Clankie confirms it, the way a pane hire is proven", async () => {
  // A hire's own check runs before its worker has said anything, so no socket is involved:
  // only the core's terminal, Clankie's record of it, and the kernel's view of its process.
  const seat = spawn(process.execPath, [script, "9"], { stdio: ["pipe", "ignore", "ignore"] });
  await once(seat, "spawn");
  const records = await mkdtemp(join(tmpdir(), "desktop-seats-"));
  try {
    const binding = { runtime: "external" as const, session: "herdr-core", socketPath: "/tmp/core.sock" };
    const session = "0b9f3c5e-1d2a-4c8b-9e7f-6a5b4c3d2e1f";
    let record = { pid: seat.pid!, agent: "claude", session };
    // Herdr counts terminals past t29 as t2a, t2b, ...: a lettered address is a desktop terminal
    // too, from the proof through Clankie's own record file of it.
    const keep = async () => writeFile(join(records, "t2c.json"), JSON.stringify(record));
    await keep();
    const observe = (launcher: { executable: string; script?: string }) =>
      createProjectProcessObserver({
        binding: async () => undefined,
        herdrBinary: "herdr",
        processHelper: helper,
        coreBinding: async () => binding,
        coreSeat: async (_binding, address) => (await readDesktopSeat(records, address)) ?? null,
        launcher: async () => launcher,
      });
    const installed = observe({ executable: await realpath(process.execPath), script });

    // The proof a hire waits on names the same occupant its own session does.
    expect(await installed("default", "herdr-core/t2c")).toMatchObject({
      fleet: "default",
      pane: "herdr-core/t2c",
      nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:claude", kind: "id", value: session }),
      binding: { socketPath: binding.socketPath, session: "herdr-core" },
      shell: { pid: process.pid },
      processes: [{ pid: seat.pid }],
    });

    // Another terminal, another machine, a record naming another process, or a launcher
    // other than the installed harness proves nothing.
    expect(await installed("default", "herdr-core/t2d")).toBeUndefined();
    expect(await installed("pc", "herdr-core/t2c")).toBeUndefined();
    expect(
      await observe({ executable: "/usr/local/bin/claude" })("default", "herdr-core/t2c"),
    ).toBeUndefined();
    record = { ...record, pid: process.pid };
    await keep();
    expect(await installed("default", "herdr-core/t2c")).toBeUndefined();
    // Without the core wired in, a desktop pane is out of scope, as before.
    const paneOnly = createProjectProcessObserver({ binding: async () => binding, herdrBinary: "herdr" });
    expect(await paneOnly("default", "herdr-core/t2c")).toBeUndefined();
  } finally {
    seat.stdin?.end();
    seat.kill();
    await rm(records, { recursive: true, force: true });
  }
});

processIt(
  "a hire proven in the instant its launcher is still exec'ing the harness waits for the exec",
  async () => {
    // The desktop terminal's launcher is a shell that execs the harness in place once Clankie
    // hands it the command. A proof that lands before the exec sees the shell in the harness's
    // process; it looks again briefly instead of refusing a hire that is about to run.
    const records = await mkdtemp(join(tmpdir(), "desktop-exec-"));
    const handoff = join(records, "launch.sh");
    const launcher = `while [ ! -f "$1" ]; do sleep 0.05; done; exec "${process.execPath}" "${script}" 9`;
    const seat = spawn("/bin/sh", ["-c", launcher, "clankie-seat", handoff], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const never = spawn("/bin/sh", ["-c", "sleep 30; :"], { stdio: "ignore" });
    await Promise.all([once(seat, "spawn"), once(never, "spawn")]);
    try {
      const binding = { runtime: "external" as const, session: "herdr-core", socketPath: "/tmp/core.sock" };
      const session = "6c1f1e7a-2b90-4c2b-9d0e-0b3c4e9a6f61";
      await writeFile(
        join(records, "t2k.json"),
        JSON.stringify({ pid: seat.pid!, agent: "claude", session }),
      );
      await writeFile(
        join(records, "t2l.json"),
        JSON.stringify({ pid: never.pid!, agent: "claude", session }),
      );
      const observe = createProjectProcessObserver({
        binding: async () => undefined,
        herdrBinary: "herdr",
        processHelper: helper,
        coreBinding: async () => binding,
        coreSeat: async (_binding, address) => (await readDesktopSeat(records, address)) ?? null,
        launcher: async () => ({ executable: await realpath(process.execPath), script }),
      });

      const proving = observe("default", "herdr-core/t2k");
      setTimeout(() => void writeFile(handoff, ""), 400);
      expect(await proving).toMatchObject({ pane: "herdr-core/t2k", processes: [{ pid: seat.pid }] });

      // A shell that never execs the installed harness is still refused once the brief wait ends.
      expect(await observe("default", "herdr-core/t2l")).toBeUndefined();
    } finally {
      seat.stdin?.end();
      seat.kill();
      never.kill();
      await rm(records, { recursive: true, force: true });
    }
  },
);
