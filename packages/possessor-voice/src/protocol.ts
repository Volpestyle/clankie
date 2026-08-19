import { z } from "zod";

/**
 * The wire contract for the possessor voice seam (ADR 0064).
 *
 * Three messages — one outbound, two inbound — and deliberately nothing else.
 * This is not a general-purpose channel into the body: a possessor may report
 * what it just did, and may be told what the room said and whether anyone is
 * there to hear it. It cannot choose an audience, join or leave a channel, or
 * reach any other presence action from here.
 */
export const POSSESSOR_VOICE_SCHEMA_VERSION = 1 as const;

/** Bounded so a runaway possessor cannot grow the realtime session's context. */
export const POSSESSOR_NARRATION_MAX_CHARS = 2_000;
export const POSSESSOR_UTTERANCE_MAX_CHARS = 2_000;

const EnvelopeShape = { schemaVersion: z.literal(POSSESSOR_VOICE_SCHEMA_VERSION) } as const;

/**
 * Possessor → bridge. `text` carries the body's bounded current experience in
 * the possessor's own words. It is **not** a script: the bridge seeds it as a
 * conversation item and lets the persona decide how — and whether — to voice it
 * (ADR 0047's fence, restated for speech: possession changes who decides, never
 * who is present or how he sounds).
 */
export const PossessorNarrateSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("narrate"),
    text: z.string().min(1).max(POSSESSOR_NARRATION_MAX_CHARS),
    /**
     * Optional join key minted by the play journal. The listener falls back to
     * its own id when a possessor omits it (gba-mcp `clankie_say`).
     */
    deliveryId: z.string().min(1).max(128).regex(/^\S+$/u).optional(),
    /** False seeds this experience into the live persona without asking it to speak. */
    respond: z.boolean().optional(),
  })
  .strict();
export type PossessorNarrate = z.infer<typeof PossessorNarrateSchema>;

export const PossessorClientMessageSchema = z.discriminatedUnion("type", [PossessorNarrateSchema]);
export type PossessorClientMessage = z.infer<typeof PossessorClientMessageSchema>;

/**
 * Bridge → possessor. One already-attributed line from the room, pushed as it
 * happens. Push rather than pull is a privacy constraint: a pull-shaped port
 * would force the bridge to retain transcripts, and it retains none.
 *
 * Two sources, one message: a voice-transcript line from inside the consent
 * registry, and — since ADR 0098 — a text message the ingress allowlist already
 * admits. Speaking in the channel he plays in front of and typing in it are the
 * same act, and a possessor cannot tell which it received.
 *
 * Raw audio never crosses this seam, and nothing a possessor receives here was
 * captured outside a boundary the owner had already drawn.
 */
export const PossessorUtteranceSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("utterance"),
    text: z.string().min(1).max(POSSESSOR_UTTERANCE_MAX_CHARS),
  })
  .strict();
export type PossessorUtterance = z.infer<typeof PossessorUtteranceSchema>;

/**
 * Bridge → possessor. Whether anyone can currently hear this body, pushed on
 * every change and once on connect.
 *
 * A possessor needs this to know who is authoring: while a room is listening
 * the realtime session composes everything it hears (ADR 0074), so a play loop
 * that also authored asides would be a second voice in the same channel.
 *
 * One boolean and deliberately nothing else. A participant count was drafted
 * here and cut: the voice session knows who it is capturing, not who is in the
 * channel, so any number this carried would have been a different question's
 * answer wearing an audience's name. Identities never cross, so this adds no
 * retention and asks no new consent question.
 */
export const PossessorRoomSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("room"),
    listening: z.boolean(),
  })
  .strict();
export type PossessorRoom = z.infer<typeof PossessorRoomSchema>;

export const PossessorServerMessageSchema = z.discriminatedUnion("type", [
  PossessorUtteranceSchema,
  PossessorRoomSchema,
]);
export type PossessorServerMessage = z.infer<typeof PossessorServerMessageSchema>;

/** The loopback path the bridge listens on and a possessor dials. */
export const POSSESSOR_VOICE_PATH = "/possessor" as const;
export const POSSESSOR_VOICE_DEFAULT_PORT = 4323;
export const POSSESSOR_VOICE_DEFAULT_URL =
  `ws://127.0.0.1:${String(POSSESSOR_VOICE_DEFAULT_PORT)}${POSSESSOR_VOICE_PATH}` as const;
