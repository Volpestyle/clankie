import { z } from "zod";
import { DiscordSettingsSchema } from "./discord-settings.ts";
import type { DiscordSettings } from "./discord-settings.ts";
import { DiscordDirectoryEntrySchema, type DiscordDirectoryEntry } from "./discord-directory.ts";
import { DiscordPermissionStatusSchema } from "./discord-permissions.ts";
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
    title: "Server setup",
    fields: [
      { key: "serverId", label: "Connected server ID", kind: "text" },
      { key: "role", label: "Clankie’s role", kind: "choice", choices: ["participant", "admin"] },
      { key: "fleetEnabled", label: "Fleet in Discord", kind: "boolean" },
      { key: "fleetChannelId", label: "Participant fleet channel ID", kind: "text" },
      {
        key: "trackingLevel",
        label: "Project tracking",
        kind: "choice",
        choices: ["off", "project_updates", "project_activity", "all_issues"],
      },
    ],
  },
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
  participant: "Participant",
  admin: "Admin · dedicated server",
  on: "on",
  off: "off",
  project_updates: "project updates only",
  project_activity: "project activity",
  all_issues: "every issue notification",
  administrator: "Administrator",
  read_message_history: "Read Message History",
  send_messages_in_threads: "Send Messages in Threads",
  connect: "Connect",
  speak: "Speak",
  add_reactions: "Add Reactions",
  embed_links: "Embed Links",
  attach_files: "Attach Files",
  use_vad: "Use Voice Activity",
  use_application_commands: "Use Application Commands",
  create_public_threads: "Create Public Threads",
  fleet_channel: "Participant fleet channel",
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
const PickerKind = z.enum([
  "server",
  "role",
  "fleet",
  "tracking",
  "channels",
  "computer_access",
  "team_visibility",
]);
const SentencePart = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z
    .object({
      kind: z.literal("picker"),
      picker: PickerKind,
      fields: z.array(SettingKey),
      placeholder: z.string(),
      choices: z.array(z.string()).optional(),
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
    id: z.enum(["connect", "fleet", "tracking", "home", "talk", "computer", "team"]),
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
        "administrator",
        "read_message_history",
        "send_messages_in_threads",
        "connect",
        "speak",
        "fleet_channel",
        "add_reactions",
        "embed_links",
        "attach_files",
        "use_vad",
        "use_application_commands",
        "create_public_threads",
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
    id: "connect",
    parts: [
      { kind: "text", text: "Connect " },
      { kind: "picker", picker: "server", fields: ["serverId"], placeholder: "server" },
      { kind: "text", text: " with Clankie as " },
      {
        kind: "picker",
        picker: "role",
        fields: ["role"],
        choices: ["participant", "admin"],
        placeholder: "Participant / Admin",
      },
      { kind: "text", text: "." },
    ],
    help: "Participant follows Discord’s channel permissions. Admin gives Clankie full rein in a dedicated server; he never deletes the server or transfers ownership.",
    checks: [
      "account",
      "view_channel",
      "send_messages",
      "read_message_history",
      "send_messages_in_threads",
      "connect",
      "speak",
      "add_reactions",
      "embed_links",
      "attach_files",
      "use_vad",
      "use_application_commands",
      "create_public_threads",
    ],
  },
  {
    id: "fleet",
    parts: [
      { kind: "text", text: "Fleet in Discord is " },
      {
        kind: "picker",
        picker: "fleet",
        fields: ["fleetEnabled"],
        choices: ["on", "off"],
        placeholder: "on / off",
      },
      { kind: "text", text: "." },
    ],
    help: "Admin creates fleet channels. Participant posts fleet messages only in the existing fleet channel given in Advanced. Turning this off keeps room connections.",
    checks: [],
  },
  {
    id: "tracking",
    parts: [
      { kind: "text", text: "Project tracking is " },
      {
        kind: "picker",
        picker: "tracking",
        fields: ["trackingLevel"],
        choices: ["off", "project_updates", "project_activity", "all_issues"],
        placeholder: "off / project updates / project activity / every issue",
      },
      { kind: "text", text: "." },
    ],
    help: "Project updates adds published updates. Project activity also includes status changes, milestones, and new or finished issues. Every issue notification includes all issue activity. Admin mirrors tracked projects as channels or forums, with one post per issue.",
    checks: [],
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
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    sentences: z.array(DiscordSetupSentenceSchema),
    advancedGroups: z.array(z.object({ title: z.string(), fields: z.array(DiscordFieldSchema) }).strict()),
    choiceLabels: z.record(z.string(), z.string()),
  })
  .strict();
export const DISCORD_SETUP_DEFINITION = DiscordSetupDefinitionSchema.parse({
  schemaVersion: 2,
  sentences: DISCORD_SETUP_SENTENCES,
  advancedGroups: DISCORD_SETTING_GROUPS,
  choiceLabels: DISCORD_CHOICE_LABELS,
});
/** Role-correct requirements; these check the invite grants, not a picked room. */
export function discordSetupDefinition(
  settings: DiscordSettings,
): z.infer<typeof DiscordSetupDefinitionSchema> {
  return {
    ...DISCORD_SETUP_DEFINITION,
    sentences: DISCORD_SETUP_DEFINITION.sentences.map((sentence) =>
      sentence.id === "connect" && settings.role === "admin"
        ? { ...sentence, checks: ["account", "administrator"] }
        : sentence.id === "fleet" && settings.fleetEnabled && settings.role === "participant"
          ? { ...sentence, checks: ["fleet_channel", "send_messages"] }
          : sentence,
    ),
  };
}

// Discord’s documented permission bits. No server-management bits in a member invitation.
export const DISCORD_PARTICIPANT_INVITE_PERMISSIONS = String(
  [6n, 10n, 11n, 14n, 15n, 16n, 20n, 21n, 25n, 31n, 35n, 38n].reduce(
    (permissions, bit) => permissions | (1n << bit),
    0n,
  ),
);
export const DISCORD_ADMIN_INVITE_PERMISSIONS = "8";
export function discordRoleInviteUrl(
  applicationId: string,
  role: DiscordSettings["role"],
  serverId?: string,
): string {
  const query = new URLSearchParams({
    client_id: applicationId,
    permissions: role === "admin" ? DISCORD_ADMIN_INVITE_PERMISSIONS : DISCORD_PARTICIPANT_INVITE_PERMISSIONS,
    scope: "bot applications.commands",
    ...(serverId ? { guild_id: serverId } : {}),
  });
  return `https://discord.com/oauth2/authorize?${query.toString()}`;
}

export const DiscordSetupSnapshotSchema = z
  .object({
    definition: DiscordSetupDefinitionSchema,
    /** Supplied by the host, never inferred from the screen opening these settings. */
    machineName: z.string().min(1).max(256),
    /** Computed only from the connected account's gateway evidence. Older hosts omit it. */
    checks: z
      .array(
        z
          .object({
            sentenceId: z.enum(["connect", "fleet", "tracking", "talk", "team"]),
            kind: z.enum([
              "view_channel",
              "send_messages",
              "manage_channels",
              "manage_webhooks",
              "administrator",
              "read_message_history",
              "send_messages_in_threads",
              "connect",
              "speak",
              "fleet_channel",
              "add_reactions",
              "embed_links",
              "attach_files",
              "use_vad",
              "use_application_commands",
              "create_public_threads",
            ]),
            status: DiscordPermissionStatusSchema,
          })
          .strict(),
      )
      .optional(),
    /** A surface must explicitly select a room and invoke the authenticated POST. */
    testPostAvailable: z.boolean().optional(),
    invite: z
      .object({
        role: DiscordSettingsSchema.shape.role,
        permissions: z.string().regex(/^\d+$/u),
        url: z.string().url(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DiscordSetupSnapshot = z.infer<typeof DiscordSetupSnapshotSchema>;
