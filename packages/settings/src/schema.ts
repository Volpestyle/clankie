import { DesktopSettingsSchema } from "./desktop.ts";
import { HireProfileSchema } from "@clankie/protocol";
import { z } from "zod";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { MinecraftPlaySettingsSchema, MinecraftServerProfileIdSchema } from "@clankie/protocol";
import { isIP } from "node:net";

/**
 * Operator settings: **non-secret** configuration only.
 *
 * The split from `@clankie/credential-broker` is deliberate. The broker stores
 * values that grant access — it writes to the macOS Keychain, redacts on
 * display, and validates typed token patterns. Everything here is a public
 * identifier an operator reads off a Discord UI and legitimately wants to *see*
 * when checking their configuration, so redaction would be actively unhelpful.
 *
 * Nothing in this schema may hold a token. {@link assertNoSecretShapedValue}
 * enforces that at the write boundary rather than trusting convention.
 */
export const SETTINGS_SCHEMA_VERSION = 1 as const;

import { DiscordSettingsSchema } from "@clankie/protocol/discord-settings";
export { DiscordSettingsSchema, type DiscordSettings } from "@clankie/protocol/discord-settings";

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
    /** How readily he speaks, and how much room he takes when he does. */
    chattiness: z.enum(["quiet", "balanced", "chatty"]).default("balanced"),
    /** What he perceives in admitted text channels; silence remains his decision. */
    replyPolicy: z.enum(["addressed", "all"]).default("all"),
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
    /** Which vendor owns both the dormant transcriber and engaged voice agent. */
    realtimeProvider: z.enum(["openai", "xai"]).default("openai"),
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
        message: "elevenlabs text output currently requires realtimeProvider openai",
      });
    }
  });
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/** The relay origin advertised to paired remote devices (ADR 0135/0138). */
export const RelaySettingsSchema = z
  .object({
    /**
     * Public origin remote devices reach the relay on — typically the
     * machine's tailnet hostname in front of the launcher-supervised relay,
     * e.g. `http://my-mac.tailnet.ts.net:4321`. Unset advertises nothing and
     * paired devices keep whatever origin they already hold.
     */
    /** Explicit device-reachable control origin; never inferred from the relay port. */
    controlPlaneUrl: z.string().min(1).max(512).optional(),
    url: z.string().min(1).max(512).optional(),
  })
  .strict();
export type RelaySettings = z.infer<typeof RelaySettingsSchema>;

/**
 * This host's own behavior. `keepAwake` is the owner's opt-in to an always-on
 * Mac (VUH-1461): the launcher supervises `caffeinate -s`, which macOS holds
 * only while the Mac is plugged in. Off by default; sleep stays a normal
 * condition to recover from.
 */
export const HostSettingsSchema = z
  .object({
    keepAwake: z.boolean().default(false),
  })
  .strict();
export type HostSettings = z.infer<typeof HostSettingsSchema>;

/** Public AWS doorway used by App Store builds; the host bearer stays in Keychain. */
export const PublicGatewaySettingsSchema = z
  .object({
    url: z
      .string()
      .max(512)
      .superRefine((value, context) => {
        let parsed: URL;
        try {
          parsed = new URL(value);
        } catch {
          context.addIssue({ code: "custom", message: "must be an absolute URL" });
          return;
        }
        const loopback =
          parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
        if (
          (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
          parsed.username.length > 0 ||
          parsed.password.length > 0 ||
          parsed.pathname !== "/" ||
          value.includes("?") ||
          value.includes("#") ||
          parsed.search.length > 0 ||
          parsed.hash.length > 0
        ) {
          context.addIssue({
            code: "custom",
            message: "must be an exact HTTPS origin (HTTP is loopback-only)",
          });
        }
      })
      .optional(),
    hostId: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
    installationId: z
      .string()
      .length(22)
      .regex(/^[A-Za-z0-9_-]+$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const identityCount = Number(value.hostId !== undefined) + Number(value.installationId !== undefined);
    if (
      (value.url === undefined && identityCount !== 0) ||
      (value.url !== undefined && identityCount !== 1)
    ) {
      context.addIssue({
        code: "custom",
        message: "url requires exactly one account installation id or legacy host id",
      });
    }
  });
export type PublicGatewaySettings = z.infer<typeof PublicGatewaySettingsSchema>;

/**
 * Which herdr session is his (ADR 0149).
 *
 * The owner's intent, never machine state: the service resolves it again at
 * every start and writes nothing back (ADR 0181). Every console observes the
 * service's fleet, regardless of its own terminal environment.
 */
export const HerdrSettingsSchema = z
  .object({
    /** `auto` uses an explicitly named session/socket, else his own bundled fleet. */
    runtime: z.enum(["auto", "bundled", "external", "disabled"]).default("auto"),
    /** Named herdr session he leads; `default` is herdr's own default session. */
    session: z
      .string()
      .regex(/^[\w][\w.-]{0,63}$/u, "must be a herdr session name")
      .default("default"),
    /** A socket override for a session `herdr session list` cannot name. */
    socketPath: z.string().startsWith("/").max(102).optional(),
  })
  .strict();
export type HerdrSettings = z.infer<typeof HerdrSettingsSchema>;

/** Repositories store canonical git-common-dir; directories are exact identities. */
export const ExecutionWorkspacesSchema = z
  .array(
    z
      .object({
        kind: z.enum(["repository", "directory"]),
        /** POSIX absolute, or a Windows drive path for a Windows ssh fleet (ADR 0184). */
        path: z
          .string()
          .max(4096)
          .regex(/^(?:\/|[A-Za-z]:[\\/])/u, "must be an absolute path"),
      })
      .strict(),
  )
  .max(32);

/** The ssh route to a remote Herdr fleet. Authentication stays in the owner's ssh configuration. */
export const HerdrSshTransportSchema = z
  .object({
    host: z.string().regex(/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u),
    shell: z.enum(["posix", "powershell"]),
  })
  .strict();
export type HerdrSshTransport = z.infer<typeof HerdrSshTransportSchema>;

/** Named execution endpoints are pinned; disabling a connection keeps its identity. */
export const ExecutionConnectionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .refine((id) => id !== "default"),
    machine: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .optional(),
    kind: z.literal("herdr").default("herdr"),
    session: z.string().regex(/^[\w][\w.-]{0,63}$/u),
    /** A local runtime's socket. An ssh fleet names only its session (ADR 0184). */
    socketPath: z
      .string()
      .startsWith("/")
      .refine((path) => new TextEncoder().encode(path).length <= 102)
      .optional(),
    /**
     * An ssh fleet (ADR 0184): Herdr on another machine, reached through the
     * owner's own ssh configuration. Its CLI runs there with `--session`; the
     * remote server is never started, stopped or replaced from here.
     */
    ssh: HerdrSshTransportSchema.optional(),
    capabilities: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .refine((value) => !value.startsWith("runtime:")),
      )
      .max(32)
      .default(["code", "review", "research"]),
    capacity: z.number().int().min(0).nullable().optional(),
    workspaces: ExecutionWorkspacesSchema.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

/** The captain's own runtime home, distinct from what he is allowed to do. */
export const CaptainSettingsSchema = z
  .object({
    /**
     * Absolute directory his shell and sessions run in. Unset means the
     * operator's home directory — never the install root, which on a release
     * is an immutable directory he has no business working inside.
     */
    workingDirectory: z.string().min(1).max(1_024).optional(),
  })
  .strict();
export type CaptainSettings = z.infer<typeof CaptainSettingsSchema>;

/** His own browser (ADR 0082). */
export const BrowserSettingsSchema = z
  .object({
    /**
     * Save each burst of browsing as a WebM under the service state root
     * (`runner/browser/recordings/`), newest 50 kept. Off by default: videos
     * capture every page he opens, including signed-in ones.
     */
    recordSessions: z.boolean().default(false),
    /**
     * Show him the computer-use harnesses on this machine (Codex computer use,
     * Claude in Chrome) as his main way into hard computer and browser work
     * (ADR 0199). Off when the owner would rather not spend those plans; his
     * own browser is then his only way in.
     */
    harnessDelegation: z.boolean().default(true),
  })
  .strict();
export type BrowserSettings = z.infer<typeof BrowserSettingsSchema>;

/** Whether the captain may offer play at all. */
export const GameplaySettingsSchema = z
  .object({
    /** FireRed/Emerald in the hosted PokeAgent MMO. */
    pokeagentMmoEnabled: z.boolean().default(false),
    /** Rivals Agent session API; its bearer lives under rivals-agent in the broker. */
    rivalsUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === "/"
        );
      }, "Rivals URL must be an HTTP(S) origin without credentials")
      .optional(),
  })
  .strict();
export type GameplaySettings = z.infer<typeof GameplaySettingsSchema>;

/** Exact host identities only: no URLs, credentials, paths, wildcards or IPv6 scope IDs. */
export const MinecraftHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase().replace(/\.$/u, ""))
  .refine(
    (value) =>
      !value.includes("%") &&
      (isIP(value) !== 0 ||
        value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))),
    "must be a literal IP address or DNS hostname",
  );

/** Owner-only profile material. The captain receives only the profile's id and name. */
export const MinecraftConfiguredProfileSchema = z.strictObject({
  id: MinecraftServerProfileIdSchema,
  name: z.string().trim().min(1).max(128),
  host: MinecraftHostSchema,
  port: z.number().int().min(1).max(65_535).default(25_565),
  version: z
    .string()
    .regex(/^\d+\.\d+(?:\.\d+)?$/u)
    .max(32),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,16}$/u)
    .default("Clankie"),
  /** Online account authentication is a later broker-backed capability. */
  auth: z.literal("offline").default("offline"),
});
export type MinecraftConfiguredProfile = z.infer<typeof MinecraftConfiguredProfileSchema>;

export const MinecraftPublicEndpointSchema = z.strictObject({
  host: MinecraftHostSchema,
  port: z.number().int().min(1).max(65_535).default(25_565),
});

export const MinecraftSettingsSchema = z
  .strictObject({
    play: MinecraftPlaySettingsSchema.default(() => MinecraftPlaySettingsSchema.parse({})),
    profiles: z.array(MinecraftConfiguredProfileSchema).max(32).default([]),
    /** Public destinations require approval of the actual resolved/SRV target and port. */
    publicAllowlist: z.array(MinecraftPublicEndpointSchema).max(64).default([]),
  })
  .superRefine((value, context) => {
    if (new Set(value.profiles.map((profile) => profile.id)).size !== value.profiles.length)
      context.addIssue({ code: "custom", path: ["profiles"], message: "Profile ids must be unique" });
  });
export type MinecraftSettings = z.infer<typeof MinecraftSettingsSchema>;

/**
 * How the owner wants work routed across the agents Clankie leads.
 *
 * Free text, and deliberately not a table of roles: an enum of `reviewer` /
 * `implementer` only ever covers the situations someone enumerated, and the
 * interesting ones are conditional — a harness for a language, a second opinion
 * on work that already passed review, a mix that avoids shared blind spots.
 * The thing reading this is a model, so prose costs less than a matcher and
 * says more.
 *
 * Preferences, never authority. This says who he should reach for, not what he
 * is permitted to do: a note here can no more widen his reach than a warmer
 * persona can.
 *
 * Beside the notes, two small enums state the owner's budget, because budget is
 * one of the few things that is not conditional: the swarm size to aim for
 * (`size`) and how a model and effort are picked per job (`models`). Both are
 * targets the lead sizes to, never enforced caps: nothing counts seats against
 * them, and an owner who wants a thousand agents says `max` or says so in the
 * notes. Like the notes, they never grant reach. The defaults, `max` and
 * `optimal`, assume no plan limit.
 */
export const FLEET_SIZES = ["max", "large", "small", "solo"] as const;
export type FleetSize = (typeof FLEET_SIZES)[number];
export const FLEET_MODEL_MODES = ["optimal", "efficient"] as const;
export type FleetModelMode = (typeof FLEET_MODEL_MODES)[number];

/** The plan each size fits and the swarm it aims for: one text for the CLI, the TUI and his prompt. */
export const FLEET_SIZE_GUIDANCE: Readonly<Record<FleetSize, string>> = {
  max: "Several top-tier plans (for example four or five $200/month subscriptions): aim for maximum bandwidth, one worker per separable deliverable plus independent reviewers, as far as the work and the machines can use them. No ceiling.",
  large: "One or two top-tier plans: aim for around six concurrent workers, reviewers included.",
  small:
    "One mid-tier plan (about $100/month): aim for one or two workers at a time beside you, and sequence the rest.",
  solo: "Pay-per-token API use: aim for no standing workers. Do the work yourself or through short native subagents, and ask before a long or parallel run.",
};

/** How a model and effort are chosen per job under each mode. */
export const FLEET_MODEL_GUIDANCE: Readonly<Record<FleetModelMode, string>> = {
  optimal: "Pick the strongest model and the effort each job needs; cost is not a reason to downgrade a job.",
  efficient:
    "Pick the smallest model and the lowest effort that still meet each job's acceptance; keep the top model for consequential boundaries (safety, data integrity, live surfaces, a disputed review).",
};

export const FleetSettingsSchema = z
  .object({
    hire: HireProfileSchema.optional(),
    notes: z.string().max(4_000).default(""),
    size: z.enum(FLEET_SIZES).default("max"),
    models: z.enum(FLEET_MODEL_MODES).default("optimal"),
    /** Fleet admission grants connected tools unless the owner turns this off. */
    tools: z.enum(["connected", "off"]).default("connected"),
    /** Proven native workers may message their own fleet unless the owner turns this off. */
    peerMessages: z.enum(["on", "off"]).default("on"),
  })
  .strict();
export type FleetSettings = z.infer<typeof FleetSettingsSchema>;

/** Server ids prefix every tool name they contribute, so keep them identifier-shaped. */
const McpServerIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/u, "must be lowercase letters, digits, and underscores");

/**
 * One MCP server Clankie may call tools on.
 *
 * Owner-authored and non-secret, like everything else here: `credential` names
 * a **broker provider id**, never a token. The host resolves that id at call
 * time and sends it as a Bearer header (http) or injects it into
 * {@link credentialEnv} when spawning the process (stdio).
 *
 * `lane` is the authority gate and defaults closed. A server reached from every
 * room is a capability handed to everyone who can type at him, so widening it
 * is a deliberate edit rather than what happens when the field is omitted.
 */
export const McpServerSchema = z
  .object({
    id: McpServerIdSchema,
    transport: z.enum(["stdio", "http"]).default("stdio"),
    /** stdio: the executable to run. */
    command: z.string().min(1).max(500).optional(),
    args: z.array(z.string().max(1_000)).max(64).default([]),
    /** http: the server endpoint. */
    url: z.string().min(1).max(2_000).optional(),
    lane: z.enum(["operator", "everywhere"]).default("operator"),
    /** Broker provider id holding this server's secret. Never the secret itself. */
    credential: z.string().min(1).max(128).optional(),
    /** stdio only: environment variable that receives the resolved secret. */
    credentialEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/u, "must be an uppercase environment variable name")
      .optional(),
    /**
     * Tools active from the first turn. Empty means all of them — right for a
     * small server, and why a large one should narrow it: everything active is
     * described in the prompt on every turn, and `mcp_tool_search` pulls in the
     * rest on demand.
     */
    initialTools: z.array(z.string().min(1).max(128)).max(64).default([]),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.transport === "stdio" && value.command === undefined) {
      context.addIssue({ code: "custom", path: ["command"], message: "required when transport is stdio" });
    }
    if (value.transport === "http") {
      if (value.url === undefined) {
        context.addIssue({ code: "custom", path: ["url"], message: "required when transport is http" });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(value.url);
      } catch {
        context.addIssue({ code: "custom", path: ["url"], message: "must be an absolute URL" });
        return;
      }
      // A bearer token rides every request to this URL. Plaintext is allowed
      // only where it cannot leave the machine.
      const loopback = parsed.hostname === "localhost" || /^127(\.\d{1,3}){3}$/u.test(parsed.hostname);
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
        context.addIssue({ code: "custom", path: ["url"], message: "must be https, or http on loopback" });
      }
    }
  });
export type McpServerSettings = z.infer<typeof McpServerSchema>;

/**
 * Owner-authored MCP servers, on top of the connectors Clankie ships knowing
 * about (`/connect linear`). A curated connector needs no entry here; this is
 * the escape hatch for everything else.
 */
export const McpSettingsSchema = z
  .object({
    servers: z.array(McpServerSchema).max(32).default([]),
  })
  .strict();
export type McpSettings = z.infer<typeof McpSettingsSchema>;

const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u,
    {
      message: "must be a hostname",
    },
  );

/**
 * Mailbox coordinates. The password is broker-owned under provider id `email`.
 * Hosts and the username are public identifiers an operator wants to read back.
 */
export const EmailSettingsSchema = z
  .object({
    imapHost: HostnameSchema.optional(),
    imapPort: z.number().int().min(1).max(65535).default(993),
    smtpHost: HostnameSchema.optional(),
    smtpPort: z.number().int().min(1).max(65535).default(587),
    username: z.string().min(1).max(320).optional(),
    /**
     * The address he sends as, when that is not the address he signs in with.
     *
     * A mailbox on his own domain is commonly a forwarding address in front of
     * a provider mailbox — the sign-in name is the provider's, the identity is
     * his. Without this, every message he sends is signed with the plumbing
     * instead of with his name. Empty means the username is also the identity.
     */
    fromAddress: z.email().max(320).optional(),
    /** IMAP implicit TLS (usually port 993). SMTP uses its own port to pick STARTTLS vs implicit. */
    secure: z.boolean().default(true),
  })
  .strict();
export type EmailSettings = z.infer<typeof EmailSettingsSchema>;

/** Actor selectors are ORed; type exclusions always win. IDs are workspace-scoped. */
export const LinearWakeSettingsSchema = z
  .object({
    ownerUserIds: z.array(z.string().min(1).max(256)).max(100).default([]),
    actors: z
      .array(z.enum(["owner", "human", "self", "users"]))
      .max(4)
      .default(["owner"]),
    userIds: z.array(z.string().min(1).max(256)).max(100).default([]),
    notificationTypes: z.array(z.string().min(1).max(128)).max(100).default([]),
    excludedNotificationTypes: z.array(z.string().min(1).max(128)).max(100).default(["issueSubscribed"]),
  })
  .strict();
export type LinearWakeSettings = z.infer<typeof LinearWakeSettingsSchema>;

/** Live Linear awareness is opt-in; the signing secret lives in the credential broker. */
export const LinearWebhookSettingsSchema = z
  .object({
    following: z.boolean().default(false),
    wake: LinearWakeSettingsSchema.default(() => LinearWakeSettingsSchema.parse({})),
    /** Public URL registered in Linear; the signing secret remains broker-owned. */
    url: z.url({ protocol: /^https?$/ }).optional(),
  })
  .strict();
export type LinearWebhookSettings = z.infer<typeof LinearWebhookSettingsSchema>;

/**
 * The OAuth clients account connections use (ADR 0196). Client IDs are public;
 * secrets and tokens stay in the credential broker. A hosted body may get them
 * from its environment instead (`CLANKIE_GITHUB_OAUTH_CLIENT_ID`, …).
 */
export const OauthAppsSettingsSchema = z
  .object({
    github: z
      .object({
        clientId: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,128}$/u)
          .optional(),
      })
      .strict()
      .default(() => ({})),
    linear: z
      .object({
        /** A registered client; unset registers one dynamically at Linear's MCP server. */
        clientId: z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,128}$/u)
          .optional(),
        /** Where Linear sends the owner back, caught by the app and handed to the body sealed. */
        redirectUri: z.url().max(512).optional(),
      })
      .strict()
      .default(() => ({})),
  })
  .strict();
export type OauthAppsSettings = z.infer<typeof OauthAppsSettingsSchema>;

/** Read-only transcript sources. SSH authentication stays in the owner's SSH configuration. */
export const AgentHostConnectionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .refine((value) => value !== "local", "local is reserved"),
    ssh: z.string().regex(/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u),
    shell: z.enum(["posix", "powershell"]),
  })
  .strict();
export type AgentHostConnection = z.infer<typeof AgentHostConnectionSchema>;

/** Product/tool skills are always available; this selection controls the opinionated bundle. */
export const SkillsSettingsSchema = z
  .object({
    opinionated: z.boolean().default(true),
    exclude: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/u)).default([]),
  })
  .strict();
export type SkillsSettings = z.infer<typeof SkillsSettingsSchema>;

export const ClankieSettingsSchema = z
  .object({
    schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION),
    client: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("local") }).strict(),
        z
          .object({
            mode: z.literal("hosted"),
            gatewayUrl: z.string().url(),
            hostId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
          })
          .strict(),
      ])
      .optional(),
    // Defaulted lazily: the parsed output carries every field's own default,
    // which a bare `{}` literal does not satisfy.
    discord: DiscordSettingsSchema.default(() => DiscordSettingsSchema.parse({})),
    persona: PersonaSettingsSchema.default(() => PersonaSettingsSchema.parse({})),
    voice: VoiceSettingsSchema.default(() => VoiceSettingsSchema.parse({})),
    relay: RelaySettingsSchema.default(() => RelaySettingsSchema.parse({})),
    host: HostSettingsSchema.default(() => HostSettingsSchema.parse({})),
    publicGateway: PublicGatewaySettingsSchema.default(() => PublicGatewaySettingsSchema.parse({})),
    claudeAccounts: z
      .array(
        z
          .object({ label: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), home: z.string().min(1).max(4096) })
          .strict(),
      )
      .max(32)
      .default([])
      .refine(
        (accounts) =>
          new Set(accounts.map((a) => a.label)).size === accounts.length &&
          accounts.every((a) => a.label !== "default"),
        "Claude accounts need unique non-default labels",
      ),
    codexAccounts: z
      .array(
        z
          .object({
            label: z
              .string()
              .regex(/^[a-z][a-z0-9_-]{0,63}$/u)
              .refine((value) => value !== "default", "default is reserved"),
            home: z
              .string()
              .min(1)
              .refine((value) => value.startsWith("/"), "Codex home must be absolute"),
          })
          .strict(),
      )
      .max(15)
      .refine(
        (accounts) =>
          new Set(accounts.map((a) => a.label)).size === accounts.length &&
          new Set(accounts.map((a) => a.home)).size === accounts.length,
        "Codex accounts need unique labels and homes",
      )
      .default([]),
    machines: z
      .array(
        AgentHostConnectionSchema.extend({
          aliases: z
            .array(
              z
                .string()
                .regex(/^[a-z][a-z0-9-]{0,63}$/u)
                .refine((id) => id !== "local"),
            )
            .max(30)
            .default([]),
        }),
      )
      .max(30)
      .default([]),
    agentHosts: z
      .object({ connections: z.array(AgentHostConnectionSchema).max(60).default([]) })
      .strict()
      .refine(
        (value) => new Set(value.connections.map((entry) => entry.id)).size === value.connections.length,
        "Agent host IDs must be unique",
      )
      .default(() => ({ connections: [] })),
    execution: z
      .object({
        connections: z.array(ExecutionConnectionSchema).max(15).default([]),
        workspaces: ExecutionWorkspacesSchema.optional(),
        capacity: z.number().int().min(0).nullable().optional(),
      })
      .strict()
      .refine(
        (value) => new Set(value.connections.map((entry) => entry.id)).size === value.connections.length,
        "Execution connection IDs must be unique",
      )
      .refine(
        (value) =>
          value.connections.every(
            (entry) =>
              (entry.machine !== undefined && entry.machine !== "local" && entry.socketPath === undefined) ||
              (entry.ssh === undefined) !== (entry.socketPath === undefined),
          ),
        "An execution connection is either a local socket or an ssh fleet",
      )
      .default(() => ({ connections: [] })),
    herdr: HerdrSettingsSchema.default(() => HerdrSettingsSchema.parse({})),
    skills: SkillsSettingsSchema.default(() => SkillsSettingsSchema.parse({})),
    fleet: FleetSettingsSchema.default(() => FleetSettingsSchema.parse({})),
    projects: ProjectsSettingsSchema.default(() => ProjectsSettingsSchema.parse({})),
    captain: CaptainSettingsSchema.default(() => CaptainSettingsSchema.parse({})),
    gameplay: GameplaySettingsSchema.default(() => GameplaySettingsSchema.parse({})),
    desktop: DesktopSettingsSchema.default(() => DesktopSettingsSchema.parse({})),
    minecraft: MinecraftSettingsSchema.default(() => MinecraftSettingsSchema.parse({})),
    browser: BrowserSettingsSchema.default(() => BrowserSettingsSchema.parse({})),
    mcp: McpSettingsSchema.default(() => McpSettingsSchema.parse({})),
    email: EmailSettingsSchema.default(() => EmailSettingsSchema.parse({})),
    linearWebhook: LinearWebhookSettingsSchema.default(() => LinearWebhookSettingsSchema.parse({})),
    oauthApps: OauthAppsSettingsSchema.default(() => OauthAppsSettingsSchema.parse({})),
  })
  .strict()
  .superRefine((settings, context) => {
    const identities = settings.machines.flatMap((machine) => [machine.id, ...machine.aliases]);
    if (new Set(identities).size !== identities.length)
      context.addIssue({
        code: "custom",
        path: ["machines"],
        message: "Machine IDs and aliases must be unique",
      });
    const routes = settings.machines.map((machine) => `${machine.shell}:${machine.ssh}`);
    if (new Set(routes).size !== routes.length)
      context.addIssue({
        code: "custom",
        path: ["machines"],
        message: "Each SSH transport belongs to one machine",
      });
    for (const connection of settings.execution.connections) {
      if (connection.machine === undefined) continue; // legacy input, migrated by SettingsStore
      const machine = settings.machines.find((entry) => entry.id === connection.machine);
      if (
        connection.machine === "local"
          ? connection.ssh !== undefined
          : !machine ||
            connection.socketPath !== undefined ||
            (connection.ssh !== undefined &&
              (connection.ssh.host !== machine.ssh || connection.ssh.shell !== machine.shell))
      )
        context.addIssue({
          code: "custom",
          path: ["execution", "connections"],
          message: "Connection transport must match its machine",
        });
    }
  });
export type ClankieSettings = z.infer<typeof ClankieSettingsSchema>;

export function emptySettings(): ClankieSettings {
  return ClankieSettingsSchema.parse({ schemaVersion: SETTINGS_SCHEMA_VERSION });
}

/**
 * Top-level sections earlier versions wrote that this one no longer has.
 *
 * - `linear`: a default team id, back when a hand-written GraphQL port needed
 *   one. Linear is reached over MCP now and its server resolves the team.
 */
const RETIRED_SETTINGS_KEYS: readonly string[] = ["linear", "swarm"];
const RETIRED_DISCORD_SETTINGS_KEYS: readonly string[] = ["possessorVoiceEnabled"];
const RETIRED_GAMEPLAY_SETTINGS_KEYS: readonly string[] = ["pokemonEmulatorEnabled"];

/**
 * Drops sections this version has retired, so an owner whose file predates the
 * change is not met with a parse error on a key that no longer means anything.
 *
 * Deliberately a named list rather than stripping every unknown key: the schema
 * is strict so a typo surfaces loudly instead of silently doing nothing, and
 * that property is worth keeping. A retired section can only ever remove
 * capability, never widen it, which is why it is safe to discard unread.
 */
export function dropRetiredSettings(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const settings = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([key]) => !RETIRED_SETTINGS_KEYS.includes(key)),
  );
  const execution = settings["execution"];
  if (execution !== null && typeof execution === "object" && !Array.isArray(execution)) {
    const retire = (value: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(value).filter(
          ([key]) => !["workerMode", "workerHarness", "budget", "relay"].includes(key),
        ),
      );
    const value = retire(execution as Record<string, unknown>);
    if (Array.isArray(value.connections))
      value.connections = value.connections.map((entry: unknown) =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
          ? retire(entry as Record<string, unknown>)
          : entry,
      );
    settings["execution"] = value;
  }
  const discord = settings["discord"];
  if (discord !== null && typeof discord === "object" && !Array.isArray(discord)) {
    settings["discord"] = Object.fromEntries(
      Object.entries(discord as Record<string, unknown>).filter(
        ([key]) => !RETIRED_DISCORD_SETTINGS_KEYS.includes(key),
      ),
    );
  }
  const gameplay = settings["gameplay"];
  if (gameplay !== null && typeof gameplay === "object" && !Array.isArray(gameplay)) {
    settings["gameplay"] = Object.fromEntries(
      Object.entries(gameplay as Record<string, unknown>).filter(
        ([key]) => !RETIRED_GAMEPLAY_SETTINGS_KEYS.includes(key),
      ),
    );
  }
  const linearWebhook = settings["linearWebhook"];
  if (linearWebhook !== null && typeof linearWebhook === "object" && !Array.isArray(linearWebhook)) {
    settings["linearWebhook"] = Object.fromEntries(
      Object.entries(linearWebhook).filter(([key]) => key !== "actorEmail"),
    );
  }
  return settings;
}

/** Token prefixes that must never reach the settings file. */
const SECRET_PREFIXES = [
  "clankie_",
  "sk-",
  "xoxb-",
  "ghp_",
  "github_pat_",
  "figd_",
  "lin_api_",
  "Bot ",
  "Bearer ",
];

/**
 * Refuse to persist anything token-shaped.
 *
 * A settings file is world-readable-ish by intent (mode 0600, but shown in the
 * TUI unredacted and safe to paste into an issue). A secret landing here would
 * be disclosed by the very affordances that make settings useful, so the write
 * path fails closed instead of relying on the operator to notice.
 */
export function assertNoSecretShapedValue(settings: unknown): void {
  for (const value of walkStrings(settings)) {
    const trimmed = value.trim();
    if (SECRET_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
      throw new Error(
        "settings_secret_shaped_value: a token-shaped value cannot be stored in settings; use the credential broker",
      );
    }
    // Discord bot tokens are dot-separated base64 segments of substantial length.
    if (/^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}$/u.test(trimmed)) {
      throw new Error(
        "settings_secret_shaped_value: a token-shaped value cannot be stored in settings; use the credential broker",
      );
    }
  }
}

function* walkStrings(value: unknown): Generator<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* walkStrings(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* walkStrings(item);
  }
}
