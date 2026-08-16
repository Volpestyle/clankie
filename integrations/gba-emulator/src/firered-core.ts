import type { GbaButton } from "@clankie/interactive-environment";
import { sha256 } from "./core-double.ts";
import type { GbaCoreState } from "./core-double.ts";
import type { GbaCoreMapGrid, GbaCoreSeam } from "./core-seam.ts";
import { decodeFireRedMapGrid, isFireRedTilePassable, FIRERED_MAP_BORDER_OFFSET } from "./firered-ram-map.ts";
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
 * One frame per observation is hardware rate: what a watcher sees is what the
 * console drew. A chunk of 3 showed every third frame, which reads as a stutter
 * through the 16-frame walk cycle rather than as walking. It cost nothing to
 * fix because the activity stream publishes the native 240x160 screen: measured
 * on the FireRed bedroom state, 3.2KB base64 at 1.68ms encode, so 60fps costs
 * fewer milliseconds and the same bytes as the 3x-upscaled 20fps it replaces.
 */
const OBSERVE_CHUNK_FRAMES = 1;

/** Wall-clock milliseconds one emulated frame represents. */
const FRAME_INTERVAL_MS = 1_000 / 59.7275;

/**
 * Wait `ms` while leaving the event loop free.
 *
 * This was `Atomics.wait`, which paces precisely but blocks the whole thread:
 * measured on 2026-08-15, a single 600-frame action fired 0 of the ~731 timer
 * ticks due during it. Nothing else in the process ran for the duration of an
 * action, so nothing could flush: the frames a watcher was owed piled up in the
 * socket the runner publishes through and arrived as a burst when the action
 * ended, which is what "frozen, then it teleports" actually was. The HTTP API,
 * the Discord turn, and the voice seam were just as stuck.
 */
function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((done) => setTimeout(done, ms));
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

/**
 * `gBattleOutcome` → core mode. Only victory (1) and defeat (2, forfeit 9)
 * are terminal modes; every other engine-defined ending — drew (3), ran (4),
 * teleported (5, 10), opponent fled (6), caught (7), out of Safari Balls
 * (8) — leaves exit text on screen with `gMain.inBattle` still set, so the
 * battle is still "resolving" and its text must stay advanceable. The decoder
 * has already rejected outcomes above 10 as out of domain.
 */
export function battleModeForOutcome(outcome: number): "battle" | "battle_won" | "battle_lost" {
  if (outcome === 1) return "battle_won";
  if (outcome === 2 || outcome === 9) return "battle_lost";
  return "battle";
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

  /** Serialize the complete core state, for an operator-local checkpoint. */
  public saveState(): Uint8Array {
    return this.core.saveState();
  }

  /**
   * Restore previously serialized state mid-session.
   *
   * Derived battle bookkeeping is reset because it describes the replaced
   * timeline, not the restored one. The logical frame and input counters keep
   * counting: they order evidence within this process run, and restoring RAM
   * does not rewind what already happened here.
   */
  public loadState(bytes: Uint8Array): void {
    this.core.loadState(bytes);
    this.core.setHeldButtons([]);
    this.core.runFrames(WARMUP_FRAMES_AFTER_RESTORE);
    this.priorBattleHp = null;
    this.retainedBattle = null;
    this.retainedBattleMode = "overworld";
    this.retainedActivePartySlot = 0;
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
  /** True while an action owns the core, so idle ticks stand off. */
  private running = false;

  /** Console-clock frames between actions. See `GbaCoreSeam.idleFrames`. */
  public idleFrames(frames: number): void {
    if (this.running || frames <= 0) return;
    this.core.setHeldButtons([]);
    this.core.runFrames(frames);
    this.frame += frames;
    this.frameObserver?.();
  }

  /**
   * Run frames, surfacing intermediate ones when someone is watching.
   *
   * Paced against a deadline rather than per-chunk: sleeping `interval - work`
   * each time accumulates every rounding error, which ran the 2026-08-15 loop
   * 16% slow. Anchoring on `startedAt` lets a late frame be made up by the next
   * one, so a watched action takes the wall-clock time the console would.
   */
  private async runFramesObserved(frames: number): Promise<void> {
    const observer = this.frameObserver;
    if (observer === null && !this.paceToWallClock) {
      this.core.runFrames(frames);
      return;
    }
    // Held across the awaits: an idle tick that fired between two paced frames
    // would clear the buttons this action is still holding.
    this.running = true;
    try {
      const startedAt = performance.now();
      let done = 0;
      while (done < frames) {
        const chunk = Math.min(OBSERVE_CHUNK_FRAMES, frames - done);
        this.core.runFrames(chunk);
        done += chunk;
        observer?.();
        if (this.paceToWallClock) {
          await delay(startedAt + done * FRAME_INTERVAL_MS - performance.now());
        }
      }
    } finally {
      this.running = false;
    }
  }

  public async pressButton(button: GbaButton, holdFrames: number): Promise<void> {
    if (this.retainedBattleMode === "battle_won" || this.retainedBattleMode === "battle_lost") {
      this.priorBattleHp = null;
      this.retainedBattle = null;
      this.retainedBattleMode = "overworld";
      this.retainedActivePartySlot = 0;
    }
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

  /**
   * Advance frames with `button` held, spending no input. FireRed zeroes the
   * text printer's per-character delay while A/B is held, so holding through a
   * printing box reads it at accelerated speed. The last frame always runs
   * released: a button held straight into a `pressButton` would never produce
   * the fresh-press edge the wait-for-press native requires.
   */
  public async advanceFramesHolding(button: GbaButton, frames: number): Promise<void> {
    if (frames <= 0) return;
    if (frames > 1) {
      this.core.setHeldButtons([button]);
      await this.runFramesObserved(frames - 1);
    }
    this.core.setHeldButtons([]);
    await this.runFramesObserved(1);
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
      mode = battleModeForOutcome(decoded.battle.outcome);
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
      surroundings: decoded.surroundings,
      mapSize: decoded.mapSize,
      exits: decoded.exits,
      dialogLineIndex: 0,
      dialogLines: decoded.dialogLines,
      waitingForDialogAdvance: decoded.waitingForDialogAdvance,
      naming: decoded.naming,
      menu: decoded.menu,
      inventory: decoded.inventory,
      party: decoded.party,
      activePartySlot,
      battle,
      frame: this.frame,
      inputCount: this.inputCount,
    };
  }

  /**
   * Collision for pathing, read from the live map buffer.
   *
   * Null while no map grid is loaded — a battle or a mid-warp — so a caller
   * plans against real collision or not at all.
   */
  public mapGrid(): GbaCoreMapGrid | null {
    let grid;
    try {
      grid = decodeFireRedMapGrid(this.core.readIwram(), this.core.readEwram());
    } catch {
      return null;
    }
    const min = FIRERED_MAP_BORDER_OFFSET;
    return {
      minX: min,
      minY: min,
      maxX: min + grid.mapWidth,
      maxY: min + grid.mapHeight,
      isPassable: (x, y) => isFireRedTilePassable(grid, x, y),
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
