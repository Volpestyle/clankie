/**
 * Bounds on the model text free play produces, in their own module.
 *
 * Voice needs them and the loop imports Voice, so keeping them in `free-play.ts`
 * made a real import cycle: the constants would still be in their temporal dead
 * zone when the voice module body evaluated them.
 */

/**
 * Free play: the model chooses, not an algorithm.
 *
 * The existing scenario drivers compute every action (`nextRealRouteStep` is
 * BFS, move selection is an argmax). They are deterministic and their receipts
 * are byte-identical across two fresh cores. This driver is the opposite: the
 * decision comes from a model, so no run reproduces another.
 *
 * That trade is deliberate and it does not weaken the deterministic scenarios,
 * which still run unchanged. What a free-play run asserts instead is recorded
 * per turn: that every action was legal, that observation → monologue → action
 * → outcome is causally linked, that bounds held, and how often stated intent
 * matched the next action.
 */

/** Model text is untrusted and reaches operator surfaces, so it stays bounded. */
export const FREE_PLAY_MONOLOGUE_MAX = 600;
export const FREE_PLAY_INTENT_MAX = 200;
/**
 * His own running notes, carried across turns.
 *
 * Bounded like every other model text field, and bounded for a second reason:
 * an unbounded scratchpad becomes an ever-growing prompt, which is the cost
 * problem this loop already has. A cap forces him to keep what matters.
 */
export const FREE_PLAY_NOTES_MAX = 800;
/** A standing objective, e.g. "get downstairs and out of the house". */
export const FREE_PLAY_OBJECTIVE_MAX = 160;
/** What someone said to him. Bounded like every other untrusted string. */
export const FREE_PLAY_INTERJECTION_MAX = 500;
/** What he says back. Discord's own message limit. */
export const FREE_PLAY_REPLY_MAX = 2_000;
/** Something he chose to say unprompted. */
export const FREE_PLAY_SPEAK_MAX = 400;
/**
 * Minimum turns between unprompted remarks.
 *
 * A rate gate, deliberately not a content rule. Nothing here decides *what* is
 * worth saying — no "speak on a new map", no "speak after a battle" — because a
 * rule per trigger produces a narrator hitting marks. He reads the situation and
 * decides; this only stops him talking over himself.
 *
 * Because the gate is mechanical, the prompt must not *also* discourage
 * speaking. It did, and the two suppressions compounded into total silence: 0
 * of 16 turns on a measured run. The gate is the ceiling, so the prompt is free
 * to invite him.
 */
export const FREE_PLAY_SPEAK_COOLDOWN_TURNS = 4;
