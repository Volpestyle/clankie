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
export interface GbaCoreSeam {
  readonly coreId: string;
  /** Hold `button` for `holdFrames` frames, then release. */
  pressButton(button: GbaButton, holdFrames: number): void;
  /** Advance `frames` frames with no input held. */
  advanceFrames(frames: number): void;
  /** Typed game-state view decoded from the core's authoritative state. */
  gameState(): GbaCoreState;
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
