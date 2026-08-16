/**
 * The world as a body (VUH-970).
 *
 * `runFreePlay` drives exactly one seam — `GbaDriverIo` — and everything above
 * it (the model mind, the voice, interjections, the journal, progress) never
 * learns where the body is. So playing in a hosted pokeagent-mmo world is not a
 * second play loop: it is a second implementation of that seam, plus a frame
 * source, composed by the same execution the local body already uses.
 *
 * The shape here deliberately mirrors `BootedGbaGame` — `framePng()` plus
 * `observeFrames(observer)` — because the activity publish path in
 * `play-execution.ts` is proven (digest dedupe so an idle screen costs no
 * bandwidth, dropped frames counted rather than swallowed) and porting it
 * verbatim is worth more than a tidier signature.
 *
 * What is genuinely different, and must not be papered over:
 *
 * - **There is no pause.** One player cannot stop a shared world. `pause()`
 *   stops *him* acting; the world keeps running and other players keep moving.
 * - **The screen can change with no action of his.** Another player walks past,
 *   an NPC moves. A local body only advances when driven.
 * - **A body can be replaced under him** (a region crossing, an operator
 *   takeover). `bodyGeneration` is how that is detected; everything cached
 *   about the screen is stale when it moves.
 */
import type { GbaDriverIo } from "@clankie/gba-emulator";
import type { EmbodimentEnvironmentId } from "@clankie/protocol";
import type { SessionStatus, WhoResult } from "@pokeagent-mmo/world-protocol";

export interface WorldBody {
  /** The only seam `runFreePlay` touches. */
  readonly io: GbaDriverIo;
  /** Latest world frame as PNG bytes; null until the first frame arrives. */
  readonly framePng: () => Uint8Array | null;
  /**
   * Watch the screen as the world paints it. Null detaches.
   *
   * Unlike the local body this needs no `pace` option — the world advances its
   * own cores at hardware speed and publishes as it goes, so frames arrive
   * paced already.
   */
  readonly observeFrames: (observer: (() => void) | null) => void;
  /**
   * Frames the world reported this subscriber missed, cumulative. The world
   * drops rather than queues so a slow reader cannot stall the stream, and it
   * reports the count so a consumer knows not to assume smooth motion.
   */
  readonly droppedFrameCount: () => number;
  readonly session: () => Promise<SessionStatus>;
  /** Who else is here — the answer he voices, and the reason this exists. */
  readonly who: () => Promise<WhoResult>;
  /** Leaves the world and releases the body. Always call it. */
  readonly close: () => Promise<void>;
}

/**
 * Why a join did not happen, in the vocabulary he says out loud. Distinct from
 * `start_play`'s refusals on purpose: `body_held` is about his own machine,
 * these are all about a world somewhere else.
 */
export type WorldJoinRefusal =
  | "no_credential"
  | "world_unreachable"
  | "world_refused"
  | "region_not_hosted"
  | "world_full";

export type WorldJoinResult =
  | { outcome: "joined"; body: WorldBody }
  | { outcome: "refused"; reason: WorldJoinRefusal; detail?: string };

export interface WorldJoinOptions {
  environmentId: EmbodimentEnvironmentId;
  /** Where to land. Absent means the world's default entry region. */
  regionId?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Join the world and return a drivable body.
 *
 * The credential is resolved here from operator configuration and is **not** a
 * parameter, so no caller — and in particular no model — can name the principal
 * it joins as. Identity is provisioned, never asserted; a mind that could spell
 * another player's credential is the hole VUH-976 closed on the world side, and
 * a client that accepted one as an argument would reopen it from this side.
 *
 * Deny-by-default: with nothing provisioned this refuses `no_credential`.
 */
export function joinWorld(_options: WorldJoinOptions): Promise<WorldJoinResult> {
  throw new Error("world_body_not_implemented");
}
