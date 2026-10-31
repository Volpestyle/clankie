import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { WatchingMachineRefused } from "@clankie/protocol";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { createCaptainModelRuntime } from "../src/captain/model.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { WATCH_TURN_REFUSAL, createWatchGate } from "../src/watch.ts";
import { runAutonomyCommand } from "../../tui/src/command/fleet.ts";
import { fleetSettingsClient } from "../../tui/test/fixtures/fleet-settings-client.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Real settings on disk, the real owner route and CLI, and the real hire controller. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-watch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const client = fleetSettingsClient(settings);
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
  });
  const path = join(root, "owned-watches.json");
  const watches = new HerdrWatchStore(path, {
    requireWorkerAccess: (fleet) => runtimes.requireAccess(fleet, "workers"),
  });
  cleanups.push(async () => watches.close());
  return {
    root,
    settings,
    runtimes,
    watches,
    path,
    dial: (level: string) => runAutonomyCommand([level], client),
  };
}

it("Watch holds every machine at Portal: no hire, move or delivery, and no machine refusal to fix", async () => {
  const f = await fixture();
  expect((await f.dial("watch")).level).toBe("watch");

  // Seeing stays open; acting does not.
  await expect(f.runtimes.requireAccess(undefined, "portal")).resolves.toBeDefined();
  await expect(f.runtimes.requireAccess(undefined, "workers")).rejects.toBeInstanceOf(WatchingMachineRefused);
  await expect(f.runtimes.requireAccess(undefined, "shell")).rejects.toThrow("only watching");

  const hire = await f.watches.spawnSeat({
    schemaVersion: 1,
    harness: "codex",
    title: "Watched",
    workingDirectory: f.root,
  });
  expect(hire).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("only watching"),
  });
  await expect(stat(`${f.path}.project-hires.json`)).rejects.toThrow();
  expect(
    await f.watches.moveSeat({
      seatId: "watched-seat",
      subject: "Watched",
      harness: "codex",
      title: "Watched",
      workingDirectory: f.root,
    }),
  ).toMatchObject({ outcome: "failed", detail: expect.stringContaining("only watching") });
  expect(await f.watches.deliverToSeat("watched-seat", "Do work")).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "rejected",
    detail: expect.stringContaining("only watching"),
  });
  // The owner chose Watch: doctor gets no "raise this machine's access" item.
  await expect(stat(`${f.settings.path}.access-refusals`)).rejects.toThrow();

  // Any level lets him act again, at the machine's own access.
  expect((await f.dial("off")).level).toBe("off");
  await expect(f.runtimes.requireAccess(undefined, "workers")).resolves.toBeDefined();
});

it("Watch refuses a model turn before any model is chosen, so nothing reaches a provider", async () => {
  const f = await fixture();
  const watch = createWatchGate(f.settings);
  const models = await createCaptainModelRuntime(f.root, { refuse: () => watch.refuse(WATCH_TURN_REFUSAL) });
  await f.dial("watch");
  await expect(models.resolveSelection()).rejects.toThrow(WATCH_TURN_REFUSAL);
  await expect(models.resolveRoute("operator")).rejects.toThrow(WATCH_TURN_REFUSAL);
  // Leaving Watch lifts the refusal; whatever the machine's model setup says comes next.
  await f.dial("off");
  await expect(watch.refuse(WATCH_TURN_REFUSAL)).resolves.toBeUndefined();
});
