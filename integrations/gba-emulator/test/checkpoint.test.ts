import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listGbaCheckpoints,
  readGbaCheckpoint,
  writeGbaCheckpoint,
  type GbaCheckpointCapability,
} from "../src/index.ts";
import { sha256 } from "../src/core-double.ts";
import { RealGbaRouteScenarioSchema } from "../src/real-scenario.ts";

const FIXTURE = path.join(import.meta.dirname, "../fixtures/firered-bedroom-route/v1/scenario.json");

function root(): string {
  return mkdtempSync(path.join(tmpdir(), "gba-checkpoint-"));
}

function capability(savestate: Uint8Array = new Uint8Array([1, 2, 3, 4])): GbaCheckpointCapability {
  const scenario = RealGbaRouteScenarioSchema.parse(JSON.parse(readFileSync(FIXTURE, "utf8")));
  return {
    saveState: () => savestate,
    loadState: vi.fn(),
    identity: {
      romSha256: scenario.romSha256,
      savestateSha256: scenario.savestateSha256,
      coreWasmSha256: scenario.coreWasmSha256,
    },
    scenario,
  };
}

const CLOCK = () => new Date("2026-07-25T18:00:00.000Z");
const POSITION = { mapId: "pallet-town/players-house-2f", x: 13, y: 13 };

describe("gba checkpoints", () => {
  it("mints a bootable sibling identity rather than mutating the pinned one", () => {
    const dir = root();
    const bytes = new Uint8Array([9, 9, 9]);
    const cap = capability(bytes);
    const written = writeGbaCheckpoint({
      rootDir: dir,
      capability: cap,
      label: "before-rival",
      position: POSITION,
      clock: CLOCK,
    });

    // The companion scenario boots through the same fail-closed loader: it must
    // parse under the route schema and pin the checkpoint's own digest.
    const scenario = RealGbaRouteScenarioSchema.parse(JSON.parse(readFileSync(written.scenarioPath, "utf8")));
    expect(scenario.savestateSha256).toBe(sha256(bytes));
    expect(scenario.savestateId).toBe(`checkpoint:${written.receipt.checkpointId}`);
    // The pinned fixture identity is untouched.
    expect(cap.scenario.savestateId).not.toContain("checkpoint:");

    const { receipt, savestateBytes } = readGbaCheckpoint({
      rootDir: dir,
      checkpointId: written.receipt.checkpointId,
      identity: cap.identity,
    });
    expect(savestateBytes).toEqual(Buffer.from(bytes));
    expect(receipt.position).toEqual(POSITION);
    expect(receipt.label).toBe("before-rival");
    expect(listGbaCheckpoints(dir).map((entry) => entry.checkpointId)).toEqual([receipt.checkpointId]);
  });

  it("refuses a label that is not a slug, so a label can never carry a path", () => {
    expect(() =>
      writeGbaCheckpoint({
        rootDir: root(),
        capability: capability(),
        label: "../escape",
        position: null,
        clock: CLOCK,
      }),
    ).toThrow();
  });

  it("refuses a checkpoint id that is not a directory basename", () => {
    expect(() =>
      readGbaCheckpoint({ rootDir: root(), checkpointId: "../elsewhere", identity: capability().identity }),
    ).toThrow("checkpoint_id_invalid");
  });

  it("fails closed when the savestate bytes do not match the recorded digest", () => {
    const dir = root();
    const cap = capability();
    const written = writeGbaCheckpoint({ rootDir: dir, capability: cap, position: null, clock: CLOCK });
    writeFileSync(written.savestatePath, new Uint8Array([7, 7]));
    expect(() =>
      readGbaCheckpoint({ rootDir: dir, checkpointId: written.receipt.checkpointId, identity: cap.identity }),
    ).toThrow("checkpoint_savestate_corrupt");
  });

  it("refuses a checkpoint taken from a different ROM or core build", () => {
    const dir = root();
    const cap = capability();
    const written = writeGbaCheckpoint({ rootDir: dir, capability: cap, position: null, clock: CLOCK });
    expect(() =>
      readGbaCheckpoint({
        rootDir: dir,
        checkpointId: written.receipt.checkpointId,
        identity: { ...cap.identity, romSha256: "0".repeat(64) },
      }),
    ).toThrow("checkpoint_rom_mismatch");
    expect(() =>
      readGbaCheckpoint({
        rootDir: dir,
        checkpointId: written.receipt.checkpointId,
        identity: { ...cap.identity, coreWasmSha256: "0".repeat(64) },
      }),
    ).toThrow("checkpoint_core_mismatch");
  });

  it("neither lists nor loads a receipt that does not name its own directory", () => {
    const dir = root();
    const cap = capability();
    const written = writeGbaCheckpoint({ rootDir: dir, capability: cap, position: null, clock: CLOCK });
    const movedId = `${written.receipt.checkpointId}-moved`;
    renameSync(written.directory, path.join(dir, movedId));
    expect(listGbaCheckpoints(dir)).toEqual([]);
    expect(() => readGbaCheckpoint({ rootDir: dir, checkpointId: movedId, identity: cap.identity })).toThrow(
      "checkpoint_receipt_mismatch",
    );
  });

  it("lists newest first and skips foreign files", () => {
    const dir = root();
    const cap = capability();
    writeFileSync(path.join(dir, "not-a-checkpoint"), "junk");
    const older = writeGbaCheckpoint({
      rootDir: dir,
      capability: cap,
      position: null,
      clock: () => new Date("2026-07-24T18:00:00.000Z"),
    });
    const newer = writeGbaCheckpoint({ rootDir: dir, capability: cap, position: null, clock: CLOCK });
    expect(listGbaCheckpoints(dir).map((entry) => entry.checkpointId)).toEqual([
      newer.receipt.checkpointId,
      older.receipt.checkpointId,
    ]);
  });
});
