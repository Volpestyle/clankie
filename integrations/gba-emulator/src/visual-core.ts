import type { GbaButton } from "@clankie/interactive-environment";
import { z } from "zod";
import { Sha256Schema } from "./contracts.ts";
import { sha256 } from "./core-double.ts";
import type { GbaCoreSeam } from "./core-seam.ts";
import { MgbaLibretroCore, mgbaCoreWasmSha256, type MgbaFramebuffer } from "./mgba-core.ts";

export const VisualGbaScenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    semanticProfile: z.literal("framebuffer-only"),
    scenarioId: z.string().min(1).max(128),
    scenarioVersion: z.number().int().positive(),
    coreId: z.string().min(1).max(128),
    savestateId: z.string().min(1).max(128),
    savestateSha256: Sha256Schema,
    romSha256: Sha256Schema,
    coreWasmSha256: Sha256Schema,
    rngSeed: z.number().int().nonnegative().max(4_294_967_295),
    worldId: z.string().min(1).max(256),
    player: z.object({ characterId: z.string().min(1).max(256) }).strict(),
    maxEvidenceEvents: z.number().int().positive().max(256),
    maxDecisions: z.number().int().positive().max(256),
  })
  .strict();
export type VisualGbaScenario = z.infer<typeof VisualGbaScenarioSchema>;

export interface MgbaVisualCoreIdentity {
  romSha256: string;
  savestateSha256: string;
  coreWasmSha256: string;
}

const POST_INPUT_SETTLE_FRAMES = 32;
const WARMUP_FRAMES_AFTER_RESTORE = 2;
const OBSERVE_CHUNK_FRAMES = 3;
const FRAME_INTERVAL_MS = 1_000 / 59.7275;

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A real mGBA body for cartridges without a verified RAM decoder.
 *
 * The framebuffer, buttons, RAM digest, and savestates are real. Semantic
 * fields are deliberately unavailable, so the adapter exposes only the screen
 * and raw controls instead of interpreting Emerald through FireRed offsets.
 */
export class MgbaVisualCore implements GbaCoreSeam {
  public readonly coreId: string;
  private readonly core: MgbaLibretroCore;
  private readonly verifiedIdentity: MgbaVisualCoreIdentity;
  private readonly configuredBootSavestate: Uint8Array;
  private frame = 0;
  private inputCount = 0;
  private frameObserver: (() => void) | null = null;
  private paceToWallClock = false;

  private constructor(
    coreId: string,
    core: MgbaLibretroCore,
    verifiedIdentity: MgbaVisualCoreIdentity,
    configuredBootSavestate: Uint8Array,
  ) {
    this.coreId = coreId;
    this.core = core;
    this.verifiedIdentity = verifiedIdentity;
    this.configuredBootSavestate = configuredBootSavestate;
  }

  public static async create(input: {
    scenario: VisualGbaScenario;
    romBytes: Uint8Array;
    savestateBytes: Uint8Array;
  }): Promise<MgbaVisualCore> {
    const romSha256 = sha256(input.romBytes);
    if (romSha256 !== input.scenario.romSha256) {
      throw new Error("ROM bytes do not match the pinned ROM identity digest");
    }
    const coreWasmSha256 = mgbaCoreWasmSha256();
    if (coreWasmSha256 !== input.scenario.coreWasmSha256) {
      throw new Error("mGBA core wasm does not match the pinned core identity digest");
    }

    const bootSavestate = input.savestateBytes.slice();
    const savestateSha256 = sha256(bootSavestate);
    if (savestateSha256 !== input.scenario.savestateSha256) {
      throw new Error("Savestate bytes do not match the pinned savestate identity digest");
    }
    const core = await MgbaLibretroCore.create();
    core.loadRom(input.romBytes);
    core.setHeldButtons([]);
    core.runFrames(1);
    core.loadState(bootSavestate);
    core.runFrames(WARMUP_FRAMES_AFTER_RESTORE);
    return new MgbaVisualCore(
      input.scenario.coreId,
      core,
      { romSha256, savestateSha256, coreWasmSha256 },
      bootSavestate,
    );
  }

  public identity(): MgbaVisualCoreIdentity {
    return { ...this.verifiedIdentity };
  }

  public bootSavestate(): Uint8Array {
    return this.configuredBootSavestate.slice();
  }

  public saveState(): Uint8Array {
    return this.core.saveState();
  }

  public loadState(bytes: Uint8Array): void {
    this.core.loadState(bytes);
    this.core.setHeldButtons([]);
    this.core.runFrames(WARMUP_FRAMES_AFTER_RESTORE);
  }

  public observeFrames(observer: (() => void) | null, options: { pace?: boolean } = {}): void {
    this.frameObserver = observer;
    this.paceToWallClock = options.pace ?? false;
  }

  private runFramesObserved(frames: number): void {
    if (this.frameObserver === null && !this.paceToWallClock) {
      this.core.runFrames(frames);
      return;
    }
    let remaining = frames;
    while (remaining > 0) {
      const chunk = Math.min(OBSERVE_CHUNK_FRAMES, remaining);
      const startedAt = performance.now();
      this.core.runFrames(chunk);
      remaining -= chunk;
      this.frameObserver?.();
      if (this.paceToWallClock) {
        sleepSync(chunk * FRAME_INTERVAL_MS - (performance.now() - startedAt));
      }
    }
  }

  public pressButton(button: GbaButton, holdFrames: number): void {
    this.core.setHeldButtons([button]);
    this.runFramesObserved(holdFrames);
    this.core.setHeldButtons([]);
    this.runFramesObserved(POST_INPUT_SETTLE_FRAMES);
    this.frame += holdFrames + POST_INPUT_SETTLE_FRAMES;
    this.inputCount += 1;
  }

  public advanceFrames(frames: number): void {
    this.core.setHeldButtons([]);
    this.runFramesObserved(frames);
    this.frame += frames;
  }

  public gameState(): ReturnType<GbaCoreSeam["gameState"]> {
    return {
      mode: "unknown",
      inputReady: false,
      position: { mapId: "undecoded", x: 0, y: 0 },
      facing: "south",
      dialogLineIndex: 0,
      menu: null,
      inventory: [],
      party: [],
      activePartySlot: 0,
      battle: null,
      frame: this.frame,
      inputCount: this.inputCount,
    };
  }

  public ramStateSha256(): string {
    return sha256(Buffer.concat([this.core.readEwram(), this.core.readIwram()]));
  }

  public framebufferSha256(): string {
    return sha256(this.framebufferSnapshot().bytes);
  }

  public framebufferSnapshot(): MgbaFramebuffer {
    const frame = this.core.framebuffer();
    if (!frame) throw new Error("No framebuffer has been rendered yet");
    return frame;
  }
}
