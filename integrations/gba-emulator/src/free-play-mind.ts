import type { LanguageModel } from "ai";
import { streamObject } from "ai";

/** Derived from the SDK signature so it tracks their type, not a guessed name. */
type StreamProviderOptions = NonNullable<Parameters<typeof streamObject>[0]["providerOptions"]>;
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
    objective: z.string().nullable().describe("Your standing goal; null keeps the current one."),
    reply: z.string().nullable().describe("What you say back if someone spoke to you this turn, else null."),
    // Structured output weights the schema over the system prompt, so guidance
    // that lives only in the prompt gets ignored in favour of a default null.
    speak: z
      .string()
      .nullable()
      .describe(
        'An aside said out loud to whoever is watching. Example: "this desk has beaten me ' +
          "four times now, I'm starting to take it personally\". Use it when something is " +
          "worth reacting to — a joke, exasperation, a surprise, changing your mind. Not " +
          "narration of your moves. Null when you have nothing to say.",
      ),
    actionKind: z.enum(["button_press", "frame_advance", "wait"]),
    button: z.enum(["up", "down", "left", "right", "a", "b", "start", "select", "l", "r"]).nullable(),
    holdFrames: z.number().int().nullable(),
    repeat: z.number().int().nullable(),
    frames: z.number().int().nullable(),
    durationMs: z.number().int().nullable(),
  })
  .strict();

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
      : wire.actionKind === "frame_advance"
        ? { kind: "frame_advance", frames: wire.frames }
        : { kind: "wait", durationMs: wire.durationMs };
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
  "You are playing Pokémon FireRed yourself.",
  "Each turn you see the actual game screen and the decoded state, and you",
  "choose one action. Look at the screen: it shows walls, furniture, doors,",
  "stairs, NPCs, and text that the decoded state does not describe. The decoded",
  "state is for exact values — position, HP, PP, legal moves.",
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
  "  It is carried to later turns; return null to keep the current one, and",
  "  change it only when you achieve it or decide to abandon it.",
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
  "- intent: the single concrete thing you will do NEXT TURN — a step or a",
  '  press, not the objective. "step left around the desk", not "reach the',
  '  stairs". You are scored on whether you then do it.',
  "- notes: your own running notes, carried to every later turn. Keep what will",
  "  still matter — the room layout you have worked out, what you already tried,",
  "  where you are heading. Rewrite them freely; return null to leave them as",
  "  they are. Nothing else writes this, and nothing else remembers for you.",
  "- action: exactly one of",
  '    {"kind":"button_press","button":"up|down|left|right|a|b|start|select|l|r","holdFrames":N,"repeat":N}',
  '    {"kind":"frame_advance","frames":N}',
  '    {"kind":"wait","durationMs":N}',
  "",
  "Always give holdFrames on a button press — 16 is a reliable step; a short",
  "hold only turns you. repeat presses the same button that many times in ONE",
  "action (max 16), which",
  "is how you cross a corridor without spending a decision per tile. A short tap",
  "only turns you; a step needs a longer hold or a repeat.",
  "",
  "After each action you are told what actually changed — whether you moved,",
  "or the direction was blocked. Directions already refused from your current",
  "tile are listed too. Use that instead of pressing into the same wall.",
  "",
  "The emulator has no clock and waits for you, so think before you press.",
  "Say what you actually intend — your stated intent is compared against what",
  "you do next, so narrating something you are not going to do is worse than",
  "admitting uncertainty.",
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
}

export function createModelFreePlayMind(options: ModelFreePlayMindOptions): FreePlayMind {
  // Character first, then the rules of this surface, then transient operator
  // context. Reversing the first two would make the game prompt the primary
  // identity again, which is the drift this ordering exists to prevent.
  const system = [options.character, FREE_PLAY_SYSTEM_PROMPT, options.systemSuffix]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join("\n\n");

  return {
    async decide(view: FreePlayView): Promise<unknown> {
      // Streamed on purpose. The Codex OAuth endpoint rejects a non-streaming
      // request outright with `{"detail":"Stream must be set to true"}`, and
      // streaming is accepted by every other configured provider, so this is
      // the portable call. The final object is still awaited whole — nothing
      // downstream consumes partial decisions.
      const stream = streamObject({
        model: options.model,
        schema: FreePlayWireDecisionSchema,
        system,
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
      return toDecision(await settled);
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
    lines.push(`  ${observation.kind}: ${JSON.stringify(stripEnvelope(observation))}`);
  }
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
  if (view.notes !== null && view.notes.length > 0) {
    lines.push("", "Your notes:", `  ${view.notes}`);
  }
  if (view.refusedHere.length > 0) {
    // What he already learned the hard way from this exact tile.
    lines.push("", `Already blocked from this tile: ${view.refusedHere.join(", ")}.`);
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

/** Drop transport fields the model has no use for and would only pay tokens on. */
function stripEnvelope(observation: FreePlayView["observations"][number]): unknown {
  const {
    schemaVersion: _schemaVersion,
    observationId: _observationId,
    ...rest
  } = observation as Record<string, unknown> & { schemaVersion?: unknown; observationId?: unknown };
  return rest;
}

function describeAction(action: FreePlayView["history"][number]["action"]): string {
  if (action.kind === "button_press") {
    const repeat = action.repeat ?? 1;
    return repeat === 1 ? `pressed ${action.button}` : `pressed ${action.button} x${String(repeat)}`;
  }
  if (action.kind === "frame_advance") return `advanced ${String(action.frames)} frames`;
  if (action.kind === "walk_to") return `walked to (${String(action.x)}, ${String(action.y)})`;
  return `waited ${String(action.durationMs)}ms`;
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
      const stream = streamObject({
        model: options.model,
        schema: VoiceDecisionSchema,
        system,
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
      return await settled;
    },
  };
}
