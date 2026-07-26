import { z } from "zod";

/**
 * The wire contract for the possessor voice seam (ADR 0064).
 *
 * Two messages, one in each direction, and deliberately nothing else. This is
 * not a general-purpose channel into the body: a possessor may report what it
 * just did and may be told what the room said. It cannot choose an audience,
 * join or leave a channel, or reach any other presence action from here.
 */
export const POSSESSOR_VOICE_SCHEMA_VERSION = 1 as const;

/** Bounded so a runaway possessor cannot grow the realtime session's context. */
export const POSSESSOR_NARRATION_MAX_CHARS = 2_000;
export const POSSESSOR_UTTERANCE_MAX_CHARS = 2_000;

const EnvelopeShape = { schemaVersion: z.literal(POSSESSOR_VOICE_SCHEMA_VERSION) } as const;

/**
 * Possessor → bridge. `text` describes what just happened in the body, in the
 * possessor's own words. It is **not** a script: the bridge seeds it as a
 * conversation item and lets the persona decide how — and whether — to voice it
 * (ADR 0047's fence, restated for speech: possession changes who decides, never
 * who is present or how he sounds).
 */
export const PossessorNarrateSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("narrate"),
    text: z.string().min(1).max(POSSESSOR_NARRATION_MAX_CHARS),
  })
  .strict();
export type PossessorNarrate = z.infer<typeof PossessorNarrateSchema>;

export const PossessorClientMessageSchema = z.discriminatedUnion("type", [PossessorNarrateSchema]);
export type PossessorClientMessage = z.infer<typeof PossessorClientMessageSchema>;

/**
 * Bridge → possessor. One already-attributed transcript line, pushed as it
 * happens. Push rather than pull is a privacy constraint: a pull-shaped port
 * would force the bridge to retain transcripts, and it retains none.
 *
 * Raw audio never crosses this seam, and nothing a possessor receives here was
 * captured outside the existing consent registry.
 */
export const PossessorUtteranceSchema = z
  .object({
    ...EnvelopeShape,
    type: z.literal("utterance"),
    text: z.string().min(1).max(POSSESSOR_UTTERANCE_MAX_CHARS),
  })
  .strict();
export type PossessorUtterance = z.infer<typeof PossessorUtteranceSchema>;

export const PossessorServerMessageSchema = z.discriminatedUnion("type", [PossessorUtteranceSchema]);
export type PossessorServerMessage = z.infer<typeof PossessorServerMessageSchema>;

/** The loopback path the bridge listens on and a possessor dials. */
export const POSSESSOR_VOICE_PATH = "/possessor" as const;
export const POSSESSOR_VOICE_DEFAULT_PORT = 4323;
export const POSSESSOR_VOICE_DEFAULT_URL =
  `ws://127.0.0.1:${String(POSSESSOR_VOICE_DEFAULT_PORT)}${POSSESSOR_VOICE_PATH}` as const;
