import type { GbaButton } from "@clankie/interactive-environment";
import { sha256 } from "./core-double.ts";
import type { GbaCoreState } from "./core-double.ts";
import type { GbaCoreSeam } from "./core-seam.ts";
import { decodeFireRedState, FIRERED_US_V10_ROM_SHA256 } from "./firered-state.ts";
import { MgbaLibretroCore, mgbaCoreWasmSha256, type MgbaFramebuffer } from "./mgba-core.ts";

/**
 * Real GBA core behind the adapter seam: the pinned headless mGBA WASM core
 * running an operator-supplied FireRed ROM, decoded through the verified
 * EWRAM/IWRAM map. ROM and savestate bytes stay in-process; only their SHA-256
 * identity digests are carried in contracts and evidence.
 *
 * The version-pinned state view decodes overworld position/facing, encrypted
 * party records, active battle participants, HP, outcome, and move cursor.
 * Dialog and field-menu observations remain closed until their own RAM
 * profiles are live-verified.
 *
 * Determinism: frame-stepped execution from the pinned savestate. Every input
 * runs `holdFrames` held frames plus a fixed 32-frame settle so a walk step
 * (16 frames/tile) always completes before the next observation.
 */

/** Frames run with no input after each press so movement fully settles. */
export const POST_INPUT_SETTLE_FRAMES = 32;
/** Frames rendered after restoring the savestate so a framebuffer exists. */
const WARMUP_FRAMES_AFTER_RESTORE = 2;

/**
 * Emulated frames between observations while an action runs.
 *
 * A GBA renders at ~59.7fps, so a chunk of 3 yields ~20 observations per second
 * — the rate the frame stream already publishes at. Smaller chunks cost more
 * encodes for frames the stream would drop as duplicates.
 */
const OBSERVE_CHUNK_FRAMES = 3;

/** Wall-clock milliseconds one emulated frame represents. */
const FRAME_INTERVAL_MS = 1_000 / 59.7275;

/**
 * Sleep synchronously.
 *
 * The core seam is synchronous, and making it async to add pacing would ripple
 * through the adapter, the runtime, and every scenario. `Atomics.wait` blocks
 * this thread precisely and without spinning a CPU, which is what a frame
 * pacer needs.
 */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

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
  private readonly romBytes: Uint8Array;
  private readonly mapId: string;
  private readonly verifiedIdentity: MgbaFireRedCoreIdentity;
  private frame = 0;
  private inputCount = 0;
  private battleSequence = 0;
  private battleTurn = 1;
  private priorBattleHp: string | null = null;
  private retainedBattle: GbaCoreState["battle"] = null;
  private retainedBattleMode: GbaCoreState["mode"] = "overworld";
  private retainedActivePartySlot = 0;

  private constructor(
    coreId: string,
    core: MgbaLibretroCore,
    romBytes: Uint8Array,
    mapId: string,
    identity: MgbaFireRedCoreIdentity,
  ) {
    this.coreId = coreId;
    this.core = core;
    this.romBytes = romBytes;
    this.mapId = mapId;
    this.verifiedIdentity = identity;
  }

  public static async create(init: MgbaFireRedCoreInit): Promise<MgbaFireRedCore> {
    const romSha256 = sha256(init.romBytes);
    if (romSha256 !== init.romSha256) {
      throw new Error("ROM bytes do not match the pinned ROM identity digest");
    }
    if (romSha256 !== FIRERED_US_V10_ROM_SHA256) {
      throw new Error("ROM identity has no supported FireRed RAM profile");
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
    return new MgbaFireRedCore(init.coreId, core, init.romBytes.slice(), init.mapId, {
      romSha256,
      savestateSha256,
      coreWasmSha256,
    });
  }

  /** The digests actually verified at creation time. */
  public identity(): MgbaFireRedCoreIdentity {
    return { ...this.verifiedIdentity };
  }

  /**
   * Watch the screen *during* an action, and optionally play it at the speed
   * real hardware would.
   *
   * Without this, one action produces exactly one observable frame: the core
   * only advances when told to, so a watcher sees the character teleport a tile
   * rather than walk it. Chunking the run is what makes the motion visible;
   * pacing is what makes it look like gameplay instead of a burst of frames
   * delivered in a few milliseconds followed by a freeze.
   *
   * Both are opt-in and off by default, so deterministic scenarios keep running
   * at full speed with unchanged behaviour. Splitting `runFrames(n)` into chunks
   * is emulation-equivalent — the held buttons do not change across the split.
   */
  public observeFrames(observer: (() => void) | null, options: { pace?: boolean } = {}): void {
    this.frameObserver = observer;
    this.paceToWallClock = options.pace ?? false;
  }

  private frameObserver: (() => void) | null = null;
  private paceToWallClock = false;

  /** Run frames, surfacing intermediate ones when someone is watching. */
  private runFramesObserved(frames: number): void {
    const observer = this.frameObserver;
    if (observer === null && !this.paceToWallClock) {
      this.core.runFrames(frames);
      return;
    }
    let remaining = frames;
    while (remaining > 0) {
      const chunk = Math.min(OBSERVE_CHUNK_FRAMES, remaining);
      const startedAt = performance.now();
      this.core.runFrames(chunk);
      remaining -= chunk;
      observer?.();
      if (this.paceToWallClock) {
        sleepSync(chunk * FRAME_INTERVAL_MS - (performance.now() - startedAt));
      }
    }
  }

  public pressButton(button: GbaButton, holdFrames: number): void {
    if (this.retainedBattleMode === "battle_won" || this.retainedBattleMode === "battle_lost") {
      this.priorBattleHp = null;
      this.retainedBattle = null;
      this.retainedBattleMode = "overworld";
      this.retainedActivePartySlot = 0;
    }
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

  public gameState(): GbaCoreState {
    const decoded = decodeFireRedState(
      {
        ewram: this.core.readEwram(),
        iwram: this.core.readIwram(),
      },
      this.romBytes,
    );
    let mode: GbaCoreState["mode"] = "overworld";
    let battle: GbaCoreState["battle"] = null;
    let activePartySlot = 0;
    if (decoded.battle) {
      if (this.priorBattleHp === null) {
        this.battleSequence += 1;
        this.battleTurn = 1;
      }
      const hpKey = `${String(decoded.battle.opponent.currentHp)}:${decoded.party
        .map((member) => member.currentHp)
        .join(",")}`;
      if (this.priorBattleHp !== null && hpKey !== this.priorBattleHp) this.battleTurn += 1;
      this.priorBattleHp = hpKey;
      switch (decoded.battle.outcome) {
        case 0:
          mode = "battle";
          break;
        case 1:
          mode = "battle_won";
          break;
        case 2:
        case 9:
          mode = "battle_lost";
          break;
        default:
          throw new Error(
            `Unsupported FireRed battle outcome ${String(decoded.battle.outcome)}; refusing to infer victory`,
          );
      }
      activePartySlot = decoded.battle.activePartySlot;
      battle = {
        battleId: `firered-${this.verifiedIdentity.romSha256.slice(0, 12)}-${String(this.battleSequence)}`,
        turn: this.battleTurn,
        opponentHp: decoded.battle.opponent.currentHp,
        moveCursor: decoded.battle.moveCursor,
        inputMode: decoded.battle.inputMode,
        actionCursor: decoded.battle.actionCursor,
        opponent: {
          speciesId: decoded.battle.opponent.speciesId,
          level: decoded.battle.opponent.level,
          maxHp: decoded.battle.opponent.maxHp,
        },
      };
      this.retainedBattle = structuredClone(battle);
      this.retainedBattleMode = mode;
      this.retainedActivePartySlot = activePartySlot;
    } else if (
      this.priorBattleHp !== null &&
      (this.retainedBattleMode === "battle_won" || this.retainedBattleMode === "battle_lost")
    ) {
      // Preserve the terminal state across repeated observations after the
      // engine clears `gMain.inBattle`; the next battle replaces it.
      mode = this.retainedBattleMode;
      battle = structuredClone(this.retainedBattle);
      activePartySlot = this.retainedActivePartySlot;
    } else {
      this.priorBattleHp = null;
      this.retainedBattle = null;
      this.retainedBattleMode = "overworld";
      this.retainedActivePartySlot = 0;
      if (decoded.dialogLines.length > 0) mode = "dialog";
    }
    return {
      mode,
      inputReady: decoded.fieldInputReady,
      position: {
        mapId: decoded.mapIdentity?.mapId ?? this.mapId,
        x: decoded.overworld.x,
        y: decoded.overworld.y,
      },
      facing: decoded.overworld.facing,
      dialogLineIndex: 0,
      dialogLines: decoded.dialogLines,
      menu: decoded.menu,
      inventory: decoded.inventory,
      party: decoded.party,
      activePartySlot,
      battle,
      frame: this.frame,
      inputCount: this.inputCount,
    };
  }

  public ramStateSha256(): string {
    return sha256(Buffer.concat([this.core.readEwram(), this.core.readIwram()]));
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
