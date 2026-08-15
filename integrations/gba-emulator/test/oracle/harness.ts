import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GbaButton } from "@clankie/interactive-environment";
import type { GbaCoreMapGrid, GbaCoreSeam, GbaCoreState } from "../../src/index.ts";

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item,
  );

export const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export interface DecoderVector {
  id: string;
  ewram: Uint8Array;
  iwram: Uint8Array;
  rom: Uint8Array;
}

type Decoder = (vector: Omit<DecoderVector, "id">) => unknown;

const decoderResult = (
  decoder: Decoder,
  vector: DecoderVector,
  failureCategory: (error: unknown) => string,
): unknown => {
  try {
    return {
      kind: "value",
      value: decoder({ ewram: vector.ewram.slice(), iwram: vector.iwram.slice(), rom: vector.rom.slice() }),
    };
  } catch (error) {
    return { category: failureCategory(error), kind: "failure" };
  }
};

/** Compare both decoders against fresh copies of the exact same legal synthetic bytes. */
export const assertDecoderParity = (
  vectors: readonly DecoderVector[],
  legacy: Decoder,
  candidate: Decoder,
  failureCategory: (error: unknown) => string,
): void => {
  for (const vector of vectors) {
    assert.deepStrictEqual(
      decoderResult(candidate, vector, failureCategory),
      decoderResult(legacy, vector, failureCategory),
      `decoder result diverged for ${vector.id}`,
    );
  }
};

const JOYPAD_MASK: Readonly<Record<GbaButton, number>> = {
  b: 1 << 0,
  select: 1 << 2,
  start: 1 << 3,
  up: 1 << 4,
  down: 1 << 5,
  left: 1 << 6,
  right: 1 << 7,
  a: 1 << 8,
  l: 1 << 10,
  r: 1 << 11,
};

export interface CoreRead {
  kind: "framebufferSha256" | "gameState" | "mapGrid" | "ramStateSha256";
  value: unknown;
}

const snapshotGrid = (grid: GbaCoreMapGrid | null): unknown => {
  if (grid === null) return null;
  return {
    maxX: grid.maxX,
    maxY: grid.maxY,
    minX: grid.minX,
    minY: grid.minY,
    rows: Array.from({ length: grid.maxY - grid.minY }, (_, row) =>
      Array.from({ length: grid.maxX - grid.minX }, (_unused, column) =>
        grid.isPassable(grid.minX + column, grid.minY + row) ? "." : "#",
      ).join(""),
    ),
  };
};

/**
 * Observation-only wrapper for the old core seam. It records the emulated
 * input signal after expanding convenience calls into one libretro mask per
 * frame, and records every state/digest read in order.
 */
export class TracedCore implements GbaCoreSeam {
  public readonly coreId: string;
  public readonly inputMasks: number[] = [];
  public readonly reads: CoreRead[] = [];
  private readonly core: GbaCoreSeam;
  private readonly postPressReleaseFrames: number;

  public constructor(core: GbaCoreSeam, postPressReleaseFrames: number) {
    this.core = core;
    this.coreId = core.coreId;
    this.postPressReleaseFrames = postPressReleaseFrames;
  }

  public async pressButton(button: GbaButton, holdFrames: number): Promise<void> {
    this.inputMasks.push(...Array<number>(holdFrames).fill(JOYPAD_MASK[button]));
    this.inputMasks.push(...Array<number>(this.postPressReleaseFrames).fill(0));
    await this.core.pressButton(button, holdFrames);
  }

  public async advanceFrames(frames: number): Promise<void> {
    this.inputMasks.push(...Array<number>(frames).fill(0));
    await this.core.advanceFrames(frames);
  }

  public async advanceFramesHolding(button: GbaButton, frames: number): Promise<void> {
    if (frames > 1) this.inputMasks.push(...Array<number>(frames - 1).fill(JOYPAD_MASK[button]));
    if (frames > 0) this.inputMasks.push(0);
    if (this.core.advanceFramesHolding === undefined) {
      await this.core.advanceFrames(frames);
    } else {
      await this.core.advanceFramesHolding(button, frames);
    }
  }

  public idleFrames(frames: number): void {
    this.inputMasks.push(...Array<number>(frames).fill(0));
    this.core.idleFrames?.(frames);
  }

  public gameState(): GbaCoreState {
    const value = this.core.gameState();
    this.reads.push({ kind: "gameState", value: structuredClone(value) });
    return value;
  }

  public mapGrid(): GbaCoreMapGrid | null {
    const value = this.core.mapGrid?.() ?? null;
    this.reads.push({ kind: "mapGrid", value: snapshotGrid(value) });
    return value;
  }

  public ramStateSha256(): string {
    const value = this.core.ramStateSha256();
    this.reads.push({ kind: "ramStateSha256", value });
    return value;
  }

  public framebufferSha256(): string {
    const value = this.core.framebufferSha256();
    this.reads.push({ kind: "framebufferSha256", value });
    return value;
  }
}

export interface CompositeRun<TResult> {
  core: TracedCore;
  result: TResult;
}

/** Allocate twice before running: old and new never touch the same mutable core. */
export const runFreshCompositePair = async <TResult>(
  create: () => TracedCore | Promise<TracedCore>,
  legacy: (core: TracedCore) => TResult | Promise<TResult>,
  candidate: (core: TracedCore) => TResult | Promise<TResult>,
): Promise<{ legacy: CompositeRun<TResult>; candidate: CompositeRun<TResult> }> => {
  const legacyCore = await create();
  const candidateCore = await create();
  assert.notStrictEqual(legacyCore, candidateCore, "composite runs shared one mutable core");
  return {
    legacy: { core: legacyCore, result: await legacy(legacyCore) },
    candidate: { core: candidateCore, result: await candidate(candidateCore) },
  };
};

export const assertCompositeParity = <TResult>(
  legacy: CompositeRun<TResult>,
  candidate: CompositeRun<TResult>,
): void => {
  assert.deepStrictEqual(candidate.result, legacy.result, "composite boundary result diverged");
  assert.deepStrictEqual(candidate.core.inputMasks, legacy.core.inputMasks, "per-frame input mask diverged");
  assert.deepStrictEqual(candidate.core.reads, legacy.core.reads, "state read sequence diverged");
};

export const coreSnapshot = (core: GbaCoreSeam): unknown => {
  const state = core.gameState();
  return {
    decodedState: state,
    framebufferSha256: core.framebufferSha256(),
    logicalFrame: state.frame,
    mapGrid: snapshotGrid(core.mapGrid?.() ?? null),
    ramStateSha256: core.ramStateSha256(),
  };
};
