import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { PANES_PER_TAB, nameClankieTabs, type HerdrWindow } from "../src/captain/herdr-window.ts";

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
// inherits that pane's identity unless the run clears it. It also carries a Codex shell
// tool's colorless settings, as a core started by a Codex worker does.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"].includes(key) && !key.startsWith("HERDR_"),
    ),
  ),
  HC_SESSION: session,
  // The core's own stitch deadline, longer than the 5 s every other core call gets (#243).
  HC_STITCH_MS: "8000",
  HERDR_PANE_ID: "w9:p9",
  HERDR_SOCKET_PATH: "/nowhere/herdr.sock",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  COLORTERM: "",
  TERM: "dumb",
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
const herdr = (process.env.PATH ?? "")
  .split(delimiter)
  .map((dir) => join(dir, "herdr"))
  .find((path) => existsSync(path));
// A desktop hire beside a private legacy Herdr server needs both binaries.
const coreAndHerdrIt = it.skipIf(hc === undefined || herdr === undefined || process.platform === "win32");

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
        `const keys = ["HC_TERMINAL_ID", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "CLANKIE_PROBE", "NO_COLOR", "FORCE_COLOR", "COLORTERM", "TERM"];`,
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
  expect(seen).toMatchObject({ COLORTERM: "truecolor", TERM: "xterm-256color" });
  expect(seen.NO_COLOR ?? "").toBe("");
  expect(seen.FORCE_COLOR ?? "").toBe("");

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

// The desktop app tells its own Mac terminals that Herdr Browser is there; a hire gets the
// same, only when the browser is installed, and its own run's values still win (#697).
it.skipIf(hc === undefined || process.platform !== "darwin")(
  "a Mac hire learns Herdr Browser is there only when it is installed",
  async () => {
    const browserBin = join(cwd, "browser-bin");
    await mkdir(browserBin, { recursive: true });
    await writeFile(join(browserBin, "herdr-browser-open"), "#!/bin/sh\nexit 0\n");
    await chmod(join(browserBin, "herdr-browser-open"), 0o755);
    const keys = ["HERDR_BROWSER", "BROWSER"];
    const seen = async (seatEnv: NodeJS.ProcessEnv, name: string, runEnv?: Record<string, string>) => {
      const report = join(cwd, `${name}.json`);
      const seats = createHerdrCoreSeats({ env: seatEnv });
      const address = await seats.start({
        argv: [
          process.execPath,
          "-e",
          [
            `const keys = ${JSON.stringify(keys)};`,
            `require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));`,
            `setInterval(() => {}, 1000);`,
          ].join("\n"),
        ],
        cwd,
        ...(runEnv === undefined ? {} : { env: runEnv }),
        seat: name,
      });
      try {
        await until(async () => existsSync(report));
        return JSON.parse(await readFile(report, "utf8")) as Record<string, string | null>;
      } finally {
        await seats.kill(address);
      }
    };
    const plain = "/usr/bin:/bin";
    expect(await seen({ ...env, PATH: `${browserBin}${delimiter}${plain}` }, "browser-on")).toEqual({
      HERDR_BROWSER: "1",
      BROWSER: "herdr-browser-open",
    });
    const off = await seen({ ...env, PATH: plain }, "browser-off");
    expect(off.HERDR_BROWSER ?? "").toBe("");
    expect(off.BROWSER ?? "").not.toBe("herdr-browser-open");
    expect(
      await seen({ ...env, PATH: `${browserBin}${delimiter}${plain}` }, "browser-own", {
        HERDR_BROWSER: "",
        BROWSER: "open",
      }),
    ).toMatchObject({ BROWSER: "open" });
  },
);

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
  expect(seen).toMatchObject({ paneId: address, terminalId: address });
  // The label the app shows names no seat; only the agent name a hire's start gives does (#208).
  expect(seen.name).toBeUndefined();
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
  // A closed hire leaves the window too: the core keeps an ended terminal until it is removed (#584).
  expect(await seats.get(address)).toBeUndefined();
  expect((await seats.finished()).map((terminal) => terminal.address)).not.toContain(address);
});

coreIt(
  "a finished hire's terminal leaves the window after its window, only when Clankie recorded it",
  async () => {
    const seats = createHerdrCoreSeats({ env });
    const runner = createHerdrCoreRunner({ seats, pollMs: 50 });
    const hire = (seat: string, session: string) =>
      seats.start({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000);"],
        cwd,
        seat,
        labels: { "clankie.agent": "claude", "clankie.session": session },
      });
    const recorded = await hire("recorded", "session-recorded");
    const stranger = await hire("stranger", "session-stranger");
    // The owner's own terminal, ended: never Clankie's to remove.
    const own = (
      JSON.parse(
        (await exec(hc!, ["run", "--bg", "--json", "--name", "owners", "--", "true"], { env, cwd })).stdout,
      ) as { address: string }
    ).address;
    for (const address of [recorded, stranger]) await seats.kill(address);
    await until(async () =>
      (await Promise.all([recorded, stranger, own].map((address) => seats.get(address)))).every(
        (terminal) => terminal?.state === "finished",
      ),
    );
    const hired = ({ seatId, agent, session }: { seatId: string; agent: string; session: string }) =>
      seatId === `herdr-core/${recorded}` && agent === "claude" && session === "session-recorded";

    // Not yet past the window: everything stays.
    expect(await runner.removeFinished(60 * 60_000, hired)).toEqual([]);
    expect(await runner.removeFinished(0, hired)).toEqual([recorded]);
    expect(await seats.get(recorded)).toBeUndefined();
    // A label alone proves nothing, and the owner's terminal is his.
    expect((await seats.get(stranger))?.state).toBe("finished");
    expect((await seats.get(own))?.state).toBe("finished");
    for (const address of [stranger, own]) await seats.remove(address);
  },
);

// #291: the desktop app's core can only override a variable, never unset it, and an empty
// HERDR_SOCKET_PATH made the stock `herdr` CLI fail in every desktop hire. A hire now gets
// Clankie's own Herdr session socket, so the CLI works there, and its worker still names its
// seat from the core. The legacy Herdr here is a private server, never the owner's.
coreAndHerdrIt(
  "a desktop hire's herdr CLI reaches Clankie's Herdr while its worker keeps its core seat",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-hire-herdr-"));
    const herdrEnv: NodeJS.ProcessEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_"))),
      HERDR_SOCKET_PATH: join(root, "herdr.sock"),
      HERDR_CONFIG_PATH: join(root, "config/config.toml"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      SHELL: "/bin/sh",
    };
    const server = spawn(herdr!, ["server"], { env: herdrEnv, stdio: "ignore" });
    try {
      await until(async () => existsSync(herdrEnv.HERDR_SOCKET_PATH!));
      const seats = createHerdrCoreSeats({ env, herdrSocket: herdrEnv.HERDR_SOCKET_PATH! });
      const report = join(root, "hire.json");
      const address = await seats.start({
        argv: [
          process.execPath,
          "--input-type=module",
          "-e",
          [
            `const { seatIdentity } = await import(${JSON.stringify(workerLink)});`,
            `const { spawnSync } = await import("node:child_process");`,
            // The stock CLI, as a hire's shell runs it: no flags, only the terminal's environment.
            `const listed = spawnSync(${JSON.stringify(herdr)}, ["pane", "list"], { encoding: "utf8" });`,
            `(await import("node:fs")).writeFileSync(${JSON.stringify(report)}, JSON.stringify({`,
            `  identity: seatIdentity(), status: listed.status, stdout: listed.stdout, stderr: listed.stderr,`,
            `  socket: process.env.HERDR_SOCKET_PATH, pane: process.env.HERDR_PANE_ID, herdrEnv: process.env.HERDR_ENV }));`,
            `setInterval(() => {}, 1000);`,
          ].join("\n"),
        ],
        cwd,
        // The probe's own Herdr client log stays in the scratch root.
        env: { XDG_CONFIG_HOME: herdrEnv.XDG_CONFIG_HOME!, XDG_STATE_HOME: herdrEnv.XDG_STATE_HOME! },
        seat: "linus",
      });
      try {
        await until(async () => existsSync(report), 20_000);
        const seen = JSON.parse(await readFile(report, "utf8")) as {
          identity: { pane?: string; socket?: string };
          status: number | null;
          stdout: string;
          stderr: string;
          socket?: string;
          pane?: string;
          herdrEnv?: string;
        };
        expect(seen.socket).toBe(herdrEnv.HERDR_SOCKET_PATH);
        expect(seen.pane ?? "").toBe("");
        // Herdr's own in-pane reporting stays off: a desktop hire is no Herdr pane.
        expect(seen.herdrEnv ?? "").toBe("");
        expect(seen.status, seen.stderr).toBe(0);
        expect(JSON.parse(seen.stdout)).toMatchObject({ result: { type: "pane_list" } });
        expect(seen.identity.pane).toBe(`herdr-core/${address}`);
        expect(seen.identity.socket).not.toBe(herdrEnv.HERDR_SOCKET_PATH);
        expect(seen.identity.socket).toMatch(/\.sock$/u);
      } finally {
        await seats.kill(address);
      }
    } finally {
      await exec(herdr!, ["server", "stop"], { env: herdrEnv }).catch(() => server.kill("SIGKILL"));
      await rm(root, { recursive: true, force: true });
    }
  },
);

coreIt("each desktop hire gets its own named tab in its project's space, never one shared tab", async () => {
  const seats = createHerdrCoreSeats({ env });
  // The open window as `herdr-app ls` shows it: it places terminals by their labels, and a
  // space or tab it makes for them is unnamed (a folder, a number) until renamed.
  const renamed = new Map<string, string>();
  const window: HerdrWindow = {
    ls: async () => {
      const spaces = new Map<string, { id: string; name: string; tabs: { id: string; name: string }[] }>();
      for (const terminal of await seats.list()) {
        const space = terminal.labels["herdr.space"];
        const tab = terminal.labels["herdr.tab"];
        if (terminal.state !== "live" || space === undefined || tab === undefined) continue;
        const shown = spaces.get(space) ?? {
          id: space,
          name: renamed.get(space) ?? basename(terminal.cwd ?? "~"),
          tabs: [],
        };
        if (!shown.tabs.some((t) => t.id === tab))
          shown.tabs.push({ id: tab, name: renamed.get(tab) ?? String(shown.tabs.length + 1) });
        spaces.set(space, shown);
      }
      return [...spaces.values()];
    },
    rename: async (_kind, id, name) => {
      renamed.set(id, name);
      return true;
    },
  };
  const runner = createHerdrCoreRunner({ seats, window, launchDirectory: join(cwd, "placed"), pollMs: 50 });
  const work = await mkdtemp(join(cwd, "wt-clankie-"));
  const hires = [
    await runner.createTab({ cwd: work, label: "Ari · fix login", project: "clankie", harness: "claude" }),
    await runner.createTab({ cwd: work, label: "Mei · fix login", project: "clankie", harness: "claude" }),
  ];
  const piped = [];
  for (let i = 0; i < 4; i += 1)
    piped.push(
      await runner.createTab({
        cwd: work,
        label: `p${i}`,
        project: "clankie",
        pipeline: "review",
        harness: "claude",
      }),
    );
  const labels = async (address: string) => (await seats.get(address))!.labels;
  const [ari, mei] = await Promise.all(hires.map(labels));
  // One space per project, one tab per hire, even when two hires share a task name.
  expect(ari!["herdr.space"]).toBe("clankie-clankie");
  expect(mei!["herdr.space"]).toBe("clankie-clankie");
  expect(ari!["herdr.tab"]).not.toBe(mei!["herdr.tab"]);
  // A pipeline's hires share a tab a few at a time, then open its next one.
  const tabs = await Promise.all(piped.map(async (address) => (await labels(address))["herdr.tab"]));
  expect(new Set(tabs.slice(0, PANES_PER_TAB)).size).toBe(1);
  expect(tabs[PANES_PER_TAB]).not.toBe(tabs[0]);
  // The window names the space for the project and each tab for its hire.
  await until(async () => renamed.get(ari!["herdr.tab"]!) === "Ari · fix login");
  await until(async () => renamed.get(tabs[PANES_PER_TAB]!) === "review · 2");
  expect(renamed.get("clankie-clankie")).toBe("clankie workers");
  expect(renamed.get(mei!["herdr.tab"]!)).toBe("Mei · fix login");
  expect(renamed.get(tabs[0]!)).toBe("review");
  // A name the owner gave is never overwritten.
  renamed.set(ari!["herdr.tab"]!, "my tab");
  expect(await nameClankieTabs(seats, window)).toBe(0);
  expect(renamed.get(ari!["herdr.tab"]!)).toBe("my tab");
  for (const address of [...hires, ...piped]) await runner.closePane(address);
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
  expect(await runner.get(address)).toMatchObject({ status: "unknown" });
  expect((await runner.get(address)).name).toBeUndefined();
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
    name: "ada",
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

coreIt(
  "a history read of an idle full-screen agent waits out the core's stitch instead of timing out (#243)",
  async () => {
    const seats = createHerdrCoreSeats({ env });
    const address = await seats.start({
      argv: [process.execPath, fileURLToPath(new URL("./fixtures/stitched-tui.mjs", import.meta.url))],
      cwd,
      env: {},
      seat: "scroller",
    });
    await until(async () => (await seats.read(address, 0)).includes("history line 1999"));
    // The core scrolls the app to read its history; with an 8 s stitch deadline that
    // takes longer than the 5 s every core call used to get, and the read still answers.
    const started = Date.now();
    const text = await seats.read(address, 2_000);
    expect(Date.now() - started).toBeGreaterThan(5_000);
    expect(text).toContain("history line 1999");
    // Every other call keeps its short budget and answers at once.
    const screenStarted = Date.now();
    expect(await seats.read(address, 0)).toContain("history line 1999");
    expect(Date.now() - screenStarted).toBeLessThan(2_000);
    await seats.kill(address);
  },
  60_000,
);
