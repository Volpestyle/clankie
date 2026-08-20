import type { GbaButton } from "@clankie/interactive-environment";
import { z } from "zod";
import { Sha256Schema } from "./contracts.ts";
import { sha256 } from "./core-double.ts";
import type { GbaCoreSeam } from "./core-seam.ts";
import {
  MgbaLibretroCore,
  mgbaCoreWasmSha256,
  type MgbaCoreIdentity,
  type MgbaFramebuffer,
} from "./mgba-core.ts";

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

const POST_INPUT_SETTLE_FRAMES = 32;
const WARMUP_FRAMES_AFTER_RESTORE = 2;

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
  private readonly verifiedIdentity: MgbaCoreIdentity;
  private readonly configuredBootSavestate: Uint8Array;
  private frame = 0;
  private inputCount = 0;
  private frameObserver: (() => void) | null = null;
  private paceToWallClock = false;

  private constructor(
    coreId: string,
    core: MgbaLibretroCore,
    verifiedIdentity: MgbaCoreIdentity,
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

  public identity(): MgbaCoreIdentity {
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

  /** Console-clock frames between actions. See `GbaCoreSeam.idleFrames`. */
  public idleFrames(frames: number): void {
    if (this.core.idleFrames(frames, this.frameObserver)) this.frame += frames;
  }

  /** Deadline-paced and non-blocking — see the FireRed core's note. */
  private async runFramesObserved(frames: number): Promise<void> {
    const observer =
      this.frameObserver === null && !this.paceToWallClock ? null : () => this.frameObserver?.();
    await this.core.runFramesObserved(frames, observer, () => this.paceToWallClock);
  }

  public async pressButton(button: GbaButton, holdFrames: number): Promise<void> {
    this.core.setHeldButtons([button]);
    await this.runFramesObserved(holdFrames);
    this.core.setHeldButtons([]);
    await this.runFramesObserved(POST_INPUT_SETTLE_FRAMES);
    this.frame += holdFrames + POST_INPUT_SETTLE_FRAMES;
    this.inputCount += 1;
  }

  public async advanceFrames(frames: number): Promise<void> {
    this.core.setHeldButtons([]);
    await this.runFramesObserved(frames);
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
