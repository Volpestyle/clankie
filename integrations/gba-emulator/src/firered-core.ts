import type { GbaButton } from "@clankie/interactive-environment";
import { sha256 } from "./core-double.ts";
import type { GbaCoreState } from "./core-double.ts";
import type { GbaCoreSeam } from "./core-seam.ts";
import { decodeFireRedOverworld } from "./firered-ram-map.ts";
import { MgbaLibretroCore, mgbaCoreWasmSha256, type MgbaFramebuffer } from "./mgba-core.ts";

/**
 * Real GBA core behind the adapter seam: the pinned headless mGBA WASM core
 * running an operator-supplied FireRed ROM, decoded through the verified
 * EWRAM map. ROM and savestate bytes stay in-process; only their SHA-256
 * identity digests are carried in contracts and evidence.
 *
 * This slice decodes overworld state only (position + facing). The state view
 * therefore always reports `mode: "overworld"` with an empty party and no
 * battle; dialog/battle/menu observations fail closed at the adapter until a
 * later slice verifies those RAM fields. Facing values map to the observation
 * vocabulary as south/north/west/east.
 *
 * Determinism: frame-stepped execution from the pinned savestate. Every input
 * runs `holdFrames` held frames plus a fixed 32-frame settle so a walk step
 * (16 frames/tile) always completes before the next observation.
 */

/** Frames run with no input after each press so movement fully settles. */
export const POST_INPUT_SETTLE_FRAMES = 32;
/** Frames rendered after restoring the savestate so a framebuffer exists. */
const WARMUP_FRAMES_AFTER_RESTORE = 2;

export interface MgbaFireRedCoreInit {
  coreId: string;
  /** ROM bytes read by the caller from the operator-supplied path. */
  romBytes: Uint8Array;
  /** Pinned savestate bytes read by the caller from the operator-local path. */
  savestateBytes: Uint8Array;
  /** Pinned identity digests; creation fails closed on any mismatch. */
  romSha256: string;
  savestateSha256: string;
  coreWasmSha256: string;
  /** Scenario label attached to decoded coordinates (not decoded from RAM). */
  mapId: string;
}

export interface MgbaFireRedCoreIdentity {
  romSha256: string;
  savestateSha256: string;
  coreWasmSha256: string;
}

export class MgbaFireRedCore implements GbaCoreSeam {
  public readonly coreId: string;
  private readonly core: MgbaLibretroCore;
  private readonly mapId: string;
  private readonly verifiedIdentity: MgbaFireRedCoreIdentity;
  private frame = 0;
  private inputCount = 0;

  private constructor(coreId: string, core: MgbaLibretroCore, mapId: string, identity: MgbaFireRedCoreIdentity) {
    this.coreId = coreId;
    this.core = core;
    this.mapId = mapId;
    this.verifiedIdentity = identity;
  }

  public static async create(init: MgbaFireRedCoreInit): Promise<MgbaFireRedCore> {
    const romSha256 = sha256(init.romBytes);
    if (romSha256 !== init.romSha256) {
      throw new Error("ROM bytes do not match the pinned ROM identity digest");
    }
    const savestateSha256 = sha256(init.savestateBytes);
    if (savestateSha256 !== init.savestateSha256) {
      throw new Error("Savestate bytes do not match the pinned savestate identity digest");
    }
    const coreWasmSha256 = mgbaCoreWasmSha256();
    if (coreWasmSha256 !== init.coreWasmSha256) {
      throw new Error("mGBA core wasm does not match the pinned core identity digest");
    }
    const core = await MgbaLibretroCore.create();
    core.loadRom(init.romBytes);
    // One frame before unserialize so the core is fully in-game, then a short
    // warmup so the restored scene is rendered; the logical frame counter
    // starts at zero at the pinned savestate.
    core.setHeldButtons([]);
    core.runFrames(1);
    core.loadState(init.savestateBytes);
    core.runFrames(WARMUP_FRAMES_AFTER_RESTORE);
    return new MgbaFireRedCore(init.coreId, core, init.mapId, {
      romSha256,
      savestateSha256,
      coreWasmSha256,
    });
  }

  /** The digests actually verified at creation time. */
  public identity(): MgbaFireRedCoreIdentity {
    return { ...this.verifiedIdentity };
  }

  public pressButton(button: GbaButton, holdFrames: number): void {
    this.core.setHeldButtons([button]);
    this.core.runFrames(holdFrames);
    this.core.setHeldButtons([]);
    this.core.runFrames(POST_INPUT_SETTLE_FRAMES);
    this.frame += holdFrames + POST_INPUT_SETTLE_FRAMES;
    this.inputCount += 1;
  }

  public advanceFrames(frames: number): void {
    this.core.setHeldButtons([]);
    this.core.runFrames(frames);
    this.frame += frames;
  }

  public gameState(): GbaCoreState {
    const overworld = decodeFireRedOverworld(this.core.readEwram());
    return {
      mode: "overworld",
      position: { mapId: this.mapId, x: overworld.x, y: overworld.y },
      facing: overworld.facing,
      dialogLineIndex: 0,
      party: [],
      activePartySlot: 0,
      battle: null,
      frame: this.frame,
      inputCount: this.inputCount,
    };
  }

  public ramStateSha256(): string {
    return sha256(this.core.readEwram());
  }

  public framebufferSha256(): string {
    const frame = this.core.framebuffer();
    if (!frame) throw new Error("No framebuffer has been rendered yet");
    return sha256(frame.bytes);
  }

  /** Latest framebuffer for artifact-plane screenshot capture. */
  public framebufferSnapshot(): MgbaFramebuffer {
    const frame = this.core.framebuffer();
    if (!frame) throw new Error("No framebuffer has been rendered yet");
    return frame;
  }
}
