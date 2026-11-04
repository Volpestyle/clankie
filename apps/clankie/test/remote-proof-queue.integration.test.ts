import { expect, it } from "vitest";
import { powershellScriptCommand } from "../src/herdr-fleet.ts";
import { queuedProofFixture } from "./helpers/remote-proof-queue.ts";

it("does not send abandoned next observations ahead of a fresh single-call proof", async () => {
  const fixture = await queuedProofFixture();
  try {
    const load = powershellScriptCommand("# fixture-load:0");
    const first = fixture.relay.execute(load);
    const abandoned = fixture.relay.execute(load, 30);
    await expect(abandoned).rejects.toThrow("Remote observation timed out");
    fixture.child.send("release");
    await expect(first).resolves.toBe("load complete");
    const proof = await fixture.observe();
    expect(proof).toMatchObject({ fleet: "fixture", pane: "wE:p2", workspace: { platform: "windows" } });
    // IPC and stdout are separate pipes: wait for the proof's positive completion receipt.
    await fixture.proofReceipt();
    expect(fixture.timings.filter((event) => event.kind === "load")).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

it("keeps a fresh next run for live callers when another coalesced caller expires", async () => {
  const fixture = await queuedProofFixture();
  try {
    const load = powershellScriptCommand("# fixture-load:0");
    const first = fixture.relay.execute(load);
    const abandoned = fixture.relay.execute(load, 30);
    const live = fixture.relay.execute(load);
    await expect(abandoned).rejects.toThrow("Remote observation timed out");
    fixture.child.send("release");
    await expect(first).resolves.toBe("load complete");
    await expect(live).resolves.toBe("load complete");
    expect(await fixture.observe()).toMatchObject({ fleet: "fixture", pane: "wE:p2" });
    await fixture.proofReceipt();
    expect(fixture.timings.filter((event) => event.kind === "load")).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});
