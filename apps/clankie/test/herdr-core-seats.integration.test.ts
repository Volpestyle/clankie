import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { realpath } from "node:fs/promises";
import { occupantIdForHerdrSession, readFleet } from "../src/captain/herdr-census.ts";
import {
  createHerdrCoreRunner,
  herdrCoreCensusFleet,
  liveDesktopSeat,
  readDesktopSeat,
} from "../src/captain/herdr-core-runner.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";
import { createProjectProcessObserver } from "../src/project-process-proof.ts";
import { CLANKIE_SPACE, SEAT_LABEL, createHerdrCoreSeats } from "../src/captain/herdr-core-seats.ts";

// A hire's terminal in the Herdr desktop app (ADR 0319), end to end against a real
// herdr-core: started in Clankie's space, read back, and ended. The test runs its own
// core session, so the owner's app and its terminals are never touched.

const exec = promisify(execFile);
const hc = (process.env.PATH ?? "")
  .split(delimiter)
  .map((dir) => join(dir, "hc"))
  .concat(join(homedir(), ".local", "bin", "hc"))
  .find((path) => existsSync(path));
// Short: the session names the socket twice, and macOS caps a socket path at 103 bytes.
const session = `cs-${process.pid}`;
// Its own session and none of a calling hc terminal's identity, but a Herdr pane's: the
// owner's core on the Mac was started from a Herdr pane, and every terminal it starts
// inherits that pane's identity unless the run clears it.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"].includes(key) && !key.startsWith("HERDR_"),
    ),
  ),
  HC_SESSION: session,
  HERDR_PANE_ID: "w9:p9",
  HERDR_SOCKET_PATH: "/nowhere/herdr.sock",
};
const workerLink = resolve(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/link.mjs");
const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
let cwd = "";
let warm = "";

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 100)))
    if (await check()) return;
  throw new Error("timed out");
}

const coreIt = it.skipIf(hc === undefined || process.platform === "win32");

beforeAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  cwd = await mkdtemp(join(tmpdir(), "clankie-core-seats-"));
  // A stand-in for the owner's `claude`, on the PATH the core starts its terminals with:
  // it reports what it was started with and stays up, as an interactive harness does.
  const bin = join(cwd, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "claude"),
    [
      `#!${process.execPath}`,
      `require("node:fs").writeFileSync(${JSON.stringify(join(cwd, "claude.json"))}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() }));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  await chmod(join(bin, "claude"), 0o755);
  env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
  // The first hc call starts the session's core, with the pane identity above in its environment.
  const started = await exec(hc, ["run", "--bg", "--json", "--name", "warm", "--", "sleep", "300"], {
    env,
    cwd,
  });
  warm = (JSON.parse(started.stdout) as { address: string }).address;
});

afterAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  await exec(hc, ["server", "stop"], { env, cwd }).catch(() => undefined);
  await rm(join(stateHome, "herdr-core", session), { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

coreIt("a hire starts in Clankie's space with its own identity, and ends when Clankie ends it", async () => {
  const seats = createHerdrCoreSeats({ env });
  expect(await seats.available()).toBe(true);
  expect(await createHerdrCoreSeats({ socketPath: join(cwd, "none.sock") }).available()).toBe(false);

  const report = join(cwd, "env.json");
  const address = await seats.start({
    argv: [
      process.execPath,
      "-e",
      [
        `const keys = ["HC_TERMINAL_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "CLANKIE_PROBE"];`,
        `require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    ],
    cwd,
    env: { CLANKIE_PROBE: "brief-1" },
    seat: "ada",
  });
  expect(address).toMatch(/^t[0-9a-z]+$/u);

  await until(async () => existsSync(report));
  const seen = JSON.parse(await readFile(report, "utf8")) as Record<string, string | null>;
  expect(seen.HC_TERMINAL_ID).toBe(address);
  expect(seen.CLANKIE_PROBE).toBe("brief-1");
  expect(seen.HERDR_PANE_ID ?? "").toBe("");
  expect(seen.HERDR_SOCKET_PATH ?? "").toBe("");

  const live = await seats.get(address);
  expect(live?.state).toBe("live");
  expect(live?.labels).toMatchObject({
    "herdr.space": CLANKIE_SPACE,
    "herdr.tab": "ada",
    [SEAT_LABEL]: "ada",
  });

  await seats.kill(address);
  await until(async () => (await seats.get(address))?.state !== "live");
  await seats.kill(address);
  expect(await seats.get("t999999")).toBeUndefined();
});

coreIt("Clankie reads, waits on and closes his own hire, and its worker knows its seat", async () => {
  const seats = createHerdrCoreSeats({ env });
  const runner = createHerdrCoreRunner({ seats, pollMs: 50 });
  const report = join(cwd, "seat.json");
  const keysReport = join(cwd, "keys.hex");
  const address = await seats.start({
    argv: [
      process.execPath,
      "--input-type=module",
      "-e",
      [
        `const { seatIdentity } = await import(${JSON.stringify(workerLink)});`,
        `(await import("node:fs")).writeFileSync(${JSON.stringify(report)}, JSON.stringify(seatIdentity()));`,
        `console.log("hello from the desktop app");`,
        // It records the bytes each key press reaches it as.
        `const fs = await import("node:fs");`,
        `process.stdin.setRawMode?.(true);`,
        `let pressed = "";`,
        `process.stdin.on("data", (bytes) => fs.writeFileSync(${JSON.stringify(keysReport)}, (pressed += bytes.toString("hex"))));`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    ],
    cwd,
    seat: "grace",
  });

  await until(async () => existsSync(report));
  // A hire's worker names its seat the way Clankie routes it, through the core's own socket.
  const identity = JSON.parse(await readFile(report, "utf8")) as { pane?: string; socket?: string };
  expect(identity.pane).toBe(`herdr-core/${address}`);
  expect(identity.socket).toMatch(/\.sock$/u);

  const seen = await runner.get(address);
  expect(seen).toMatchObject({ paneId: address, terminalId: address, name: "grace" });
  expect(seen.status).not.toBe("offline");
  await until(async () =>
    (await runner.readPane(address, "visible", "text")).includes("hello from the desktop app"),
  );

  // Named keys reach his own hire as the bytes a real terminal sends (ADR 0323).
  await runner.sendKeys!(address, ["up", "ctrl+c", "a"]);
  await until(async () => existsSync(keysReport) && (await readFile(keysReport, "utf8")).endsWith("61"));
  expect(await readFile(keysReport, "utf8")).toBe("1b5b410361");

  // A terminal the owner started is never his to drive.
  await expect(runner.sendKeys!(warm, ["ctrl+c"])).rejects.toThrow();
  expect(await runner.resolveTerminal(warm)).toBeUndefined();
  await expect(runner.get(warm)).rejects.toThrow();
  await runner.closePane(warm);
  expect((await seats.get(warm))?.state).toBe("live");

  await runner.closePane(address);
  const ended = await runner.wait(address, AbortSignal.timeout(10_000));
  expect(ended.status).toBe("offline");
});

coreIt("Clankie hires Claude into a desktop-app terminal without typing into it", async () => {
  const seats = createHerdrCoreSeats({ env });
  const runner = createHerdrCoreRunner({
    seats,
    launchDirectory: join(cwd, "launches"),
    seatDirectory: join(cwd, "seats"),
    turn: () => undefined,
    pollMs: 50,
  });
  const work = await mkdtemp(join(cwd, "work-"));
  const address = await runner.createTab({ cwd: work, label: "ada · fix the login", harness: "claude" });
  expect(address).toMatch(/^t[0-9a-z]+$/u);
  // Waiting at the launcher, the terminal is Clankie's but holds no harness yet.
  expect(await runner.get(address)).toMatchObject({ name: "ada · fix the login", status: "unknown" });
  expect(await runner.paneShell!(address)).toEqual({ foreground: [] });

  const session = "0b9f3c5e-1d2a-4c8b-9e7f-6a5b4c3d2e1f";
  await runner.startAgent({
    name: "ada",
    kind: "claude",
    paneId: address,
    args: ["--session-id", session, "--append-system-prompt-file", "it's here.md"],
  });
  // The start returns only once the launcher took its handoff, so the session it names is
  // never seen while the terminal's process is still the launcher (a proof would refuse it).
  expect(await readdir(join(cwd, "launches"))).toEqual([]);
  const report = join(cwd, "claude.json");
  await until(async () => existsSync(report));
  const started = JSON.parse(await readFile(report, "utf8")) as { pid: number; argv: string[]; cwd: string };
  expect(started.argv).toEqual(["--session-id", session, "--append-system-prompt-file", "it's here.md"]);
  // The harness took the launcher's place: the terminal's own process is Claude.
  expect((await seats.get(address))?.pid).toBe(started.pid);
  expect(await runner.get(address)).toMatchObject({
    agent: "claude",
    status: "idle",
    session: { kind: "id", value: session },
  });
  // An agent read finds the harness as the terminal's own process, with no shell under it.
  expect(await runner.paneShell!(address)).toEqual({
    shellPid: started.pid,
    foreground: [{ pid: started.pid, name: "claude" }],
  });
  // The handoff is gone once the harness started, and the directory is the service's alone.
  await until(async () => (await readdir(join(cwd, "launches"))).length === 0);
  expect((await stat(join(cwd, "launches"))).mode & 0o777).toBe(0o700);

  // Clankie's own record of the seat, which its proof trusts over the terminal's labels.
  expect(await readDesktopSeat(join(cwd, "seats"), address)).toEqual({
    pid: started.pid,
    agent: "claude",
    session,
  });

  // The proof a project hire waits on before its brief: the service's own observer, against
  // this real terminal and record, must name the occupant the hire's session names.
  const helper = fleetProcessHelper(resolve(import.meta.dirname, "../../.."));
  if (existsSync(helper)) {
    const binding = { runtime: "external" as const, session: "herdr-core", socketPath: join(cwd, "unused") };
    const proof = await createProjectProcessObserver({
      binding: async () => undefined,
      herdrBinary: "herdr",
      processHelper: helper,
      coreBinding: async () => binding,
      coreSeat: (_binding, seat) => liveDesktopSeat(seats, join(cwd, "seats"), seat),
      launcher: async () => ({
        executable: await realpath(process.execPath),
        script: await realpath(join(cwd, "bin", "claude")),
      }),
    })("default", `herdr-core/${address}`);
    const hired = await runner.get(address);
    expect(proof).toMatchObject({
      fleet: "default",
      pane: `herdr-core/${address}`,
      nativeOccupantId: occupantIdForHerdrSession(hired.session!),
      processes: [{ pid: started.pid }],
    });
  }

  // A seat in Clankie's fleet like a Herdr pane's, under the id he routes it by, so an app
  // lists it as an agent it can message. The owner's own terminal is never seated.
  const fleet = await readFleet({
    localAvailable: false,
    fleets: [herdrCoreCensusFleet(runner, () => seats.available())],
  });
  expect(fleet.seats).toEqual([
    expect.objectContaining({
      seatId: `herdr-core/${address}`,
      paneId: `herdr-core/${address}`,
      fleet: "herdr-core",
      harness: "claude",
      session: { source: "herdr:claude", kind: "id", value: session },
    }),
  ]);
  // No desktop app running is an empty fleet, not a machine that stopped answering.
  const none = createHerdrCoreSeats({ socketPath: join(cwd, "none.sock") });
  expect(
    await herdrCoreCensusFleet(createHerdrCoreRunner({ seats: none }), () => none.available()).run([
      "agent",
      "list",
    ]),
  ).toBe(JSON.stringify({ result: { agents: [] } }));

  await expect(runner.startAgent({ name: "ada", kind: "claude", paneId: address })).rejects.toThrow();
  await runner.closePane(address);
  expect(await readDesktopSeat(join(cwd, "seats"), address)).toBeUndefined();

  // A resumed hire keeps the session it resumes.
  const resumed = await runner.createTab({ cwd: work, label: "ada · fix the login", harness: "claude" });
  await runner.startAgent({ name: "ada", kind: "claude", paneId: resumed, args: ["--resume", session] });
  await until(async () => (await runner.get(resumed)).agent === "claude");
  expect(await runner.get(resumed)).toMatchObject({ session: { kind: "id", value: session } });
  await runner.closePane(resumed);
});

coreIt(
  "a desktop hire runs the installed harness its proof checks, whatever the terminal's PATH finds",
  async () => {
    // An npm install's `claude` is a `#!/usr/bin/env node` script. Found on the terminal's
    // PATH, the kernel would show a bare `node` and another install than the service's; the
    // hire instead execs the service's own interpreter and script.
    const installed = join(cwd, "installed");
    await mkdir(installed, { recursive: true });
    const script = join(installed, "claude");
    const report = join(cwd, "installed.json");
    await writeFile(
      script,
      [
        "#!/usr/bin/env node",
        `require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }));`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
    await chmod(script, 0o755);
    const launcher = { executable: await realpath(process.execPath), script: await realpath(script) };
    const seats = createHerdrCoreSeats({ env });
    const runner = createHerdrCoreRunner({
      seats,
      launchDirectory: join(cwd, "launches"),
      seatDirectory: join(cwd, "seats"),
      harnessCommand: async () => [launcher.executable, launcher.script],
      turn: () => undefined,
      pollMs: 50,
    });
    const address = await runner.createTab({ cwd, label: "lin · installed", harness: "claude" });
    const session = "4a457b97-a162-4400-9e46-e66534b64c91";
    await runner.startAgent({
      name: "lin",
      kind: "claude",
      paneId: address,
      args: ["--session-id", session],
    });
    await until(async () => existsSync(report));
    const started = JSON.parse(await readFile(report, "utf8")) as { pid: number; argv: string[] };
    expect(started.argv).toEqual(["--session-id", session]);
    expect((await seats.get(address))?.pid).toBe(started.pid);

    const helper = fleetProcessHelper(resolve(import.meta.dirname, "../../.."));
    if (existsSync(helper)) {
      const binding = {
        runtime: "external" as const,
        session: "herdr-core",
        socketPath: join(cwd, "unused"),
      };
      const proof = await createProjectProcessObserver({
        binding: async () => undefined,
        herdrBinary: "herdr",
        processHelper: helper,
        coreBinding: async () => binding,
        coreSeat: (_binding, seat) => liveDesktopSeat(seats, join(cwd, "seats"), seat),
        launcher: async () => launcher,
      })("default", `herdr-core/${address}`);
      expect(proof).toMatchObject({ pane: `herdr-core/${address}`, processes: [{ pid: started.pid }] });
    }
    await runner.closePane(address);
  },
);
