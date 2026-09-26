import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createHerdrWatchRunner,
  HerdrWatchStore,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeHerdr(start: string) {
  const root = await mkdtemp(join(tmpdir(), "clankie-herdr-start-"));
  roots.push(root);
  await writeFile(
    join(root, "herdr"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const root = ${JSON.stringify(root)};
fs.appendFileSync(root + "/calls", JSON.stringify(args) + "\\n");
if (args[0] === "agent" && args[1] === "start") { ${start} }
else if (args[0] === "tab") console.log(JSON.stringify({result:{root_pane:{pane_id:"w1:p1"}}}));
else if (args[0] === "agent" && args[1] === "get") console.log(JSON.stringify({result:{agent:{
  pane_id:"w1:p1", terminal_id:"term_pi", agent:"pi", agent_status:"idle",
  agent_session:{source:"herdr:pi",kind:"path",value:root+"/not-written-until-first-turn.jsonl"}
}}}));
else console.log("{}");
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${root}${delimiter}${process.env.PATH ?? ""}`);
  const runner = createHerdrWatchRunner();
  // Integration installation is unrelated to the process startup deadline.
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner: { ...runner, installPiIntegration: async () => undefined },
  });
  return {
    root,
    store,
    calls: async () =>
      (await readFile(join(root, "calls"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

it("lets Herdr report a pi session after the short command deadline, without restarting the agent", async () => {
  const fake = await fakeHerdr('setTimeout(() => console.log("{}"), 5500);');
  try {
    const result = await fake.store.spawnSeat({
      schemaVersion: 1,
      harness: "pi",
      title: "Slow pi",
      workingDirectory: fake.root,
    });
    expect(result).toMatchObject({ outcome: "spawned", seat: { harness: "pi", seatId: "term_pi" } });
    const calls = await fake.calls();
    const starts = calls.filter((args) => args[0] === "agent" && args[1] === "start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual(expect.arrayContaining(["--timeout", "30000"]));
    expect(calls.some((args) => args[0] === "pane" && args[1] === "close")).toBe(false);
  } finally {
    fake.store.close();
  }
}, 15_000);

it("returns a typed not_ready failure and closes its pane when Herdr's bounded startup expires", async () => {
  const fake = await fakeHerdr(
    'console.error(JSON.stringify({error:{code:"timeout",message:"agent startup timed out"}})); process.exitCode=1;',
  );
  try {
    expect(
      await fake.store.spawnSeat({
        schemaVersion: 1,
        harness: "pi",
        title: "Never ready",
        workingDirectory: fake.root,
      }),
    ).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
      detail: expect.stringContaining("timeout"),
    });
    expect(await fake.calls()).toContainEqual(["pane", "close", "w1:p1"]);
  } finally {
    fake.store.close();
  }
});

it("still requires pi's durable session report within a bounded wait", async () => {
  vi.useFakeTimers();
  const runner: HerdrWatchRunner = {
    createTab: async () => "w1:p1",
    startAgent: async () => undefined,
    get: async () => ({ paneId: "w1:p1", terminalId: "term_pi", agent: "pi", status: "idle", title: "Pi" }),
    resolveTerminal: async () => undefined,
    wait: async () => {
      throw new Error("unused");
    },
    closePane: vi.fn(async () => undefined),
  };
  const store = new HerdrWatchStore(join(tmpdir(), "unused-pi-start-watch.json"), { runner });
  try {
    const pending = store.spawnSeat({
      schemaVersion: 1,
      harness: "pi",
      title: "No session",
      workingDirectory: tmpdir(),
    });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await pending).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
      detail: expect.stringContaining("durable session"),
    });
    expect(runner.closePane).toHaveBeenCalledWith("w1:p1");
  } finally {
    store.close();
  }
});

it("keeps ordinary Herdr queries on the short deadline and names a process watchdog timeout", async () => {
  const fake = await fakeHerdr('console.log("{}");');
  try {
    await writeFile(
      join(fake.root, "herdr"),
      `#!${process.execPath}\nsetTimeout(() => console.log("{}"), 5500);\n`,
    );
    await expect(createHerdrWatchRunner().get("w1:p1")).rejects.toThrow(
      "Herdr agent get timed out after 5000 ms",
    );
  } finally {
    fake.store.close();
  }
}, 10_000);
