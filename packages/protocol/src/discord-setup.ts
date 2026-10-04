import { z } from "zod";
import { DiscordSettingsSchema } from "./discord-settings.ts";
import type { DiscordSettings } from "./discord-settings.ts";
import { DiscordDirectoryEntrySchema, type DiscordDirectoryEntry } from "./discord-directory.ts";
export type DiscordField = {
  key: keyof DiscordSettings;
  label: string;
  help?: string;
  kind: "boolean" | "ids" | "text" | "number" | "choice";
  choices?: readonly string[];
  /** Directory kinds accepted by this field when a sentence picks rooms. */
  directoryKinds?: readonly DiscordDirectoryEntry["kind"][];
};
export const DISCORD_SETTING_GROUPS: readonly { title: string; fields: readonly DiscordField[] }[] = [
  {
    title: "Identity and access",
    fields: [
      { key: "applicationId", label: "Application ID", kind: "text" },
      { key: "guildId", label: "Command server ID", kind: "text" },
      {
        key: "swarmGuildId",
        label: "Managed server ID",
        kind: "text",
        help: "The server where Clankie can create rooms.",
      },
      {
        key: "teamVisible",
        label: "Show the team’s rooms",
        kind: "boolean",
        help: "Hide or show the team without forgetting its server or deleting its room connections. Unset means visible.",
      },
      { key: "ownerUserId", label: "Owner user ID", kind: "text" },
      { key: "ambientRoleIds", label: "Roles Clankie can chat with", kind: "ids" },
      { key: "ambientUserIds", label: "People Clankie can chat with", kind: "ids" },
      { key: "approvalRoleIds", label: "Approval role IDs", kind: "ids" },
      {
        key: "systemActorUserIds",
        label: "Machine access user IDs",
        kind: "ids",
        help: "These people can ask Clankie to use his computer.",
      },
      {
        key: "systemActorGuildIds",
        label: "Machine access server IDs",
        kind: "ids",
        help: "People Clankie can hear in these servers can ask him to use his computer.",
      },
      {
        key: "systemActorChannelIds",
        label: "Channels that allow computer access",
        kind: "ids",
        help: "Leave empty to allow every permitted channel in those servers.",
      },
    ],
  },
  {
    title: "Text and presence",
    fields: [
      { key: "textIngressEnabled", label: "Receive text", kind: "boolean" },
      { key: "ingressGuildIds", label: "Text server IDs", kind: "ids" },
      { key: "ingressChannelIds", label: "Text channel IDs", kind: "ids" },
      {
        key: "ingressDmPolicy",
        label: "Direct message policy",
        kind: "choice",
        choices: ["deny", "owner_only", "allowlist"],
      },
      { key: "ingressDmUserIds", label: "Direct message user IDs", kind: "ids" },
      { key: "ingressContextMessages", label: "Context messages (0–50)", kind: "number" },
      { key: "toolProgressChannelIds", label: "Tool progress channel IDs", kind: "ids" },
      { key: "presenceGuildIds", label: "Presence server IDs", kind: "ids" },
      { key: "presenceChannelIds", label: "Presence channel IDs", kind: "ids" },
      { key: "activeBody", label: "Discord account type", kind: "choice", choices: ["bot", "user_session"] },
    ],
  },
  {
    title: "Voice and consent",
    fields: [
      { key: "voiceEnabled", label: "Voice enabled", kind: "boolean" },
      { key: "voiceGuildIds", label: "Voice server IDs", kind: "ids" },
      { key: "voiceChannelIds", label: "Voice channel IDs", kind: "ids", directoryKinds: ["voice", "stage"] },
      { key: "voiceChannelId", label: "Default voice channel ID", kind: "text" },
      {
        key: "voiceJoinPolicy",
        label: "Voice join policy",
        kind: "choice",
        choices: ["ambient", "guild_members"],
      },
      {
        key: "voiceConsentPolicy",
        label: "Voice consent policy",
        kind: "choice",
        choices: ["explicit", "presence"],
        help: "Ask each person first, or use their presence in the call. Anyone can opt out.",
      },
      {
        key: "voiceTranscriptLoggingEnabled",
        label: "Save voice transcripts",
        kind: "boolean",
        help: "Save what people agreed Clankie could hear.",
      },
    ],
  },
  {
    title: "Discord user account",
    fields: [
      {
        key: "userSessionEnabled",
        label: "Use a Discord user account",
        kind: "boolean",
        help: "Requires a connected Discord user account.",
      },
      { key: "userSessionGuildIds", label: "User account server IDs", kind: "ids" },
      { key: "userSessionChannelIds", label: "User account channel IDs", kind: "ids" },
      { key: "userSessionVoiceEnabled", label: "User account speech enabled", kind: "boolean" },
      {
        key: "userSessionVoiceChannelIds",
        label: "User account voice channel IDs",
        kind: "ids",
        directoryKinds: ["voice", "stage"],
      },
      {
        key: "userSessionDmPolicy",
        label: "User account direct message policy",
        kind: "choice",
        choices: ["deny", "owner_only", "allowlist"],
      },
      { key: "userSessionDmUserIds", label: "User account direct message user IDs", kind: "ids" },
    ],
  },
  {
    title: "Discord activities",
    fields: [
      { key: "activityApplicationIdGba", label: "Activity application ID", kind: "text" },
      { key: "activityTunnelName", label: "Activity connection name", kind: "text" },
      { key: "activityTunnelHostname", label: "Activity address", kind: "text" },
    ],
  },
];

export const DISCORD_CHOICE_LABELS: Readonly<Record<string, string>> = {
  deny: "Nobody",
  owner_only: "Only me",
  allowlist: "Selected people",
  bot: "Bot account",
  user_session: "User account",
  ambient: "People Clankie can chat with",
  guild_members: "Server members",
  explicit: "Ask each person",
  presence: "People in the call",
  team_visible: "show up",
  team_hidden: "stay hidden",
  no_server: "no selected server",
  unavailable_server: "an unavailable server",
  all_rooms: "all permitted rooms",
  no_rooms: "no selected rooms",
  unavailable_room: "an unavailable room",
  unavailable_person: "an unavailable person",
  account: "Discord account",
  view_channel: "View Channel",
  send_messages: "Send Messages",
  computer_access: "Computer access",
  manage_channels: "Manage Channels",
  manage_webhooks: "Manage Webhooks",
  test_post: "Test post",
  partial_directory: "Some choices may be missing from the connected account’s list.",
};

const SettingKey = z.enum(
  Object.keys(DiscordSettingsSchema.shape) as [keyof DiscordSettings, ...Array<keyof DiscordSettings>],
);
const PickerKind = z.enum(["server", "channels", "computer_access", "team_visibility"]);
const SentencePart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      kind: z.literal("picker"),
      picker: PickerKind,
      fields: z.array(SettingKey),
      placeholder: z.string(),
      /** Settings that scope a room/person picker to the selected social servers. */
      serverFields: z.array(SettingKey).optional(),
      /** Additive bindings: surfaces apply these instead of maintaining field mappings. */
      enables: z
        .array(
          z
            .object({ field: SettingKey, kinds: z.array(DiscordDirectoryEntrySchema.shape.kind).optional() })
            .strict(),
        )
        .optional(),
      accessFields: z
        .object({ people: SettingKey, servers: SettingKey, channels: SettingKey })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ kind: z.literal("machine") }).strict(),
]);
export const DiscordSetupSentenceSchema = z
  .object({
    id: z.enum(["home", "talk", "computer", "team"]),
    parts: z.array(SentencePart),
    help: z.string(),
    checks: z.array(
      z.enum([
        "account",
        "view_channel",
        "send_messages",
        "computer_access",
        "manage_channels",
        "manage_webhooks",
        "test_post",
      ]),
    ),
    /** Only this sentence may offer a computer-access choice. Presets cannot grant it. */
    explicitComputerAccess: z.boolean().optional(),
  })
  .strict();
export type DiscordSetupSentence = z.infer<typeof DiscordSetupSentenceSchema>;

/** Node-free display definition shared by the app, console and hosted dashboard. */
export const DISCORD_SETUP_SENTENCES: readonly DiscordSetupSentence[] = [
  {
    id: "home",
    parts: [
      { kind: "text", text: "Clankie lives in " },
      {
        kind: "picker",
        picker: "server",
        fields: ["guildId", "ingressGuildIds", "presenceGuildIds", "voiceGuildIds", "userSessionGuildIds"],
        placeholder: "server",
      },
      { kind: "text", text: "." },
    ],
    help: "Choose a server his connected Discord account can see.",
    checks: ["account"],
  },
  {
    id: "talk",
    parts: [
      { kind: "text", text: "He talks with " },
      {
        kind: "picker",
        picker: "channels",
        fields: [
          "ingressChannelIds",
          "presenceChannelIds",
          "voiceChannelIds",
          "userSessionChannelIds",
          "userSessionVoiceChannelIds",
        ],
        placeholder: "#general, #dev",
        serverFields: ["ingressGuildIds", "presenceGuildIds", "voiceGuildIds", "userSessionGuildIds"],
        enables: [
          { field: "textIngressEnabled" },
          { field: "voiceEnabled", kinds: ["voice", "stage"] },
          { field: "userSessionVoiceEnabled", kinds: ["voice", "stage"] },
        ],
      },
      { kind: "text", text: "." },
    ],
    help: "Choose the rooms where people can talk with Clankie. Computer access is a separate choice.",
    checks: ["view_channel", "send_messages", "test_post"],
  },
  {
    id: "computer",
    parts: [
      {
        kind: "picker",
        picker: "computer_access",
        fields: ["systemActorUserIds", "systemActorGuildIds", "systemActorChannelIds"],
        placeholder: "Only me",
        serverFields: ["guildId", "ingressGuildIds", "userSessionGuildIds"],
        accessFields: {
          people: "systemActorUserIds",
          servers: "systemActorGuildIds",
          channels: "systemActorChannelIds",
        },
      },
      { kind: "text", text: " can ask him to use " },
      { kind: "machine" },
      { kind: "text", text: "." },
    ],
    help: "Choose explicitly who may ask Clankie to use his computer. Changing his server or rooms never grants access.",
    checks: ["computer_access"],
    explicitComputerAccess: true,
  },
  {
    id: "team",
    parts: [
      { kind: "text", text: "The team’s rooms " },
      {
        kind: "picker",
        picker: "team_visibility",
        fields: ["teamVisible"],
        placeholder: "show up / stay hidden",
      },
      { kind: "text", text: " in " },
      { kind: "picker", picker: "server", fields: ["swarmGuildId"], placeholder: "server" },
      { kind: "text", text: "." },
    ],
    help: "Choose the managed server for the team. Hiding keeps that choice and its room connections; showing restores them.",
    checks: ["manage_channels", "manage_webhooks", "send_messages", "test_post"],
  },
];
const DiscordFieldSchema = z
  .object({
    key: SettingKey,
    label: z.string(),
    help: z.string().optional(),
    kind: z.enum(["boolean", "ids", "text", "number", "choice"]),
    choices: z.array(z.string()).optional(),
    directoryKinds: z.array(DiscordDirectoryEntrySchema.shape.kind).optional(),
  })
  .strict();
export const DiscordSetupDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    sentences: z.array(DiscordSetupSentenceSchema),
    advancedGroups: z.array(z.object({ title: z.string(), fields: z.array(DiscordFieldSchema) }).strict()),
    choiceLabels: z.record(z.string(), z.string()),
  })
  .strict();
export const DISCORD_SETUP_DEFINITION = DiscordSetupDefinitionSchema.parse({
  schemaVersion: 1,
  sentences: DISCORD_SETUP_SENTENCES,
  advancedGroups: DISCORD_SETTING_GROUPS,
  choiceLabels: DISCORD_CHOICE_LABELS,
});
export const DiscordSetupSnapshotSchema = z
  .object({
    definition: DiscordSetupDefinitionSchema,
    /** Supplied by the host, never inferred from the screen opening these settings. */
    machineName: z.string().min(1).max(256),
  })
  .strict();
export type DiscordSetupSnapshot = z.infer<typeof DiscordSetupSnapshotSchema>;
