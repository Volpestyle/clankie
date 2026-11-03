// #641: auto-tidy removes a finished desktop hire's terminal only on the hard lines a settled
// hire closes on (#584). It rebuilds the hire from the ended terminal's labels and looks its
// keep and kept report up by session key, so those keys must be the ones PaneTidy recorded
// while the hire was live, as its own agent reported itself. End to end against a real
// herdr-core in its own session, the real desktop runner behind the fleet router, and a real
// PaneTidy journal; the owner's app and terminals are never touched.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAutoTidy } from "../src/captain/auto-tidy.ts";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { HERDR_CORE_FLEET, createHerdrCoreRunner } from "../src/captain/herdr-core-runner.ts";
import { createHerdrCoreSeats } from "../src/captain/herdr-core-seats.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";

const exec = promisify(execFile);
const hc = (process.env.PATH ?? "")
  .split(delimiter)
  .map((dir) => join(dir, "hc"))
  .concat(join(homedir(), ".local", "bin", "hc"))
  .find((path) => existsSync(path));
// Short: the session names the socket twice, and macOS caps a socket path at 103 bytes.
const session = `cl-${process.pid}`;
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !["HC_SOCKET", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"].includes(key) && !key.startsWith("HERDR_"),
    ),
  ),
  HC_SESSION: session,
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
  cwd = await mkdtemp(join(tmpdir(), "clankie-leftover-"));
  // The first hc call starts the session's own core; Clankie's client never starts one.
  await exec(hc, ["run", "--bg", "--json", "--name", "warm", "--", "sleep", "300"], { env, cwd });
});

afterAll(async () => {
  if (hc === undefined || process.platform === "win32") return;
  await exec(hc, ["server", "stop"], { env, cwd }).catch(() => undefined);
  await rm(join(stateHome, "herdr-core", session), { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

coreIt(
  "a kept or unreported finished hire keeps its terminal, matched by the records PaneTidy made while it ran",
  async () => {
    const seats = createHerdrCoreSeats({ env });
    const core = createHerdrCoreRunner({ seats, pollMs: 50 });
    const runner = routeHerdrFleets(
      {
        get: async () => {
          throw new Error("No Herdr pane in a desktop proof");
        },
        resolveTerminal: async () => undefined,
        wait: async () => {
          throw new Error("No Herdr pane in a desktop proof");
        },
        list: async () => [],
      },
      new Map([[HERDR_CORE_FLEET, core]]),
    );
    const tidy = new PaneTidy(join(cwd, "pane-tidy.json"), { runner, changed: () => {} } as never);
    const authority = {
      owner: { conversationId: "lead" },
      current: () => true,
      authorize: async () => true,
    };

    // Each hire reports itself as Claude Code does (OSC 7501), so its live snapshot names its
    // agent from that report, while the ended terminal names it from Clankie's label.
    const hire = (name: string) =>
      seats.start({
        argv: [
          process.execPath,
          "-e",
          `process.stdout.write("\\x1b]7501;state=idle:app=claude-code\\x1b\\\\"); setInterval(() => {}, 1000);`,
        ],
        cwd,
        seat: name,
        labels: { "clankie.agent": "claude", "clankie.session": `session-${name}` },
      });
    const kept = await hire("kept");
    const reported = await hire("reported");
    const silent = await hire("silent");
    const live = async (address: string) => {
      let found;
      await until(async () => {
        found = (await runner.list!(HERDR_CORE_FLEET)).find(
          (agent) => agent.terminalId === `${HERDR_CORE_FLEET}/${address}` && agent.status === "idle",
        );
        return found !== undefined;
      });
      return found!;
    };

    // While each runs: the owner keeps one, and two send the report PaneTidy keeps.
    expect(await tidy.keep({ pane: `${HERDR_CORE_FLEET}/${kept}`, keep: true }, authority)).toMatchObject({
      outcome: "kept",
    });
    tidy.keepReport(await live(kept), "done: kept for follow-up");
    tidy.keepReport(await live(reported), "done: landed");
    await live(silent);

    for (const address of [kept, reported, silent]) await seats.kill(address);
    await until(async () =>
      (await Promise.all([kept, reported, silent].map((address) => seats.get(address)))).every(
        (terminal) => terminal?.state === "finished",
      ),
    );

    const removed: string[] = [];
    const auto = createAutoTidy({
      setting: async () => "1h",
      runner: { list: async () => [] },
      // The window has passed for every terminal; only the hard lines decide.
      removeFinished: async (_ageMs, eligible) => {
        const gone = await core.removeFinished(0, eligible);
        removed.push(...gone);
        return gone;
      },
      tidy,
      provenance: () => ({ conversationId: "lead" }),
      unreadReports: () => 0,
      ownerValid: async () => true,
      closed: async () => {},
      checkouts: async () => [],
      prune: async () => {
        throw new Error("No prune in a removal proof");
      },
      stopped: () => false,
    });

    await auto.panes();
    expect(removed).toEqual([reported]);
    expect((await seats.get(kept))?.state).toBe("finished");
    expect((await seats.get(silent))?.state).toBe("finished");

    // Released, the kept hire's terminal goes too; the one that never reported still stays.
    expect(await tidy.keep({ pane: `${HERDR_CORE_FLEET}/${kept}`, keep: false }, authority)).toMatchObject({
      outcome: "released",
    });
    await auto.panes();
    expect(removed).toEqual([reported, kept]);
    expect((await seats.get(silent))?.state).toBe("finished");
    await seats.remove(silent);
  },
);
