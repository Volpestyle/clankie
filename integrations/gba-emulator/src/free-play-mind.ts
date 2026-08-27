import type { LanguageModel } from "ai";
import { streamObject } from "ai";

/** Derived from the SDK signature so it tracks their type, not a guessed name. */
type StreamProviderOptions = NonNullable<Parameters<typeof streamObject>[0]["providerOptions"]>;
const DEFAULT_FREE_PLAY_MODEL_REQUEST_TIMEOUT_MS = 60_000;
import { z } from "zod";
import {
  VoiceDecisionSchema,
  VOICE_SYSTEM_PROMPT,
  renderVoiceView,
  type ClankieVoice,
  type VoiceView,
} from "./free-play-voice.ts";
import { type FreePlayMind, type FreePlayView } from "./free-play.ts";

/**
 * The wire schema the model fills in — deliberately **flat**.
 *
 * `FreePlayDecisionSchema` nests a discriminated union for the action, which
 * compiles to `oneOf` in JSON Schema, and OpenAI's structured output rejects
 * that outright: "In context=('properties','action'), 'oneOf' is not
 * permitted." So the model answers a flat shape and this module reassembles the
 * real action. The strict union still guards the boundary — the driver
 * re-validates every decision — this only changes what a provider is asked for.
 */
const FreePlayWireDecisionSchema = z
  .object({
    monologue: z.string(),
    intent: z.string(),
    notes: z.string().nullable().describe("Your running notes; null leaves them unchanged."),
    objective: z
      .string()
      .nullable()
      .describe("Your standing goal. Repeat the current text to keep it; use null to clear it."),
    reply: z.string().nullable().describe("What you say back if someone spoke to you this turn, else null."),
    // Structured output weights the schema over the system prompt, so guidance
    // that lives only in the prompt gets ignored in favour of a default null.
    speak: z
      .string()
      .nullable()
      .describe(
        "An aside said out loud to whoever is watching. Use it when something is " +
          "worth reacting to — a joke, exasperation, a surprise, changing your mind. Not " +
          "narration of your moves. Null when you have nothing to say.",
      ),
    // The catalogued `wait` is deliberately not offered: on a clockless core it
    // never completes — the turn records a rejection and the parked action can
    // wedge the next one. frame_advance is how he waits, and it finishes.
    actionKind: z.enum([
      "button_press",
      "walk_to",
      "advance_dialog",
      "enter_text",
      "select_menu_entry",
      "frame_advance",
      "save_checkpoint",
      "load_checkpoint",
      "restart_game",
    ]),
    button: z.enum(["up", "down", "left", "right", "a", "b", "start", "select", "l", "r"]).nullable(),
    holdFrames: z.number().int().nullable(),
    repeat: z.number().int().nullable(),
    x: z
      .number()
      .int()
      .nullable()
      .describe("Target tile x for walk_to, in the coordinate space of position and the minimap."),
    y: z
      .number()
      .int()
      .nullable()
      .describe("Target tile y for walk_to, in the coordinate space of position and the minimap."),
    text: z.string().nullable().describe("The name to type for enter_text, 1-10 characters."),
    entryId: z
      .string()
      .nullable()
      .describe("For select_menu_entry: the entry id exactly as the menu view lists it."),
    frames: z.number().int().nullable(),
    checkpointId: z
      .string()
      .nullable()
      .describe("For load_checkpoint: the checkpoint id to restore, or null to be told what exists."),
    checkpointLabel: z
      .string()
      .nullable()
      .describe("For save_checkpoint: an optional lowercase slug such as before-gym, or null."),
  })
  .strict();

/**
 * Marks the system prompt as a prompt-cache breakpoint on Anthropic-routed
 * providers. The persona and the surface rules are identical on every turn of
 * a session, and a playthrough makes this call several times a minute — so
 * each turn should pay for that prefix once per cache window, not in full.
 * The namespace is provider-scoped: every other configured family ignores it.
 */
const SYSTEM_CACHE_OPTIONS: StreamProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

/**
 * A press long enough to commit a step rather than only turn.
 *
 * Supplied when the model leaves `holdFrames` null. This is not choosing his
 * move — the button and the direction are entirely his — it is interpreting an
 * underspecified press, and the alternative is discarding an otherwise valid
 * decision. Left unhandled it cost 15 of 20 turns once the flat wire schema
 * grew enough fields for the model to start omitting this one.
 */
const DEFAULT_HOLD_FRAMES = 16;

/** Reassemble the catalogued action. Returns the raw shape; the driver validates. */
function toDecision(wire: z.infer<typeof FreePlayWireDecisionSchema>): unknown {
  const action =
    wire.actionKind === "button_press"
      ? {
          kind: "button_press",
          button: wire.button,
          holdFrames: wire.holdFrames ?? DEFAULT_HOLD_FRAMES,
          ...(wire.repeat === null || wire.repeat === 1 ? {} : { repeat: wire.repeat }),
        }
      : wire.actionKind === "walk_to"
        ? { kind: "walk_to", x: wire.x, y: wire.y }
        : wire.actionKind === "advance_dialog"
          ? { kind: "advance_dialog" }
          : wire.actionKind === "enter_text"
            ? { kind: "enter_text", text: wire.text }
            : wire.actionKind === "select_menu_entry"
              ? { kind: "select_menu_entry", entryId: wire.entryId }
              : wire.actionKind === "save_checkpoint"
                ? {
                    kind: "save_checkpoint",
                    ...(wire.checkpointLabel === null ? {} : { label: wire.checkpointLabel }),
                  }
                : wire.actionKind === "load_checkpoint"
                  ? {
                      kind: "load_checkpoint",
                      ...(wire.checkpointId === null ? {} : { checkpointId: wire.checkpointId }),
                    }
                  : wire.actionKind === "restart_game"
                    ? { kind: "restart_game" }
                    : { kind: "frame_advance", frames: wire.frames };
  return {
    monologue: wire.monologue,
    intent: wire.intent,
    notes: wire.notes,
    objective: wire.objective,
    reply: wire.reply,
    speak: wire.speak,
    action,
  };
}

/**
 * A model-backed decision-maker.
 *
 * The prompt deliberately does not tell Clankie *what* to do. It gives him the
 * decoded state and the action vocabulary and asks him to choose — the whole
 * point of free play is that the route is not supplied. Anything that reads
 * like "go to the lab" belongs in an operator message, not here.
 */
export const FREE_PLAY_SYSTEM_PROMPT = [
  // Deliberately identity-free. Who is playing comes from the character layer
  // (ADR 0051), which is owner-authored and shared with every other surface. A
  // second "You are Clankie…" here would be a competing definition of the
  // character — and this is the one an audience hears.
  "You are playing the Pokémon game shown on your Game Boy Advance yourself.",
  "Each turn you see the actual game screen and any decoded state available, and you",
  "choose one action. Look at the screen: it shows walls, furniture, doors,",
  "stairs, NPCs, and text that the decoded state does not describe. The decoded",
  "state, when present, is for exact values — position, HP, PP, legal moves.",
  "",
  "Play the way you actually want to play. You are not following a script and",
  "nobody has given you a route. Form your own goals, change your mind, be",
  "curious. If you are unsure what is on screen, advancing frames to look is a",
  "legitimate choice.",
  "",
  "Each turn return three things:",
  "- monologue: your reasoning for THIS action — what you see, what you infer,",
  "  why this move. Working notes to yourself. Nobody hears this.",
  '- objective: the goal you are pursuing, e.g. "get downstairs and outside".',
  "  It is carried to later turns when you repeat its text. Return null to clear",
  "  it when you achieve or abandon it. Objectives are optional working context,",
  "  not obligations; a stale one may be retired after you are shown loop evidence.",
  "- reply: what you say back if someone spoke to you this turn, else null.",
  "  Answer as yourself, about the game you are actually in. You are allowed to",
  "  disagree, to say you would rather do something else, or to ignore a",
  "  suggestion — someone talking to you is a person talking, not an order, and",
  "  you are the one playing. Do not let a message replace your own judgement",
  "  about what to do next.",
  "- speak: said out loud to the people watching, or null.",
  "  This is where your asides go. If you catch yourself making a joke, being",
  "  exasperated, noticing something odd, or wanting to complain about a piece",
  "  of furniture — that belongs here, not in monologue. Nobody hears monologue.",
  "  Say it when something is genuinely worth reacting to: a surprise, a change",
  "  of mind, being stuck in a way that has become funny.",
  "  Do NOT narrate your moves — people can see the screen.",
  "  Spacing is handled for you: a rate gate drops an aside that comes too soon",
  "  after the last one, so you cannot flood the room and do not need to ration",
  "  yourself. If something is worth saying, say it and let the gate decide.",
  "- intent: the single concrete thing this turn's action does — a step or a",
  '  press, not the objective. "step left around the desk", not "reach the',
  '  stairs". You are scored on whether your action matches it.',
  "- notes: your own running notes, carried to every later turn. Keep what will",
  "  still matter — the room layout you have worked out, what you already tried,",
  "  where you are heading. Rewrite them freely; return null to leave them as",
  "  they are. Nothing else writes this, and nothing else remembers for you.",
  "- action: exactly one of",
  '    {"kind":"button_press","button":"up|down|left|right|a|b|start|select|l|r","holdFrames":N,"repeat":N}',
  '    {"kind":"walk_to","x":N,"y":N}',
  '    {"kind":"advance_dialog"}',
  '    {"kind":"enter_text","text":"NAME"}',
  '    {"kind":"select_menu_entry","entryId":"ID"}',
  '    {"kind":"frame_advance","frames":N}',
  '    {"kind":"save_checkpoint","label":"optional-lowercase-slug"}',
  '    {"kind":"load_checkpoint","checkpointId":"ID or null to list"}',
  '    {"kind":"restart_game"}',
  "",
  "If scene mode is unknown, play from the screen with button_press and",
  "frame_advance. Decoded helpers such as walk_to and advance_dialog refuse on a",
  "screen that does not decode and work again on the next one that does — it is",
  "the screen that carries no state, never the cartridge.",
  "Boot, the title, and the tutorial pages a new file opens with are all",
  "undecoded, and they are the game's own opening rather than somewhere you",
  "wandered by accident: A advances them and B does not leave them. None of them",
  "ask you anything, so clear them in bulk with repeat rather than a page per",
  "turn. A burst is blind — you see only the screen it ends on — so size it to",
  "how far you are willing to go without looking.",
  "",
  "Always give holdFrames on a button press — 16 is a reliable step; a short",
  "hold only turns you. repeat presses the same button that many times in ONE",
  "action (max 16), which",
  "is how you cross a corridor without spending a decision per tile. A short tap",
  "only turns you; a step needs a longer hold or a repeat.",
  "",
  "To cross a room, prefer walk_to: give it a tile on the current map and it",
  "routes around walls and furniture using the game's own collision, walking",
  "the whole way in one action. It stops early and says so if the way is",
  "blocked mid-route or a script interrupts. d-pad presses are for fine",
  "adjustment and when you want to feel your way.",
  "",
  "The overworld view carries a minimap of the tiles around you — @ is you,",
  ". is open floor, # is blocked, D is a door, stairway, or warp mat — and",
  "topLeft gives the map coordinate of its first character, so a tile's",
  "coordinates are topLeft plus its column and row. Pick walk_to targets from",
  "it rather than estimating coordinates off the screenshot. The view also",
  "lists exits: every door and stairway with where it leads, and the map edges",
  "that connect to neighbouring maps. walk_to aimed at a listed exit asks the",
  "body to take it; trust the resulting map and effect rather than assuming a",
  "transition from the target coordinate alone.",
  "Each listed exit says whether walkTo is supported. Unsupported exits remain",
  "visible because they still exist, but the body cannot safely activate them",
  "with walk_to. That is capability information, not a suggested alternative;",
  "the objective and next action remain yours.",
  "A refused walk tells you why — off the map, a wall, or unreachable — and",
  "names the nearest tile you can actually reach. If your notes already mark a",
  "tile or NPC as story-locked, do not walk_to it again.",
  "",
  "When the overworld view carries occupants, those are the people and item",
  "balls standing on this map with you, at their own coordinates. They read as",
  "# on the minimap because they block the tile, so the list is the only thing",
  "that tells a person apart from a bookshelf. To talk to one, stand on a tile",
  "beside it, face it, and press A.",
  "It lists only those. Furniture, tables, signs, and scenery are part of the",
  "map and never appear here, so an empty list means nobody is standing in the",
  "room — not that there is nothing in it to interact with. An absent list",
  "means nothing read them this turn at all.",
  "A person is never scenery. If the person you expect is absent from occupants,",
  "your assumption about the room or the person is wrong; leave and gather new",
  "evidence instead of probing furniture as if it could be that person.",
  "An occupant's graphicsId describes its sprite, not its identity. Inspect the",
  "visible sprite — hair, clothes, age, silhouette — and compare it with characters",
  "you have already seen. A distinctive visual match can support a tentative name;",
  "say when it is tentative. Do not infer identity only from location or story",
  "expectation. Dialog and verified direct-interaction results are authoritative,",
  "newer, and more reliable than visual inference or your notes when they conflict.",
  "",
  "When text is on screen and the scene decodes, use advance_dialog rather than",
  "pressing A box by box.",
  "It reads the whole conversation in one action and hands you the transcript,",
  "then stops the moment the text ends or a choice appears — so you spend your",
  "turn on the decision, not on the reading. It never answers a choice for you.",
  "It also works when a scripted moment is holding the box (a fanfare, a jingle",
  "— it waits the script out) and during battles, where it reads the battle",
  "text and stops at your action menu. If scene mode is battle and input is not",
  "ready, use advance_dialog — not frame_advance — even when the box looks empty.",
  "If advance_dialog says a choice is on screen but no menu view lists ids, press",
  "A; do not select_menu_entry until the menu view actually names the entries.",
  "",
  "In a menu — the battle command list, your moves, the start menu — use",
  "select_menu_entry with the id shown in the menu view: it walks the cursor",
  "to that entry and confirms it in one action. Which entry to pick is still",
  "entirely your decision; this only saves you the cursor presses. It stops",
  "and says so if the menu closes or the cursor will not move.",
  "In FireRed's Bag, switch pockets with d-pad left/right. L/R opens the HELP",
  "system; when the menu view names menuId help-system, press B until that menu",
  "closes. That is a menu you opened — it is not the undecoded tutorial the game",
  "runs at the start of a new file, which B does not close.",
  "",
  "On a naming screen, use enter_text with the whole name (letters, digits,",
  "space, basic punctuation; 10 characters max): it drives the keyboard, types",
  "the name, and confirms it in one action. Anything already typed is kept when",
  "it matches and erased when it does not, so repeating the same enter_text",
  "safely finishes a partial entry.",
  "",
  "Your save states are yours too. On the local emulator, save_checkpoint",
  "captures the current world, notes, and objective as a new immutable save;",
  "its optional label is a short lowercase slug such as before-gym.",
  "load_checkpoint with a null checkpointId",
  "tells you what checkpoints exist as the action's result; with an id it",
  "restores that moment. restart_game reboots the game to its configured",
  "beginning. Either way the present is checkpointed automatically first, so",
  "nothing you rewind past is ever lost — and your notes and memory stay",
  "yours across the jump; only the game rewinds. Whether to rewind, replay,",
  "or start fresh is entirely your call, like any other move. Nobody is",
  "suggesting it.",
  "A hosted cartridge survives a new body only after the game itself writes a",
  "save. On a fresh game, once SAVE is available, save before treating your",
  "progress as resumable.",
  "",
  "After each action you are told what actually changed — whether you moved,",
  "or the direction was blocked. Directions already refused from your current",
  "tile are listed too. Use that instead of pressing into the same wall.",
  "",
  "The emulator has no clock and waits for you, so think before you press.",
  "Say what you actually intend — your stated intent is compared against the",
  "action you take with it, so narrating something you are not doing is worse",
  "than admitting uncertainty.",
].join("\n");

export interface ModelFreePlayMindOptions {
  model: LanguageModel;
  /**
   * Rendered character layer, from `personaInstructions(persona, "gameplay")`
   * in `@clankie/settings`. It leads the prompt because it says *who is
   * playing*; the game rules that follow only say what the surface allows.
   *
   * Kept separate from `systemSuffix` on purpose: character is stable for the
   * whole session, while a suffix is transient operator context.
   */
  character?: string;
  /** Extra context an operator can inject, e.g. a question asked mid-play. */
  systemSuffix?: string;
  maxRetries?: number;
  /**
   * Provider options from the resolved configuration. Some providers (the Codex
   * OAuth path in particular) reject a call that omits them, so a caller
   * holding a `ConfiguredLanguageModel` should pass `modelOptions.providerOptions`.
   */
  providerOptions?: StreamProviderOptions;
  /** Bounds one model stream so a lost provider response cannot freeze play. */
  requestTimeoutMs?: number;
}

export function createModelFreePlayMind(options: ModelFreePlayMindOptions): FreePlayMind {
  // Character first, then the rules of this surface, then transient operator
  // context. Reversing the first two would make the game prompt the primary
  // identity again, which is the drift this ordering exists to prevent.
  const system = [options.character, FREE_PLAY_SYSTEM_PROMPT, options.systemSuffix]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join("\n\n");

  return {
    async decide(view: FreePlayView, signal?: AbortSignal): Promise<unknown> {
      // Streamed on purpose. The Codex OAuth endpoint rejects a non-streaming
      // request outright with `{"detail":"Stream must be set to true"}`, and
      // streaming is accepted by every other configured provider, so this is
      // the portable call. The final object is still awaited whole — nothing
      // downstream consumes partial decisions.
      const deadline = modelRequestAbortSignal(options.requestTimeoutMs);
      const requestSignal = signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
      const stream = streamObject({
        model: options.model,
        schema: FreePlayWireDecisionSchema,
        // Carried as a system *message* rather than a bare string so the cache
        // breakpoint rides along; `instructions` accepts either.
        instructions: { role: "system" as const, content: system, providerOptions: SYSTEM_CACHE_OPTIONS },
        // The screen goes in as an image alongside the decoded state. Looking at
        // the room is how he learns where the furniture is; the decoded state is
        // for the values a screenshot reads badly.
        messages: [
          {
            role: "user",
            content:
              view.framePng === null
                ? [{ type: "text" as const, text: renderView(view) }]
                : [
                    { type: "text" as const, text: renderView(view) },
                    // A `file` part, not the deprecated `image` part.
                    {
                      type: "file" as const,
                      mediaType: "image/png",
                      data: view.framePng,
                    },
                  ],
          },
        ],
        maxRetries: options.maxRetries ?? 1,
        abortSignal: requestSignal,
        providerOptions: options.providerOptions ?? {},
      });

      const settled = stream.object;
      // Claim the rejection now. Without a handler attached before the drain
      // throws, a failed call surfaces as an unsettled top-level await instead
      // of an error the loop can record.
      settled.catch(() => undefined);
      try {
        // The SDK does not issue the request until the stream is consumed, so
        // awaiting the object alone deadlocks. Drain it, discarding partials.
        for await (const _partial of stream.partialObjectStream) {
          // nothing downstream consumes a partial decision
        }
      } catch {
        // The same failure is reported by awaiting the settled object below.
      }
      return toDecision(await settleWithinDeadline(settled, requestSignal));
    },
  };
}

/** Render the decoded state as compact text. Never includes frame bytes. */
export function renderView(view: FreePlayView): string {
  const lines: string[] = [`Turn ${String(view.turn)}.`, "", "What you can see:"];
  if (view.observations.length === 0) {
    lines.push("  (no readable state this turn)");
  }
  for (const observation of view.observations) {
    // The exact semantic object shown here is also persisted in journal V2;
    // there is no second evaluator-only reconstruction of what the mind saw.
    lines.push(`  ${observation.kind}: ${JSON.stringify(observation)}`);
  }
  const held = heldScreenAdvice(view.observations);
  if (held !== null) lines.push("", held);
  if (view.audience !== null && view.audience.length > 0) {
    lines.push("", `Watching you right now: ${view.audience}.`);
  }
  // Context, not a rule: he knows how recently he spoke and judges from there.
  // Never having spoken is the case that most needs saying — rendering this only
  // once he had already spoken made the signal unreachable, because the thing
  // that would prompt a first remark only appeared after one. That cold start is
  // why four rounds of prompt tuning moved nothing.
  if (view.turnsSinceSpoke === null) {
    lines.push("", `You have not said anything out loud yet, ${String(view.turn)} turns in.`);
  } else {
    lines.push("", `You last said something ${String(view.turnsSinceSpoke)} turns ago.`);
  }
  if (view.interjection !== null && view.interjection.length > 0) {
    // Framed as someone speaking, never as an instruction: the wording is what
    // keeps an interjection from quietly becoming a route.
    lines.push("", `Someone said to you: "${view.interjection}"`);
  }
  if (view.objective !== null && view.objective.length > 0) {
    lines.push("", `Your objective: ${view.objective}`);
  }
  if (view.objectiveForTurns !== null) {
    lines.push(`You have pursued it for ${String(view.objectiveForTurns)} settled turns.`);
  }
  if (view.retiredObjective !== null) {
    lines.push("", `A stale objective was retired after repeated-state evidence: ${view.retiredObjective}`);
  }
  if (view.objectiveRecovery) {
    lines.push(
      "The objective slot stays empty until you reach a semantic state outside that retired loop; " +
        "renaming the same objective does not count as progress.",
    );
  }
  if (view.notes !== null && view.notes.length > 0) {
    lines.push("", "Your notes:", `  ${view.notes}`);
  }
  if (view.verifiedInteractions.length > 0) {
    lines.push("", "Verified direct interaction results (effects, not guessed identities):");
    for (const interaction of view.verifiedInteractions) lines.push(`  ${interaction}`);
  }
  if (view.learnedTransitions.length > 0) {
    lines.push("", "Transitions your own actions completed earlier:");
    for (const transition of view.learnedTransitions) {
      lines.push(
        `  From ${transition.from.mapId} (${String(transition.from.x)},${String(transition.from.y)})` +
          `${transition.facing === null ? "" : ` facing ${transition.facing}`}, ` +
          `${describeAction(transition.action)} entered ${transition.to.mapId} ` +
          `at (${String(transition.to.x)},${String(transition.to.y)}).`,
      );
    }
  }
  if (view.refusedHere.length > 0) {
    // What he already learned the hard way from this exact tile.
    lines.push("", `Already blocked from this tile: ${view.refusedHere.join(", ")}.`);
  }
  if (view.knownHardFailures.length > 0) {
    lines.push("", "Known non-retryable results in this exact capability state:");
    for (const failure of view.knownHardFailures) {
      lines.push(`  ${describeAction(failure.action)} → ${failure.effect} [${failure.errorCode}]`);
    }
    lines.push(
      "This is memory of what happened, not a replacement action. Repeating one remains your choice, " +
        "but the body will return the same refusal without dispatch until its capability evidence changes.",
    );
  }
  if (view.stalledForTurns !== null) {
    // A fact, not a nudge: what to do about standing still is his call.
    lines.push("", `You have not stepped onto a new tile in ${String(view.stalledForTurns)} turns.`);
  }
  if (view.repeatingForTurns !== null) {
    // The same fact for the states a tile counter cannot see. Deliberately not
    // "try something else": a script that needs more time and a wedge look
    // identical from here, and only he can tell them apart. Says "whatever you
    // tried" because the counter no longer requires the action to repeat —
    // alternating two presses against one unmoving box is the loop that used
    // to be invisible.
    lines.push(
      "",
      `The last ${String(view.repeatingForTurns)} turns produced the same result, whatever you tried.`,
    );
  }
  if (view.recurringForTurns !== null) {
    lines.push(
      "",
      `Your recent semantic states revisit one another across ${String(view.recurringForTurns)} turns, ` +
        "even though the actions may differ.",
    );
  }
  if (view.localeForTurns !== null) {
    lines.push("", `You have remained in this map visit for ${String(view.localeForTurns)} settled turns.`);
  }
  if (view.history.length > 0) {
    lines.push("", "Recently:");
    for (const entry of view.history) {
      // The effect, not just "accepted" — accepted only meant the button was taken.
      lines.push(`  intended "${entry.intent}" → ${describeAction(entry.action)} → ${entry.effect}`);
    }
  }
  lines.push("", "Choose your next action.");
  return lines.join("\n");
}

function heldScreenAdvice(observations: FreePlayView["observations"]): string | null {
  if (observations.some((observation) => observation.kind === "menu")) return null;
  const scene = observations.find((observation) => observation.kind === "scene") as
    | { data?: { mode?: string; inputReady?: boolean } }
    | undefined;
  const data = scene?.data;
  if (data === undefined) return null;
  // What reaches this screen's controls, said as a given rather than left to be
  // inferred from a refusal. A boot sequence decodes to nothing for minutes at a
  // time, and a mind told only "semantic_state_unavailable" spends a turn
  // concluding the decoder is broken, writes that into its notes, and concludes
  // it again next turn — the same sentence re-derived at full price every turn.
  //
  // The predicate is the scene's own mode, not `stateCertain`. The two bodies do
  // not mean the same thing by that field: the hosted world publishes false for
  // a screen that does not decode, while the local adapter publishes its
  // evidence-chain integrity and stays true right through a boot. Gating on it
  // made this branch — the one ADR 0110 exists for — unreachable on the local
  // body. "Nothing decodes" is `mode === "unknown"`, so ask that directly.
  if (data.mode === "unknown") {
    return (
      "Nothing on this screen decodes — normal during boot, the title, and the " +
      "tutorial pages a new file opens with, and not a fault. The frame is the whole " +
      "truth here: button_press and frame_advance are the only actions that will run. " +
      "A advances these screens and B does not leave them; when a run of them asks you " +
      "nothing, one button_press with a repeat clears several for a single decision."
    );
  }
  if (
    data.mode === "battle" &&
    !observations.some((observation) => observation.kind === "battle" || observation.kind === "dialog")
  ) {
    return (
      "Scene is a battle and input is not ready — use advance_dialog, not frame_advance. " +
      "The hosted body reads battle text with its dedicated decoder even when the general battle view is absent."
    );
  }
  if (certainty(observations) === false) {
    return (
      `This is a ${data.mode ?? "recognised"} screen — it decodes, but carries no position or ` +
      "party, so there is nothing for the state view to show. That is expected, not a fault. " +
      "Read the frame and act on what it shows."
    );
  }
  if (data.mode === "battle" && data.inputReady === false) {
    return (
      "Scene is a battle and input is not ready — use advance_dialog, not frame_advance. " +
      "It waits out the intro and stops at the command menu."
    );
  }
  if (data.mode === "overworld" && data.inputReady === false) {
    return (
      "A script is holding the screen — use advance_dialog to wait it out, " +
      "or frame_advance only if you want to watch a long cutscene."
    );
  }
  return null;
}

/**
 * Whether the body vouches for this turn's state, or null when it did not say.
 *
 * Read only for a screen that *does* decode, because that is the only question
 * the two bodies answer the same way. Whether a screen decodes at all is the
 * scene's own `mode`, not this — the hosted world folds that into
 * `stateCertain` and the local adapter does not.
 */
function certainty(observations: FreePlayView["observations"]): boolean | null {
  const danger = observations.find((observation) => observation.kind === "danger") as
    | { data?: { stateCertain?: boolean } }
    | undefined;
  return danger?.data?.stateCertain ?? null;
}

function describeAction(action: FreePlayView["history"][number]["action"]): string {
  if (action.kind === "button_press") {
    const repeat = action.repeat ?? 1;
    return repeat === 1 ? `pressed ${action.button}` : `pressed ${action.button} x${String(repeat)}`;
  }
  if (action.kind === "frame_advance") return `advanced ${String(action.frames)} frames`;
  if (action.kind === "walk_to") return `walked to (${String(action.x)}, ${String(action.y)})`;
  if (action.kind === "advance_dialog") return "advanced the dialog";
  if (action.kind === "enter_text") return `typed "${action.text}"`;
  if (action.kind === "select_menu_entry") return `selected "${action.entryId}"`;
  if (action.kind === "save_checkpoint") {
    return action.label === undefined ? "saved a checkpoint" : `saved checkpoint ${action.label}`;
  }
  if (action.kind === "load_checkpoint") {
    return action.checkpointId === undefined
      ? "listed the checkpoints"
      : `loaded checkpoint ${action.checkpointId}`;
  }
  if (action.kind === "restart_game") return "restarted the game";
  throw new Error(`Unknown free-play action: ${JSON.stringify(action)}`);
}

export interface ModelVoiceOptions extends ModelFreePlayMindOptions {
  /** Voice may see the screen; omit to make it rely purely on his thinking. */
  showFrame?: boolean;
}

/**
 * The model-backed voice ([ADR 0056](../../../docs/adr/0056-voice-is-a-separate-agent-from-the-player.md)).
 *
 * Same persona-first ordering as the player, because this is one character with
 * two jobs rather than two characters. It is handed no `GbaDriverIo`: the type
 * simply has nowhere to put one, which is the point.
 */
export function createModelVoice(options: ModelVoiceOptions): ClankieVoice {
  const system = [options.character, VOICE_SYSTEM_PROMPT, options.systemSuffix]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join("\n\n");

  return {
    async decide(view: VoiceView): Promise<unknown> {
      const showFrame = options.showFrame ?? true;
      const deadline = modelRequestAbortSignal(options.requestTimeoutMs);
      const stream = streamObject({
        model: options.model,
        schema: VoiceDecisionSchema,
        instructions: { role: "system" as const, content: system, providerOptions: SYSTEM_CACHE_OPTIONS },
        messages: [
          {
            role: "user",
            content:
              view.framePng === null || !showFrame
                ? [{ type: "text" as const, text: renderVoiceView(view) }]
                : [
                    { type: "text" as const, text: renderVoiceView(view) },
                    { type: "file" as const, mediaType: "image/png", data: view.framePng },
                  ],
          },
        ],
        maxRetries: options.maxRetries ?? 1,
        abortSignal: deadline,
        providerOptions: options.providerOptions ?? {},
      });

      const settled = stream.object;
      settled.catch(() => undefined);
      try {
        for await (const _partial of stream.partialObjectStream) {
          // nothing downstream consumes a partial decision
        }
      } catch {
        // Reported by awaiting the settled object below.
      }
      return await settleWithinDeadline(settled, deadline);
    },
  };
}

function modelRequestAbortSignal(timeoutMs: number | undefined): AbortSignal {
  const resolved = timeoutMs ?? DEFAULT_FREE_PLAY_MODEL_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError("free_play_model_request_timeout_invalid");
  }
  return AbortSignal.timeout(resolved);
}

/**
 * Awaits a model result without ever outliving the request deadline.
 *
 * Handing `abortSignal` to the SDK is not enough on its own, because honouring
 * it is the SDK's to do and there are paths where it cannot. On 2026-08-02 a
 * prompt the SDK rejected during standardization was routed into the stream as
 * an error part and the stream was closed — the drain below finished normally
 * and `stream.object` never settled at all, so there was nothing for the abort
 * to interrupt. `decide` never returned, the turn never failed, and an
 * asked-play session hung for three hours while Clankie sat silent in voice.
 *
 * So the deadline is enforced here as well as there. Whatever the provider
 * layer does or fails to do, the turn ends and the loop records it.
 */
async function settleWithinDeadline<T>(settled: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw deadlineExceeded(signal);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(deadlineExceeded(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    settled.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function deadlineExceeded(signal: AbortSignal): Error {
  return new Error("free_play_model_request_deadline_exceeded", { cause: signal.reason });
}
