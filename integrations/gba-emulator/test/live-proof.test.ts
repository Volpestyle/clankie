import { createHash } from "node:crypto";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateFireRedLiveReceipt } from "../src/live-proof.ts";

describe("FireRed live receipt", () => {
  it("recomputes every bounded artifact and accepts the complete rival-battle proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-firered-receipt-"));
    const artifacts = await writeArtifacts(root);
    const path = join(root, "run-receipt.json");
    await writeFile(path, JSON.stringify(receipt(artifacts)));
    await expect(evaluateFireRedLiveReceipt(path)).resolves.toMatchObject({
      passed: true,
      identity: { scenarioId: "firered-oaks-lab-rival" },
    });
  });

  it("fails a changed artifact and rejects symlinked receipt evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-firered-receipt-"));
    const artifacts = await writeArtifacts(root);
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify(receipt(artifacts)));
    const linked = join(root, "run-receipt.json");
    await symlink(target, linked);
    await expect(evaluateFireRedLiveReceipt(linked)).rejects.toThrow(/regular file/u);

    await writeFile(join(root, "report.json"), "changed");
    await expect(evaluateFireRedLiveReceipt(target)).resolves.toMatchObject({ passed: false });
  });
});

async function writeArtifacts(root: string): Promise<{
  reportSha256: string;
  decisionsSha256: string;
  eventsSha256: string;
  semanticEventsSha256: string;
  screenshotSha256: string;
}> {
  const files = {
    reportSha256: ["report.json", "report"],
    decisionsSha256: ["decisions.json", "decisions"],
    eventsSha256: ["events.json", "events"],
    semanticEventsSha256: ["semantic-events.json", "semantic"],
    screenshotSha256: ["final-frame.png", "png"],
  } as const;
  const result = {} as Record<keyof typeof files, string>;
  for (const [field, [name, content]] of Object.entries(files) as [
    keyof typeof files,
    readonly [string, string],
  ][]) {
    await writeFile(join(root, name), content);
    result[field] = sha256(content);
  }
  return result;
}

function receipt(artifacts: Awaited<ReturnType<typeof writeArtifacts>>) {
  return {
    scenarioId: "firered-oaks-lab-rival",
    scenarioVersion: 1,
    fixtureSha256: sha256("fixture"),
    identity: {
      romSha256: sha256("rom"),
      savestateSha256: sha256("state"),
      coreWasmSha256: sha256("core"),
    },
    result: "passed",
    halt: "battle_won",
    checks: {
      identityVerified: true,
      targetLocationReached: true,
      partyMenuObserved: true,
      inventoryMenuObserved: true,
      trainerBattleWon: true,
      decisionsStateDerived: true,
      authoritativeStateCertain: true,
      evidenceBounded: true,
      inputsWithinBounds: true,
    },
    finalState: {
      position: { mapId: "pallet-town/professor-oaks-lab", x: 4, y: 3 },
      facing: "north",
      frame: 100,
      inputCount: 20,
      battleResult: "won",
    },
    determinism: {
      byteIdenticalReport: true,
      reportSha256: artifacts.reportSha256,
      decisionTraceSha256: artifacts.decisionsSha256,
      eventTraceSha256: artifacts.eventsSha256,
      secondRunReportSha256: artifacts.reportSha256,
    },
    noNetwork: { attempts: 0 },
    artifacts,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
