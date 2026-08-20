import { z } from "zod";

/**
 * The wire contract for Clankie's play voice seam (ADR 0064).
 *
 * Three messages — one outbound, two inbound — and deliberately nothing else.
 * This is not a general-purpose channel into the body: local/hosted play may
 * report what it just did, and may be told what the room said and whether
 * anyone is there to hear it. It cannot choose an audience, join or leave a
 * channel, or reach any other presence action from here.
 */
export const PLAY_VOICE_SCHEMA_VERSION = 1 as const;

/** Bounded so a runaway play loop cannot grow the realtime session's context. */
export const PLAY_NARRATION_MAX_CHARS = 2_000;
export const PLAY_UTTERANCE_MAX_CHARS = 2_000;

const EnvelopeShape = { schemaVersion: z.literal(PLAY_VOICE_SCHEMA_VERSION) } as const;

/**
 * Play → Discord body. `text` carries the body's bounded current experience in
 * the play loop's own words. It is **not** a script: the Discord body seeds it
 * as a conversation item and lets the persona decide how — and whether — to
 * voice it. Play changes what the body is doing, never who is present or how he
 * sounds (ADR 0047's fence, restated for speech).
 */
export const PlayNarrateSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("narrate"),
    text: z.string().min(1).max(PLAY_NARRATION_MAX_CHARS),
    /**
     * Optional join key minted by the play journal. The listener falls back to
     * its own id when a play caller omits it.
     */
    deliveryId: z.string().min(1).max(128).regex(/^\S+$/u).optional(),
    /** False seeds this experience into the live persona without asking it to speak. */
    respond: z.boolean().optional(),
  })
  .strict();
export type PlayNarrate = z.infer<typeof PlayNarrateSchema>;

export const PlayClientMessageSchema = z.discriminatedUnion("type", [PlayNarrateSchema]);
export type PlayClientMessage = z.infer<typeof PlayClientMessageSchema>;

/**
 * Discord body → play. One already-attributed line from the room, pushed as it
 * happens. Push rather than pull is a privacy constraint: a pull-shaped port
 * would force the bridge to retain transcripts, and it retains none.
 *
 * Two sources, one message: a voice-transcript line from inside the consent
 * registry, and — since ADR 0098 — a text message the ingress allowlist already
 * admits. Speaking in the channel he plays in front of and typing in it are the
 * same act, and play cannot tell which it received.
 *
 * Raw audio never crosses this seam, and nothing play receives here was
 * captured outside a boundary the owner had already drawn.
 */
export const PlayUtteranceSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("utterance"),
    text: z.string().min(1).max(PLAY_UTTERANCE_MAX_CHARS),
  })
  .strict();
export type PlayUtterance = z.infer<typeof PlayUtteranceSchema>;

/**
 * Discord body → play. Whether anyone can currently hear this body, pushed on
 * every change and once on connect.
 *
 * Play needs this to know who is authoring: while a room is listening
 * the realtime session composes everything it hears (ADR 0074), so a play loop
 * that also authored asides would be a second voice in the same channel.
 *
 * One boolean and deliberately nothing else. A participant count was drafted
 * here and cut: the voice session knows who it is capturing, not who is in the
 * channel, so any number this carried would have been a different question's
 * answer wearing an audience's name. Identities never cross, so this adds no
 * retention and asks no new consent question.
 */
export const PlayRoomSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("room"),
    listening: z.boolean(),
  })
  .strict();
export type PlayRoom = z.infer<typeof PlayRoomSchema>;

export const PlayServerMessageSchema = z.discriminatedUnion("type", [PlayUtteranceSchema, PlayRoomSchema]);
export type PlayServerMessage = z.infer<typeof PlayServerMessageSchema>;

/** The fixed loopback endpoint the active Discord body hosts and Clankie's play loop dials. */
export const PLAY_VOICE_PATH = "/play" as const;
export const PLAY_VOICE_DEFAULT_PORT = 4323;
export const PLAY_VOICE_DEFAULT_URL =
  `ws://127.0.0.1:${String(PLAY_VOICE_DEFAULT_PORT)}${PLAY_VOICE_PATH}` as const;
