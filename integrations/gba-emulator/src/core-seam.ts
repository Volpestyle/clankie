import type { GbaButton } from "@clankie/interactive-environment";
import type { GbaCoreState } from "./core-double.ts";

/**
 * Adapter-facing core seam (ADR 0039 / ADR 0040). The governed
 * `GbaEmulatorSession` drives exactly this surface and nothing else, so the
 * deterministic CI test double (`DeterministicGbaCoreDouble`) and the real
 * headless mGBA core (`MgbaFireRedCore`) are interchangeable behind it:
 * button input consuming frames, a typed RAM-derived state view, and
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
  /** Hold `button` for `holdFrames` frames, then release. */
  pressButton(button: GbaButton, holdFrames: number): void;
  /** Advance `frames` frames with no input held. */
  advanceFrames(frames: number): void;
  /**
   * Advance `frames` frames with `button` held, spending no input. FireRed's
   * text printer zeroes its per-character delay while A/B is held — the
   * fast-read every human does — so holding through a printing box collapses
   * the wait. The final frame runs released so a following press still lands
   * as a fresh edge. Optional: a core without it prints at its configured
   * text speed and `advance_dialog` simply waits longer.
   */
  advanceFramesHolding?(button: GbaButton, frames: number): void;
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
