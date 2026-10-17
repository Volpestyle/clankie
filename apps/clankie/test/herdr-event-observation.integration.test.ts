import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { FleetChangeClock, watchHerdrFleetChanges } from "../src/captain/herdr-fleet-changes.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

// Fleet observation rides the configured Herdr's own socket: no `herdr agent
// wait` process per seat, and a feed the pinned Herdr accepts (VUH-2391).
const until = async (done: () => boolean, ms = 5_000) => {
  for (const deadline = Date.now() + ms; !done();) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

it("waits for a seat's status on Herdr's socket without a subprocess", { timeout: 30_000 }, async () => {
  const herdr = await isolatedHerdr(join(tmpdir(), `clankie-herdr-wait-${process.pid}`));
  try {
    const spawned: string[] = [];
    const runner = createHerdrWatchRunner(
      () => true,
      async (args) => {
        spawned.push(args.join(" "));
        throw new Error("no Herdr subprocess expected");
      },
      undefined,
      {
        localCodexRecovery: false,
        localReadBinding: async () => ({ socketPath: herdr.socketPath, session: "default" }),
      },
    );
    const report = (state: string) =>
      herdr.cli("pane", "report-agent", herdr.pane, "--source", "test", "--agent", "codex", "--state", state);
    await report("working");
    const signal = new AbortController().signal;
    const changed = runner.waitForChange!(herdr.pane, "working", signal);
    const settled = runner.wait(herdr.pane, signal);
    await report("idle");

    expect((await changed).status).toBe("idle");
    expect((await settled).status).toBe("idle");
    // Already settled answers at once.
    expect((await runner.wait(herdr.pane, signal)).status).toBe("idle");

    await report("working");
    const closing = runner.waitForChange!(herdr.pane, "working", signal);
    await herdr.cli("pane", "close", herdr.pane);
    await expect(closing).rejects.toThrow();
    expect(spawned).toEqual([]);
  } finally {
    await herdr.close();
  }
});

it("subscribes the fleet feed on the pinned Herdr and hears a pane close", { timeout: 30_000 }, async () => {
  const herdr = await isolatedHerdr(join(tmpdir(), `clankie-herdr-feed-${process.pid}`));
  const clock = new FleetChangeClock();
  const closed: string[] = [];
  let subscribed = 0;
  const stop = watchHerdrFleetChanges(clock, {
    socketPath: herdr.socketPath,
    summariesPath: join(herdr.root, "summaries.json"),
    reconnectMs: 50,
    onPaneClosed: (paneId) => closed.push(paneId),
    onSubscribed: () => subscribed++,
  });
  try {
    await until(() => subscribed > 0);
    const cursor = clock.current();
    await herdr.cli("pane", "close", herdr.foreignPane);
    await until(() => closed.length > 0);

    expect(closed).toEqual([herdr.foreignPane]);
    expect(clock.current()).not.toBe(cursor);
    // The accepted subscription stays up rather than re-connecting.
    expect(subscribed).toBe(1);
  } finally {
    stop();
    await herdr.close();
  }
});
