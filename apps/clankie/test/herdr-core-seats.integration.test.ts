import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
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
const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
let cwd = "";

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((done) => setTimeout(done, 100)))
    if (await check()) return;
  throw new Error("timed out");
}

const coreIt = it.skipIf(hc === undefined || process.platform === "win32");

beforeAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  cwd = await mkdtemp(join(tmpdir(), "clankie-core-seats-"));
  // The first hc call starts the session's core, with the pane identity above in its environment.
  await exec(hc, ["run", "--bg", "--json", "--name", "warm", "--", "true"], { env, cwd });
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
  expect(address).toMatch(/^t\d+$/u);

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
