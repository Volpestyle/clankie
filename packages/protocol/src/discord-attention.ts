import { z } from "zod";

/**
 * "What wakes him / how much he talks" (VUH-1813): one owner-facing group in
 * every UI. The wake trigger is a Discord setting (`discord.wakeTrigger`,
 * saved through `/v1/discord/settings`); chattiness and reply policy are
 * persona settings saved through `/v1/operator/persona`. None of them limits
 * how long he talks once he answers: that is always his own choice.
 */
export const OPERATOR_PERSONA_PATH = "/v1/operator/persona";

export const PersonaChattinessSchema = z.enum(["quiet", "balanced", "chatty"]);
export type PersonaChattiness = z.infer<typeof PersonaChattinessSchema>;
export const PersonaReplyPolicySchema = z.enum(["addressed", "all"]);
export type PersonaReplyPolicy = z.infer<typeof PersonaReplyPolicySchema>;

/** The talkativeness slice of persona a paired device may read and change. */
export const PersonaAttentionSchema = z.object({
  chattiness: PersonaChattinessSchema,
  replyPolicy: PersonaReplyPolicySchema,
});
export type PersonaAttention = z.infer<typeof PersonaAttentionSchema>;
/** `GET`/`POST /v1/operator/persona` as the relay projects it: unknown persona fields are dropped. */
export const PersonaAttentionSnapshotSchema = z.object({ persona: PersonaAttentionSchema });
export type PersonaAttentionSnapshot = z.infer<typeof PersonaAttentionSnapshotSchema>;
export const PersonaAttentionUpdateSchema = PersonaAttentionSchema.partial()
  .strict()
  .refine((value) => Object.values(value).some((field) => field !== undefined), "No persona change supplied");
export type PersonaAttentionUpdate = z.infer<typeof PersonaAttentionUpdateSchema>;

interface Choice {
  readonly label: string;
  readonly description: string;
}

/** Shared wording so the TUI, app and dashboard name these the same way. */
export const DISCORD_ATTENTION = {
  title: "What wakes him / how much he talks",
  summary: "Once someone addresses him he answers normally, at whatever length fits.",
  saved: "Saved. Takes effect next time Discord reconnects.",
  wake: {
    label: "What wakes him in text",
    description: "Whether an @mention, his name, or any message reaches him.",
    choices: {
      mention: {
        label: "Only an @mention",
        description:
          "An @mention, a DM, a reply to him or /clankie ask. Writing his name without @mentioning him does not wake him.",
      },
      name: {
        label: "An @mention or his name",
        description:
          "Also wakes when someone writes his name or an alias, like “hey clankie”, without an @mention.",
      },
      any: {
        label: "Every message",
        description: "Every message he can see reaches him, and he decides whether to say anything.",
      },
      default: {
        label: "Default",
        description: "On your own computer he follows the reply policy; hosted Clankie wakes on an @mention.",
      },
    } satisfies Record<"mention" | "name" | "any" | "default", Choice>,
  },
  chattiness: {
    label: "How readily he jumps in",
    description: "Only matters when nobody is talking to him.",
    choices: {
      quiet: {
        label: "Quiet",
        description: "Only something notable or directly relevant to him gets his attention.",
      },
      balanced: { label: "Balanced", description: "He joins in when he has something to add." },
      chatty: { label: "Chatty", description: "He answers small and passing messages too." },
    } satisfies Record<PersonaChattiness, Choice>,
  },
  replyPolicy: {
    label: "Reply policy",
    description: "What he reads in voice, and in text when the wake trigger is the default.",
    choices: {
      all: {
        label: "Every message",
        description: "He reads each message in the room and decides for himself whether to speak.",
      },
      addressed: {
        label: "An @mention or his name",
        description:
          "Only an @mention or one of his names, plus the next few messages after he replies, gets his attention.",
      },
    } satisfies Record<PersonaReplyPolicy, Choice>,
  },
} as const;
