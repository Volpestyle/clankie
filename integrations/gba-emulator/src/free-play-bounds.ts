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

/**
 * How many consecutive identical action-and-effect turns pass before the view
 * says so.
 *
 * The tile-stall signal answers "am I getting anywhere" and is deliberately
 * suppressed wherever he has no position — mid-battle, mid-menu, mid-warp — so
 * the loop that ate a whole session (Run refused from a wild battle, chosen
 * again every turn against the same refusal) was invisible to every counter the
 * loop kept. Identical action *and* identical effect is the state-independent
 * shape of that failure: a different effect means something moved, and a
 * different action means he tried something else.
 *
 * Three is where a repeat stops reading as persistence. Legitimately repeated
 * actions change their effect line — each `advance_dialog` reads new text, each
 * step reports a new tile — so a genuine third identical result is already the
 * exception rather than the rhythm of play.
 */
export const FREE_PLAY_REPEAT_TURNS = 3;
