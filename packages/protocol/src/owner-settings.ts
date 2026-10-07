import { z } from "zod";
import { HostPowerReportSchema } from "./host-power.ts";
import { PersonaChattinessSchema, PersonaReplyPolicySchema } from "./discord-attention.ts";
/**
 * Who Clankie is, as distinct from what he is allowed to do.
 *
 * Identity is layered deliberately. **Character** (this schema) is stable
 * across every surface; the **operating contract** in the captain's authored
 * instructions is also stable; only **register** — how he speaks in the room he
 * is currently in — varies by lane. One person, different rooms.
 *
 * Nothing here grants authority. Register is presentation only: a warmer voice
 * must never widen what the ambient tier may approve, or an agreeable persona
 * becomes a social-engineering surface ([ADR 0051](../../../docs/adr/0051-layered-character-register-and-reply-policy.md)).
 */
export const PersonaSettingsSchema = z
  .object({
    displayName: z.string().min(1).max(64).default("Clankie"),
    /** Extra names he answers to. Humans misspell, shorten, and nickname. */
    aliases: z.array(z.string().min(1).max(64)).max(16).default([]),
    /**
     * Free-text character authored by the owner. This is the taste layer, and
     * it belongs to a human — the code carries it, it does not invent it.
     */
    characterNotes: z.string().max(4_000).default(""),
    /** Owner-selected mood board directory on the service host; restart applies changes. */
    imagesDir: z.string().trim().max(4096).optional(),
    /**
     * How readily he joins in when nobody addressed him. Once addressed he
     * answers normally, and how long he talks is always his own choice.
     */
    chattiness: PersonaChattinessSchema.default("balanced"),
    /** What he perceives in admitted text channels; silence remains his decision. */
    replyPolicy: PersonaReplyPolicySchema.default("all"),
    /**
     * How many messages may pass in a channel, after he last replied there,
     * before he stops reading it live and lets it pile up until he next checks
     * in. `0` means he only ever answers when named.
     *
     * This decides what he *sees*, never what he must say: he may stay silent
     * on any turn, including one that named him directly.
     */
    liveMessageWindow: z.number().int().min(0).max(100).default(5),
  })
  .strict();
export type PersonaSettings = z.infer<typeof PersonaSettingsSchema>;

/** Vendor identifiers travel in URLs and protocol frames; constrain them early. */
const VendorIdentifierSchema = z
  .string()
  .regex(/^[\w-]{1,128}$/u, "must be at most 128 word characters or hyphens");
const ModelIdentifierSchema = z
  .string()
  .regex(/^[\w.-]{1,128}$/u, "must be at most 128 word characters, dots, or hyphens");

/**
 * How Clankie sounds ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md))
 * — a peer of `persona` for the same reason persona is a peer of `discord`:
 * this is who he *is* across surfaces, not a Discord authority knob. Like the
 * rest of settings these are public identifiers; voice-vendor API keys live
 * in the credential broker under their provider ids, never here.
 */
export const VoiceSettingsSchema = z
  .object({
    /** Voice brain; Anthropic uses separate OpenAI transcription and external speech. */
    realtimeProvider: z.enum(["openai", "xai", "anthropic"]).default("openai"),
    /**
     * Who synthesizes his speech. The historical `openai` value means the
     * selected realtime provider's native voice; `elevenlabs` is external TTS.
     */
    ttsProvider: z.enum(["openai", "elevenlabs"]).default("openai"),
    openAiRealtimeModel: ModelIdentifierSchema.optional(),
    openAiTranscribeModel: ModelIdentifierSchema.optional(),
    /** OpenAI realtime voice name (e.g. `marin`); unset defers to the runtime default. */
    openAiVoice: z.string().min(1).max(64).optional(),
    xAiRealtimeModel: ModelIdentifierSchema.optional(),
    /** Anthropic text brain; unset defers to claude-sonnet-5-5. */
    anthropicModel: ModelIdentifierSchema.optional(),
    /** xAI built-in or custom voice id; unset defers to `eve`. */
    xAiVoice: VendorIdentifierSchema.optional(),
    /** xAI Voice's documented reasoning control. */
    xAiReasoningEffort: z.enum(["high", "none"]).default("high"),
    /** Public ElevenLabs voice identifier, required when {@link ttsProvider} is `elevenlabs`. */
    elevenLabsVoiceId: VendorIdentifierSchema.optional(),
    /** ElevenLabs model: `eleven_v4_turbo` uses dialogue; unset keeps legacy `eleven_flash_v2_5`. */
    elevenLabsModelId: VendorIdentifierSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ttsProvider === "elevenlabs" && value.elevenLabsVoiceId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["elevenLabsVoiceId"],
        message: "required when ttsProvider is elevenlabs",
      });
    }
    if (value.realtimeProvider === "xai" && value.ttsProvider === "elevenlabs") {
      context.addIssue({
        code: "custom",
        path: ["ttsProvider"],
        message: "elevenlabs text output requires realtimeProvider openai or anthropic",
      });
    }
    if (value.realtimeProvider === "anthropic" && value.ttsProvider !== "elevenlabs") {
      context.addIssue({
        code: "custom",
        path: ["ttsProvider"],
        message: "Anthropic voice requires elevenlabs speech output and a voice id",
      });
    }
  });
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

const RevisionSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const HOST_SETTINGS_PATH = "/v1/operator/host-settings";
export const HOST_SETTINGS_WORDING = {
  title: "Machines and availability",
  keepAwake: {
    label: "Keep this Mac awake",
    description: "While plugged in. Unplugged, it sleeps as its power settings say.",
  },
  autoUpdate: {
    label: "Install updates automatically",
    description: "Install official releases while Clankie is idle. Managed hosting always keeps this on.",
  },
} as const;
export const HostOwnerSettingsSchema = z.object({ keepAwake: z.boolean(), autoUpdate: z.boolean() }).strict();
export const HostSettingsSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: RevisionSchema,
    host: HostOwnerSettingsSchema,
    keepAwakeSupported: z.boolean(),
    autoUpdateManaged: z.boolean(),
    autoUpdateEffective: z.boolean(),
    power: HostPowerReportSchema.optional(),
    keepAwakeService: z
      .object({
        state: z.enum(["healthy", "unhealthy", "unreachable"]),
        detail: z.string().optional(),
        pid: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .strict();
export const UpdateHostSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    expectedRevision: RevisionSchema,
    changes: HostOwnerSettingsSchema.partial().refine(
      (v) => Object.values(v).some((x) => x !== undefined),
      "No host settings change",
    ),
  })
  .strict();
export type HostSettingsSnapshot = z.infer<typeof HostSettingsSnapshotSchema>;
export type UpdateHostSettings = z.infer<typeof UpdateHostSettingsSchema>;
export const OwnerPersonaImageStatusSchema = z.object({
  directory: z.string().optional(),
  hash: z.string(),
  count: z.number(),
  vibeCount: z.number(),
  appearanceCount: z.number(),
  encodedBytes: z.number(),
  files: z.array(
    z.object({
      name: z.string(),
      role: z.enum(["vibe", "appearance"]).optional(),
      kind: z.enum(["image", "video"]).optional(),
      status: z.enum(["loaded", "skipped", "error"]),
      bytes: z.number().optional(),
      encodedBytes: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      reason: z.string().optional(),
      frames: z.number().optional(),
      duration: z.number().optional(),
      timestamps: z.array(z.number()).optional(),
      sheetPath: z.string().optional(),
      columns: z.number().optional(),
      rows: z.number().optional(),
    }),
  ),
  error: z.string().optional(),
  description: z.string().optional(),
  descriptionError: z.string().optional(),
  limits: z.object({
    count: z.number(),
    sourceBytes: z.number(),
    videoBytes: z.number(),
    videoSeconds: z.number(),
    framesPerVideo: z.number(),
    sheetColumns: z.number(),
    sheetRows: z.number(),
    sheetTileEdge: z.number(),
    sheetEdge: z.number(),
    edge: z.number(),
    encodedBytes: z.number(),
  }),
});
export const OwnerPersonaSnapshotSchema = z.object({
  revision: RevisionSchema,
  persona: PersonaSettingsSchema,
  images: OwnerPersonaImageStatusSchema.optional(),
  restart: z.string().optional(),
});
export type OwnerPersonaSnapshot = z.infer<typeof OwnerPersonaSnapshotSchema>;
export const OwnerPersonaUpdateSchema = z
  .object({
    expectedRevision: RevisionSchema,
    persona: z
      .object({
        displayName: PersonaSettingsSchema.shape.displayName.removeDefault().optional(),
        aliases: PersonaSettingsSchema.shape.aliases.removeDefault().optional(),
        characterNotes: PersonaSettingsSchema.shape.characterNotes.removeDefault().optional(),
        imagesDir: PersonaSettingsSchema.shape.imagesDir.optional(),
        chattiness: PersonaChattinessSchema.optional(),
        replyPolicy: PersonaReplyPolicySchema.optional(),
        liveMessageWindow: PersonaSettingsSchema.shape.liveMessageWindow.removeDefault().optional(),
      })
      .strict()
      .refine((v) => Object.values(v).some((x) => x !== undefined), "No persona change"),
  })
  .strict();
export const OwnerVoiceSnapshotSchema = z.object({
  revision: RevisionSchema,
  voice: VoiceSettingsSchema,
  effectiveVoice: VoiceSettingsSchema,
  overriddenByEnvironment: z.array(z.string()),
  restart: z.string().optional(),
});
export type OwnerVoiceSnapshot = z.infer<typeof OwnerVoiceSnapshotSchema>;
export const OwnerVoiceUpdateSchema = z
  .object({ expectedRevision: RevisionSchema, voice: VoiceSettingsSchema })
  .strict();
