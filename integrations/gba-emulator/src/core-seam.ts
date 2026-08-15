import type { GbaButton } from "@clankie/interactive-environment";
import type { GbaCoreState } from "./core-double.ts";

/**
 * Adapter-facing core seam (ADR 0039 / ADR 0040). The governed
 * `GbaEmulatorSession` drives exactly this surface and nothing else, so the
 * deterministic CI test double (`DeterministicGbaCoreDouble`) and the real
 * headless mGBA core (`MgbaFireRedCore`) are interchangeable behind it:
 * button input consuming frames, an honest typed state view (or `unknown`), and
 * RAM/framebuffer digests for hash-chained evidence.
 */
/**
 * Read-only collision view of the loaded map, for planning a route before
 * walking it. Bounds are in the same coordinate space as `GbaCoreState.position`
 * and `max` is exclusive.
 *
 * Deliberately a query rather than a field on `GbaCoreState`: the state view is
 * cloned on every read, and copying a whole map grid per observation would make
 * looking expensive to pay for a capability only pathing uses.
 */
export interface GbaCoreMapGrid {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /**
   * Whether tile collision leaves this tile open. It does not account for
   * NPCs, which occupy tiles without appearing in collision, so a planned route
   * must still be verified step by step.
   */
  isPassable(x: number, y: number): boolean;
}

export interface GbaCoreSeam {
  readonly coreId: string;
  /**
   * Hold `button` for `holdFrames` frames, then release.
   *
   * Asynchronous because a watched core paces itself to hardware speed, and
   * pacing that blocks the thread stops everything else in the process for the
   * length of an action — including the socket flush the watcher's frames need.
   */
  pressButton(button: GbaButton, holdFrames: number): Promise<void>;
  /** Advance `frames` frames with no input held. */
  advanceFrames(frames: number): Promise<void>;
  /**
   * Advance `frames` frames with `button` held, spending no input. FireRed's
   * text printer zeroes its per-character delay while A/B is held — the
   * fast-read every human does — so holding through a printing box collapses
   * the wait. The final frame runs released so a following press still lands
   * as a fresh edge. Optional: a core without it prints at its configured
   * text speed and `advance_dialog` simply waits longer.
   */
  advanceFramesHolding?(button: GbaButton, frames: number): Promise<void>;
  /**
   * Run `frames` frames off the console's own clock, spending no input and
   * counting toward nothing.
   *
   * This is what keeps a watched game alive while its player is thinking: the
   * core otherwise advances only when an action drives it, so the screen holds
   * a single frame for the whole gap. Synchronous and unpaced — the caller's
   * timer is the clock — and a no-op while an action is running, because an
   * idle frame landing mid-press would release a button the action still holds.
   * Optional: a core without it simply freezes between actions, as before.
   */
  idleFrames?(frames: number): void;
  /** Typed game-state view decoded from the core's authoritative state. */
  gameState(): GbaCoreState;
  /**
   * Collision grid for pathing, or null when no map is loaded. Optional so a
   * core that models no map stays conformant; `walk_to` then fails closed.
   */
  mapGrid?(): GbaCoreMapGrid | null;
  /** Digest of the core's system RAM for evidence chaining. */
  ramStateSha256(): string;
  /** Digest of the latest rendered framebuffer. */
  framebufferSha256(): string;
}

/**
 * Structural subset of a frozen scenario the adapter itself consumes. The
 * frozen trainer-battle scenario (`FrozenGbaScenario`) satisfies it directly;
 * real-core scenarios without a scripted trainer omit `trainer`, and the
 * dialog/battle observation kinds then fail closed.
 */
export interface GbaAdapterScenario {
  readonly scenarioId: string;
  readonly scenarioVersion: number;
  readonly coreId: string;
  readonly savestateId: string;
  readonly savestateSha256: string;
  readonly rngSeed: number;
  readonly worldId: string;
  readonly maxEvidenceEvents: number;
  readonly maxDecisions: number;
  readonly player: { readonly characterId: string };
  readonly trainer?: {
    readonly trainerId: string;
    readonly dialog: readonly string[];
    readonly opponent: { readonly speciesId: string; readonly level: number; readonly maxHp: number };
  };
}

export type GbaCoreFactory = (scenario: GbaAdapterScenario) => GbaCoreSeam;
