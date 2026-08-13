import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { Sha256Schema } from "./contracts.ts";
import { canonicalJson, sha256 } from "./core-double.ts";
import { FREE_PLAY_NOTES_MAX, FREE_PLAY_OBJECTIVE_MAX } from "./free-play-bounds.ts";
import type { GbaCheckpointCapability } from "./free-play-boot.ts";

/**
 * Progress that outlives the process, as minted checkpoints (ADR 0060).
 *
 * Boot fails closed unless the savestate matches the digest its scenario pins,
 * so a save can never mutate the current identity — it mints a new one: the
 * savestate bytes, a receipt recording their digests, and a companion scenario
 * that lets the same fail-closed loader boot from the checkpoint later. The
 * pinned fixtures stay frozen; a checkpoint is a sibling identity, never an
 * overwrite.
 *
 * Bytes stay operator-local, exactly like the ROM and the pinned savestate:
 * only digests appear in receipts, evidence, and tool results.
 */

export const GBA_CHECKPOINT_SCHEMA_VERSION = 1 as const;

/** Filesystem-safe slug so a label can never smuggle path segments. */
export const GbaCheckpointLabelSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u);

/** Ids are directory basenames (timestamp + optional label), never paths. */
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,159}$/u;

export const GbaCheckpointReceiptSchema = z
  .object({
    schemaVersion: z.literal(GBA_CHECKPOINT_SCHEMA_VERSION),
    checkpointId: z.string().regex(CHECKPOINT_ID_PATTERN),
    label: GbaCheckpointLabelSchema.nullable(),
    capturedAt: z.string().datetime(),
    /** The identity the core verified at boot; a load refuses any mismatch. */
    romSha256: Sha256Schema,
    coreWasmSha256: Sha256Schema,
    savestateSha256: Sha256Schema,
    /** Where he stood at capture. Null when undecodable (mid-battle, mid-warp). */
    position: z
      .object({ mapId: z.string().min(1).max(128), x: z.number().int(), y: z.number().int() })
      .strict()
      .nullable(),
    /**
     * What he was thinking at capture: his own notes and standing objective,
     * carried so a resumed session restores his mind along with the RAM. A
     * checkpoint without them resumes a world whose player has forgotten what
     * he was doing there. Defaulted, because receipts minted before continuity
     * existed must keep parsing.
     */
    continuity: z
      .object({
        notes: z.string().max(FREE_PLAY_NOTES_MAX).nullable(),
        objective: z.string().max(FREE_PLAY_OBJECTIVE_MAX).nullable(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type GbaCheckpointReceipt = z.infer<typeof GbaCheckpointReceiptSchema>;

const SAVESTATE_FILENAME = "savestate.ss1";
const RECEIPT_FILENAME = "checkpoint.json";
const SCENARIO_FILENAME = "scenario.json";

/** Mirrors `defaultGbaBodyRootDir`: one well-known operator-local home. */
export function defaultGbaCheckpointDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CLANKIE_GBA_CHECKPOINT_DIR"];
  if (override !== undefined && override.length > 0) {
    mkdirSync(override, { recursive: true });
    return override;
  }
  const stateHome =
    env["XDG_STATE_HOME"] !== undefined && env["XDG_STATE_HOME"].length > 0
      ? env["XDG_STATE_HOME"]
      : path.join(homedir(), ".local", "state");
  const root = path.join(stateHome, "clankie", "gba-checkpoints");
  mkdirSync(root, { recursive: true });
  return root;
}

export interface WriteGbaCheckpointInput {
  rootDir: string;
  capability: GbaCheckpointCapability;
  label?: string | undefined;
  position: { mapId: string; x: number; y: number } | null;
  /** His notes and objective at capture, when the minting driver has them. */
  continuity?: { notes: string | null; objective: string | null } | null;
  clock?: () => Date;
}

export interface WrittenGbaCheckpoint {
  receipt: GbaCheckpointReceipt;
  directory: string;
  savestatePath: string;
  scenarioPath: string;
}

export function writeGbaCheckpoint(input: WriteGbaCheckpointInput): WrittenGbaCheckpoint {
  const label = input.label === undefined ? null : GbaCheckpointLabelSchema.parse(input.label);
  const capturedAt = (input.clock ?? (() => new Date()))();
  const stamp = capturedAt.toISOString().replace(/[:.]/gu, "-");
  const checkpointId = label === null ? stamp : `${stamp}-${label}`;

  const savestateBytes = input.capability.saveState();
  const savestateSha256 = sha256(savestateBytes);
  // The companion scenario is what makes the checkpoint bootable: the same
  // fail-closed loader, pointed at the minted savestate identity. Route fields
  // carry over from the booted fixture — they describe the original route, not
  // where he stands now; the receipt records that.
  const scenario = {
    ...input.capability.scenario,
    savestateId: `checkpoint:${checkpointId}`,
    savestateSha256,
  };
  const receipt = GbaCheckpointReceiptSchema.parse({
    schemaVersion: GBA_CHECKPOINT_SCHEMA_VERSION,
    checkpointId,
    label,
    capturedAt: capturedAt.toISOString(),
    romSha256: input.capability.identity.romSha256,
    coreWasmSha256: input.capability.identity.coreWasmSha256,
    savestateSha256,
    position: input.position,
    continuity: input.continuity ?? null,
  });

  const directory = path.join(input.rootDir, checkpointId);
  mkdirSync(directory, { recursive: true });
  const savestatePath = path.join(directory, SAVESTATE_FILENAME);
  const scenarioPath = path.join(directory, SCENARIO_FILENAME);
  writeFileSync(savestatePath, savestateBytes);
  writeFileSync(scenarioPath, `${canonicalJson(scenario)}\n`);
  writeFileSync(path.join(directory, RECEIPT_FILENAME), `${canonicalJson(receipt)}\n`);
  return { receipt, directory, savestatePath, scenarioPath };
}

/** Valid receipts under the root, newest first. Foreign files are not listed. */
export function listGbaCheckpoints(rootDir: string): GbaCheckpointReceipt[] {
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return [];
  }
  const receipts: GbaCheckpointReceipt[] = [];
  for (const entry of entries) {
    try {
      const raw = readFileSync(path.join(rootDir, entry, RECEIPT_FILENAME), "utf8");
      const receipt = GbaCheckpointReceiptSchema.parse(JSON.parse(raw));
      // A receipt that does not name its own directory is not trusted enough to list.
      if (receipt.checkpointId === entry) receipts.push(receipt);
    } catch {
      // Not a checkpoint. The directory is operator-local; skip, never fail the listing.
    }
  }
  return receipts.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
}

export interface ReadGbaCheckpointInput {
  rootDir: string;
  checkpointId: string;
  /** The running core's verified identity; another ROM or core build is refused. */
  identity: GbaCheckpointCapability["identity"];
}

export function readGbaCheckpoint(input: ReadGbaCheckpointInput): {
  receipt: GbaCheckpointReceipt;
  savestateBytes: Uint8Array;
} {
  if (!CHECKPOINT_ID_PATTERN.test(input.checkpointId)) {
    throw new Error("checkpoint_id_invalid: ids are directory basenames, never paths");
  }
  const directory = path.join(input.rootDir, input.checkpointId);
  let raw: string;
  try {
    raw = readFileSync(path.join(directory, RECEIPT_FILENAME), "utf8");
  } catch {
    throw new Error(`checkpoint_not_found: ${input.checkpointId}`);
  }
  const receipt = GbaCheckpointReceiptSchema.parse(JSON.parse(raw));
  if (receipt.checkpointId !== input.checkpointId) {
    throw new Error("checkpoint_receipt_mismatch: receipt does not name this directory");
  }
  if (receipt.romSha256 !== input.identity.romSha256) {
    throw new Error("checkpoint_rom_mismatch: checkpoint was taken from a different ROM");
  }
  if (receipt.coreWasmSha256 !== input.identity.coreWasmSha256) {
    throw new Error("checkpoint_core_mismatch: checkpoint was taken on a different core build");
  }
  const savestateBytes = readFileSync(path.join(directory, SAVESTATE_FILENAME));
  if (sha256(savestateBytes) !== receipt.savestateSha256) {
    throw new Error("checkpoint_savestate_corrupt: bytes do not match the recorded digest");
  }
  return { receipt, savestateBytes };
}
