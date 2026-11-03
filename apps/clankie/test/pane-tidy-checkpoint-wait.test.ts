// #607: a connected app's close_agent timed out on landed hires while the GitHub main
// checkpoint read a busy repository's runs, with no deadline. The close now holds as
// unknown once its wait runs out; the read goes on, so its cache answers the next close.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";

const agent: HerdrAgentSnapshot = {
  paneId: "herdr-core/t5p",
  terminalId: "herdr-core/t5p",
  agent: "claude",
  status: "done",
  title: "landed hire",
};

it("a slow main checkpoint holds the close as unknown in time, and a later close takes its answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "tidy-checkpoint-"));
  try {
    let finish: (hold: undefined) => void = () => {};
    const slow = new Promise<undefined>((resolve) => (finish = resolve));
    let reads = 0;
    const tidy = new PaneTidy(join(root, "pane-tidy.json"), {
      mainCheckpoint: async () => {
        reads += 1;
        return slow;
      },
      checkpointMs: 50,
    } as never);

    const started = Date.now();
    expect(await tidy.mainCheckpointHold(agent)).toMatchObject({
      reason: "main_unknown",
      detail: expect.stringContaining("still being read"),
    });
    expect(Date.now() - started).toBeLessThan(5_000);

    // The read finished meanwhile: green main lets the next close through.
    finish(undefined);
    expect(await tidy.mainCheckpointHold(agent)).toBeUndefined();
    expect(reads).toBe(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
