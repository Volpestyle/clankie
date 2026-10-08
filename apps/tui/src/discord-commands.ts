import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./command/owner-settings-api.ts";
import { stripVTControlCharacters } from "node:util";
import {
  DISCORD_ATTENTION,
  DISCORD_SETTINGS_PATH,
  DiscordSettingsSnapshotSchema,
  type DiscordSettingsSnapshot,
  DiscordSettingsSchema,
  DISCORD_SETTING_GROUPS,
  DISCORD_PARTICIPANT_INVITE_PERMISSIONS,
  discordRoleInviteUrl,
  discordServerSettings,
  discordWakeTrigger,
} from "@clankie/protocol";
import type { ClankieApiClient } from "@clankie/api-client";
import type { DiscordSetupApi } from "@clankie/api-client";
import { DiscordSetupClient } from "@clankie/api-client";
import { runDiscordSetup, showDiscordSetup } from "./discord-setup.ts";
import { formatDiscordRoomStatus } from "./discord-room-view.ts";
import { parseDiscordSettingValue } from "./command/discord.ts";
import {
  SettingsStore,
  discordSettingsToEnvironment,
  type DiscordSettings,
  type PersonaSettings,
} from "@clankie/settings";
import { personaStatus, personaUpdate } from "./command/persona.ts";
import type { RedactedCredential } from "@clankie/credential-broker";
import type { DiscordUserSessionOptIn } from "@clankie/protocol";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";
import { discordStatus, formatDiscordSettings } from "./command/discord.ts";
import { formatDiscordOfficial, runDiscordOfficialCommand } from "./command/discord-official.ts";

interface DiscordUserSessionOptInClient {
  inspectDiscordUserSessionOptIn(): Promise<DiscordUserSessionOptIn | undefined>;
  recordDiscordUserSessionOptIn(request: {
    schemaVersion: 1;
    characterId: string;
    acknowledgement: string;
    guildIds: string[];
    channelIds: string[];
    dmPolicy: "deny" | "owner_only" | "allowlist";
  }): Promise<DiscordUserSessionOptIn>;
  revokeDiscordUserSessionOptIn(): Promise<DiscordUserSessionOptIn | undefined>;
}

export interface DiscordCommandServices extends OwnerSettingsApiOptions {
  settings: SettingsStore;
  setup?: DiscordSetupApi;
  /** Hosted consoles expose raw fields through the host, never local credentials/settings. */
  localAdvanced?: boolean;
  rooms?: Pick<
    ClankieApiClient,
    "discordRooms" | "discordRoomGuidance" | "discordRoomVoice" | "controlDiscordRoomVoice"
  >;
  /** Redacted view of what the credential broker already holds. */
  listCredentials: () => Promise<Record<string, RedactedCredential>>;
  /** Removes a stored secret. */
  removeCredential: (providerId: string) => Promise<unknown>;
  /**
   * Stores a secret in the credential broker. Tokens never touch the settings
   * file: `/discord` is only a friendlier entry point to the same broker `/auth`
   * writes to, because `discord_bot` is not a featured provider and would
   * otherwise require typing the provider id by hand.
   */
  setCredential: (providerId: string, key: string) => Promise<void>;
  /** Operator API, when the console is authenticated to the clankie service. */
  userSessionOptIn?: DiscordUserSessionOptInClient;
  /**
   * The persona settings `/persona` owns, for the attention section. Defaults
   * to the owner settings API, the same path `clankie persona set` writes.
   */
  persona?: DiscordPersonaAccess;
}

type DiscordAttentionPersona = Pick<PersonaSettings, "chattiness" | "replyPolicy">;
interface DiscordPersonaAccess {
  read(): Promise<DiscordAttentionPersona>;
  update(patch: Partial<DiscordAttentionPersona>): Promise<unknown>;
}

/** Discord secrets, all broker-owned. Never stored in settings.json. */
const DISCORD_CREDENTIALS = [
  {
    id: "discord_bot",
    label: "Bot token",
    hint: "required",
    description: "Official application bot token from the Discord developer portal.",
  },
  {
    id: "discord_user_session",
    label: "User token (personal-lab only)",
    hint: "Go Live / user body",
    description:
      "Automating a normal account violates Discord's terms and risks the account. Lab profile only.",
  },
  {
    id: "openai",
    label: "OpenAI key",
    hint: "voice STT/TTS",
    description: "Reused by group voice for transcription and speech.",
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs key",
    hint: "external voice",
    description: "Speech synthesis when /voice selects the ElevenLabs provider (ADR 0070).",
  },
] as const;

/**
 * `/discord` is one place to set up Discord, writing to **two stores**.
 *
 * Tokens go to the credential broker, which redacts them and can use the OS
 * keychain — identical to `/auth`, just without making an operator type
 * `discord_bot` by hand into the "Other…" provider prompt.
 *
 * Everything else is a public identifier an operator wants to read back
 * plainly, so it goes to `settings.json`. No secret is ever written there, and
 * the settings write path rejects token-shaped values outright.
 */
export function buildDiscordCommands(services: DiscordCommandServices): FaceShellCommand[] {
  return [
    {
      name: "discord",
      aliases: [],
      description: "Connect a Discord server, choose Clankie’s role, fleet and project tracking",
      argumentHint: "[status|invite|rooms|guide|call]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const selector = argument.trim().toLowerCase();
        if (selector === "call") {
          if (!services.rooms) {
            shell.insertCommandResult("/discord call", "Operator authentication unavailable", "error");
            return;
          }
          const voice = await services.rooms.discordRoomVoice();
          shell.insertCommandResult(
            "/discord call",
            `${voice.state} · ${voice.activity} · speech output ${voice.state === "unknown" ? "unconfirmed" : voice.outputMuted ? "muted" : "audible"}\n${voice.consentedParticipantCount} consented participants · ${voice.activeCaptureCount} active captures · ${voice.handoffCount} captain handoffs\nSpeaking: ${voice.speakers === undefined ? "unknown" : voice.speakers.length === 0 ? "nobody observed" : voice.speakers.map((speaker) => stripVTControlCharacters(speaker.displayName ?? speaker.userId).replace(/[\r\n\t]/gu, " ")).join(", ")}\n${voice.conversationId ?? "Owner unknown"}\nOpt-in words: /voice transcripts. Music and Go Live audio use separate controls.`,
            "success",
          );
          const flow = shell.setupFlow;
          flow.begin("voice room");
          try {
            const action = await flow.readSelect({
              message: "Voice room",
              options:
                voice.state === "active"
                  ? [
                      { value: "mute_output", label: "Mute Clankie speech output" },
                      { value: "unmute_output", label: "Unmute Clankie speech output" },
                      { value: "leave", label: "Leave this call" },
                      { value: "done", label: "Done" },
                    ]
                  : [
                      { value: "join", label: "Join a known voice room" },
                      { value: "done", label: "Done" },
                    ],
            });
            if (!action || action === "done") return;
            let conversationId = voice.conversationId;
            if (action === "join") {
              const rooms = (await services.rooms.discordRooms()).rooms.filter(
                (room) => room.lane === "discord_voice",
              );
              conversationId = await flow.readSelect({
                message: "Exact voice room (owner must currently be there)",
                options: rooms.map((room) => ({
                  value: room.conversationId,
                  label: room.title ?? room.targetId ?? room.conversationId,
                })),
              });
            }
            if (!conversationId) return;
            const result = await services.rooms.controlDiscordRoomVoice({
              conversationId,
              action,
              ...(action === "join" ? {} : { stayId: voice.stayId }),
            });
            shell.insertCommandResult(
              "/discord call",
              `${result.state} · speech output ${result.state === "unknown" ? "unconfirmed" : result.outputMuted ? "muted" : "audible"}`,
              "success",
            );
          } finally {
            flow.end();
          }
          return;
        }
        if (selector === "rooms" || selector === "guide") {
          if (!services.rooms) {
            shell.insertCommandResult("/discord rooms", "Operator authentication unavailable", "error");
            return;
          }
          const snapshot = await services.rooms.discordRooms();
          if (selector === "rooms") {
            shell.insertCommandResult(
              "/discord rooms",
              snapshot.rooms.map(formatDiscordRoomStatus).join("\n\n") || "No observed rooms",
              "success",
            );
            return;
          }
          const flow = shell.setupFlow;
          flow.begin("discord guidance");
          try {
            const id = await flow.readSelect({
              message: "Room for private next-turn guidance",
              options: snapshot.rooms.map((room) => ({
                value: room.conversationId,
                label: room.conversationId,
                hint: room.guidance.state,
              })),
            });
            const room = snapshot.rooms.find((value) => value.conversationId === id);
            if (!room) return;
            const text = await flow.readText({
              message: "Private guidance — Clankie decides what to say. 'none' clears.",
              placeholder: room.guidance.text ?? "For the next admitted room turn",
            });
            if (text === undefined || !text.trim()) return;
            const result = await services.rooms.discordRoomGuidance({
              conversationId: room.conversationId,
              expectedRevision: room.guidance.revision,
              ...(text.trim() === "none" ? {} : { text }),
            });
            shell.insertCommandResult(
              "/discord guide",
              `Private guidance ${result.state}; nothing was posted in the room.`,
              "success",
            );
          } finally {
            flow.end();
          }
          return;
        }
        if (selector === "status") {
          if (!services.setup)
            throw new Error("Discord settings need an authenticated connection to Clankie.");
          await showDiscordSetup(shell, services.setup);
          return;
        }
        if (selector === "invite") {
          await showDiscordInvite(shell, services);
          return;
        }
        await runDiscordWizard(shell, services);
      },
    },
  ];
}

/** Compatibility export: normal member grants; Admin invitations request Administrator. */
export const DISCORD_BOT_INVITE_PERMISSIONS = Number(DISCORD_PARTICIPANT_INVITE_PERMISSIONS);

export function discordBotInviteUrl(
  applicationId: string,
  role: DiscordSettings["role"] = "participant",
  serverId?: string,
): string {
  return discordRoleInviteUrl(applicationId, role, serverId);
}

const DISCORD_BOT_PRIMER = [
  "1. Open https://discord.com/developers/applications and click New Application.",
  "2. Bot → Add Bot → Reset Token. Paste that token under Tokens.",
  "3. Privileged Gateway Intents: enable Message Content (required for text).",
  "4. Copy the Application ID from General Information, then /discord invite.",
  "5. Open the role-correct invite link, pick your server, then connect it under /discord and recheck setup.",
].join("\n");

const SNOWFLAKE = /^\d{5,32}$/u;

function validateSnowflake(optional: boolean) {
  return (value: string): string | undefined => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return optional ? undefined : "Required.";
    return SNOWFLAKE.test(trimmed)
      ? undefined
      : "Must be a numeric Discord id (enable Developer Mode to copy one).";
  };
}

function validateSnowflakeList(value: string): string | undefined {
  if (value.trim().toLowerCase() === "none") return undefined;
  const items = splitList(value);
  if (items.some((item) => !SNOWFLAKE.test(item))) return "Every entry must be a numeric Discord id.";
  return undefined;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Resolve a per-plane server allowlist.
 *
 * Clankie can live in many servers: the operating allowlists are arrays, and
 * only the command-registration guild is singular. Typed input wins; blank
 * keeps whatever was already configured; and a first-time blank falls back to
 * the command server so the common single-server setup stays one keystroke.
 */
export function resolveGuildList(
  typed: string,
  existing: readonly string[],
  commandGuildId: string | undefined,
): string[] {
  if (typed.trim().length > 0) return splitList(typed);
  if (existing.length > 0) return [...existing];
  return commandGuildId === undefined ? [] : [commandGuildId];
}

function guildListPlaceholder(existing: readonly string[], commandGuildId: string | undefined): string {
  if (existing.length > 0) return existing.join(",");
  return commandGuildId ?? "server id, or several separated by commas";
}

/**
 * Render a stored credential without ever revealing it. The broker redacts an
 * API key to its first four characters, which is enough to tell two tokens
 * apart when checking whether the right one is installed.
 */
export function describeRedactedCredential(redacted: RedactedCredential): string {
  if (redacted.type === "api") return `api key ${redacted.key}`;
  if (redacted.type === "oauth") {
    const account = redacted.accountId === undefined ? "" : ` (${redacted.accountId})`;
    return `oauth${account}`;
  }
  return "wellknown";
}

/** Typed input wins; blank keeps what was already configured; `none` clears it explicitly. */
export function resolveIdList(typed: string, existing: readonly string[]): string[] {
  const value = typed.trim();
  if (value.toLowerCase() === "none") return [];
  return value.length > 0 ? splitList(value) : [...existing];
}

/**
 * The **server** allowlist is what bounds a plane to servers the owner chose,
 * so enabling a plane without one is always a mistake and is caught here rather
 * than discovered later — voice refuses to start the bridge at all, while text
 * ingress would start fine and then silently ignore every message.
 *
 * The **channel** list is optional refinement below it on both planes: empty
 * admits every channel inside the allowlisted servers.
 */
export function describeEmptyAllowlist(
  plane: "voice" | "text ingress",
  guildIds: readonly string[],
  _channelIds: readonly string[],
): string | undefined {
  if (guildIds.length === 0) return `Cannot enable ${plane} with no server allowlisted.`;
  return undefined;
}

async function showDiscordStatus(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const result = await discordStatus({ settings: services.settings });
  const credentials = await services.listCredentials();
  const lines: string[] = [];

  lines.push(`settings file: ${result.settingsFile}`);
  lines.push("");
  lines.push("credentials (credential broker):");
  for (const credential of DISCORD_CREDENTIALS) {
    const redacted = credentials[credential.id];
    const state =
      redacted === undefined
        ? credential.id === "discord_bot"
          ? "MISSING — /discord → Tokens"
          : "not set"
        : describeRedactedCredential(redacted);
    lines.push(`  ${credential.id}: ${state}`);
  }
  lines.push("");
  lines.push(...formatDiscordSettings(result.effectiveDiscord));

  if (result.overriddenByEnvironment.length > 0) {
    lines.push("");
    lines.push("environment overrides in effect (these win over stored values):");
    for (const name of result.overriddenByEnvironment) lines.push(`  ${name}`);
  }

  shell.insertCommandResult("/discord status", lines.join("\n"), "success");
}

export async function runDiscordWizard(
  shell: ClankieFaceShell,
  services: DiscordCommandServices,
): Promise<void> {
  if (!services.setup) throw new Error("Discord settings need an authenticated connection to Clankie.");
  const setup = services.setup;
  let personaRevision: string | undefined;
  const persona =
    services.persona ??
    (services.localAdvanced === false
      ? undefined
      : {
          read: async () => {
            const current = await personaStatus(services);
            personaRevision = current.revision;
            return current.persona;
          },
          update: (patch: Partial<DiscordAttentionPersona>) => {
            if (personaRevision === undefined) throw new Error("Read persona settings before changing them");
            return personaUpdate(patch, { ...services, expectedRevision: personaRevision });
          },
        });
  await runDiscordSetup(
    shell,
    setup,
    () =>
      services.localAdvanced === false
        ? editAllDiscordSettings(shell, services)
        : runDiscordAdvancedWizard(shell, services),
    () => editDiscordAttention(shell, setup, persona),
    {
      owners: () => editServerOwners(shell, { ...services, setup }),
      roomSkill: () => editRoomSkill(shell, { ...services, setup }),
    },
  );
}

const A = DISCORD_ATTENTION;

/**
 * One place for what reaches him in Discord text and how readily he joins in.
 * The wake trigger is a Discord setting saved through the settings API;
 * chattiness and reply policy stay persona-owned and are saved through the
 * persona path, so `/persona` and `clankie persona set` see the same values.
 * None of these limits how long he talks: that is always his own choice.
 * Wording comes from `@clankie/protocol` so the app and dashboard match.
 */
async function editDiscordAttention(
  shell: ClankieFaceShell,
  setup: DiscordSetupApi,
  persona: DiscordPersonaAccess | undefined,
): Promise<void> {
  const flow = shell.setupFlow;
  for (;;) {
    const snapshot = await setup.discordSettings();
    const trigger = discordWakeTrigger(snapshot.settings.wakeTrigger);
    const current = persona ? await persona.read() : undefined;
    const choice = await flow.readSelect({
      message: `${A.title}\n${A.summary}`,
      allowBack: true,
      options: [
        {
          value: "wake",
          label: A.wake.label,
          hint: A.wake.choices[trigger ?? "default"].label,
          description: A.wake.description,
        },
        ...(current
          ? [
              {
                value: "chattiness",
                label: A.chattiness.label,
                hint: A.chattiness.choices[current.chattiness].label,
                description: A.chattiness.description,
              },
              {
                value: "reply",
                label: A.replyPolicy.label,
                hint: A.replyPolicy.choices[current.replyPolicy].label,
                description: A.replyPolicy.description,
              },
            ]
          : []),
        { value: "done", label: "Done" },
      ],
    });
    if (choice === undefined || choice === "done") return;
    if (choice === "wake") {
      const value = await flow.readSelect({
        message: A.wake.label,
        allowBack: true,
        currentValue: trigger ?? "default",
        options: (["mention", "name", "any", "default"] as const).map((key) => ({
          value: key,
          label: A.wake.choices[key].label,
          description: A.wake.choices[key].description,
        })),
      });
      if (value === undefined) continue;
      await setup.updateDiscordSettings({
        expectedRevision: snapshot.revision,
        settings: discordServerSettings(
          DiscordSettingsSchema.parse({
            ...snapshot.settings,
            wakeTrigger: value === "default" ? undefined : value,
          }),
          snapshot.settings,
        ),
      });
      flow.renderLine(A.saved, "success");
      continue;
    }
    if (!persona || !current) continue;
    if (choice === "chattiness") {
      const value = await flow.readSelect({
        message: `${A.chattiness.label} when nobody is talking to him\nOnce addressed he answers normally; how long he talks is always his call.`,
        allowBack: true,
        currentValue: current.chattiness,
        options: (["quiet", "balanced", "chatty"] as const).map((key) => ({
          value: key,
          label: A.chattiness.choices[key].label,
          description: A.chattiness.choices[key].description,
        })),
      });
      if (value === undefined) continue;
      await persona.update({ chattiness: value as PersonaSettings["chattiness"] });
      flow.renderLine(A.saved, "success");
      continue;
    }
    const value = await flow.readSelect({
      message: `${A.replyPolicy.label}: what he reads in voice, and in text while the wake trigger is the default`,
      allowBack: true,
      currentValue: current.replyPolicy,
      options: (["all", "addressed"] as const).map((key) => ({
        value: key,
        label: A.replyPolicy.choices[key].label,
        description: A.replyPolicy.choices[key].description,
      })),
    });
    if (value === undefined) continue;
    await persona.update({ replyPolicy: value as PersonaSettings["replyPolicy"] });
    flow.renderLine(A.saved, "success");
  }
}

export async function runDiscordAdvancedWizard(
  shell: ClankieFaceShell,
  services: DiscordCommandServices,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("discord");
  try {
    for (;;) {
      const settings = (await discordSnapshot(services)).settings;
      const action = await flow.readSelect({
        message: "Advanced Discord settings",
        options: [
          {
            value: "official",
            label: "Official Clankie bot (free)",
            hint: settings.officialBotEnabled ? "on" : "off",
            description:
              "Add the official bot from your Clankie account page: no developer portal, bot token or intents. Needs clankie login.",
          },
          {
            value: "primer",
            label: "How to create the bot (advanced)",
            hint: "Discord developer portal",
            description: "Any user can do this: create an application, copy the token, invite him.",
          },
          {
            value: "invite",
            label: "Invite link",
            hint: "needs an application id",
          },
          {
            value: "credentials",
            label: "Tokens",
            hint: "stored in the credential broker",
            description: "Bot token, optional user token, and the OpenAI key used by voice.",
          },
          {
            value: "core",
            label: "Server, application, and roles",
            hint: "required",
            description: "Application id, guild id, and the roles granted the ambient command tier.",
          },
          {
            value: "system",
            label: "Server owners",
            hint: "Just me / Everyone / Discord role",
            description:
              "Choose who owns Clankie in each server. Admin manages Discord; it never grants machine access to other members.",
          },
          {
            value: "room-skill",
            label: "This room can use",
            hint: "House hunting",
            description: "Grant household tools without granting the machine.",
          },
          {
            value: "ingress",
            label: "Text chat",
            hint: "channels Clankie reads",
            description: "Enable bounded text ingress and set the deny-by-default guild/channel allowlists.",
          },
          { value: "voice", label: "Voice", hint: "group voice allowlists" },
          {
            value: "active",
            label: "Active body",
            hint: settings.activeBody === "user_session" ? "lab user" : "official bot",
            description: "One mouth. The launcher starts only this process. Switch and `clankie restart`.",
          },
          {
            value: "lab",
            label: "Lab user body",
            hint: "user token, watch, Go Live",
            description:
              "Optional normal-account body. Make it active to talk, watch shares, and Go Live. The bot stays down while it is.",
          },
          {
            value: "activity",
            label: "Activity plane",
            hint: "Fire Red surface",
            description: "Embedded application id used to launch a rendered surface in a voice channel.",
          },
          { value: "export", label: "Show as environment variables" },
          { value: "all", label: "All Discord settings", hint: "Every field, including advanced settings" },
          { value: "status", label: "Show status" },
          { value: "done", label: "Done" },
        ],
      });
      const choice = action;
      if (choice === undefined || choice === "done") break;
      if (choice === "status") {
        await showDiscordStatus(shell, services);
        continue;
      }
      if (choice === "official") {
        await editOfficialBot(shell);
        continue;
      }
      if (choice === "primer") {
        shell.insertCommandResult("/discord", DISCORD_BOT_PRIMER, "success");
        continue;
      }
      if (choice === "invite") {
        await showDiscordInvite(shell, services);
        continue;
      }
      if (choice === "export") {
        await showEnvironmentExport(shell, services);
        continue;
      }
      if (choice === "all") await editAllDiscordSettings(shell, services);
      else if (choice === "credentials") await editCredentials(shell, services);
      else if (choice === "core") await editCore(shell, services);
      else if (choice === "system") await editServerOwners(shell, services);
      else if (choice === "room-skill") await editRoomSkill(shell, services);
      else if (choice === "ingress") await editIngress(shell, services);
      else if (choice === "voice") await editVoice(shell, services);
      else if (choice === "active") await editActiveBody(shell, services);
      else if (choice === "lab") await editLabBody(shell, services);
      else if (choice === "activity") await editActivity(shell, services);
    }
  } finally {
    // Leave the shell usable even if a step throws.
    flow.end();
  }
}

/** The free official bot through the Clankie account (VUH-1766); same API as `clankie discord official`. */
async function editOfficialBot(shell: ClankieFaceShell): Promise<void> {
  const show = async (args: string[]) => {
    try {
      const result = await runDiscordOfficialCommand(args);
      shell.insertCommandResult("/discord", formatDiscordOfficial(result).join("\n"), "success");
      return result;
    } catch (error) {
      shell.insertCommandResult("/discord", error instanceof Error ? error.message : String(error), "error");
      return undefined;
    }
  };
  const current = await show(["status"]);
  if (current === undefined) return;
  const choice = await shell.setupFlow.readSelect({
    message: "Official Clankie bot",
    options: current.enabled
      ? [
          { value: "keep", label: "Keep it on" },
          { value: "off", label: "Turn it off", hint: "removes the server connection" },
        ]
      : [
          { value: "on", label: "Turn it on", hint: "then Add to Discord" },
          { value: "keep", label: "Leave it off" },
        ],
    allowBack: true,
  });
  if (choice === "on" || choice === "off") await show([choice]);
}

type Patch = (current: DiscordSettings) => DiscordSettings;

async function discordSnapshot(services: DiscordCommandServices): Promise<DiscordSettingsSnapshot> {
  if (services.setup) return services.setup.discordSettings();
  return (await ownerSettingsApi(services)).get(DISCORD_SETTINGS_PATH, DiscordSettingsSnapshotSchema);
}

async function apply(
  services: DiscordCommandServices,
  snapshot: DiscordSettingsSnapshot,
  patch: Patch,
): Promise<void> {
  const request = {
    expectedRevision: snapshot.revision,
    settings: discordServerSettings(DiscordSettingsSchema.parse(patch(snapshot.settings)), snapshot.settings),
  };
  if (services.setup) await services.setup.updateDiscordSettings(request);
  else
    await (
      await ownerSettingsApi(services)
    ).write(DISCORD_SETTINGS_PATH, request, DiscordSettingsSnapshotSchema);
}

async function editCredentials(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const stored = await services.listCredentials();
  const picked = await flow.readSelect({
    message: "Which token?",
    options: DISCORD_CREDENTIALS.map((credential) => ({
      value: credential.id,
      label: credential.label,
      hint: credential.id in stored ? "configured" : credential.hint,
      description: credential.description,
    })),
    allowBack: true,
  });
  const providerId = picked;
  if (providerId === undefined) return;

  // Show what is already there before offering to overwrite it. Re-prompting
  // blindly invites an accidental clobber of a working credential, and gives an
  // operator no way to answer "is the token even set?" without replacing it.
  const existing = stored[providerId];
  if (existing !== undefined) {
    const decision = await flow.readSelect({
      message: `${providerId} is already stored — ${describeRedactedCredential(existing)}`,
      options: [
        { value: "keep", label: "Keep it", hint: "no change" },
        { value: "replace", label: "Replace it", hint: "enter a new token" },
        { value: "remove", label: "Remove it", hint: "delete from the broker" },
      ],
      allowBack: true,
    });
    const choice = decision;
    if (choice === undefined || choice === "keep") return;
    if (choice === "remove") {
      await services.removeCredential(providerId);
      flow.renderLine(`Removed ${providerId} from the credential broker.`, "success");
      return;
    }
  }

  // readSecret keeps the value off the rendered transcript; the broker redacts
  // it thereafter. It is never written to settings.json.
  const key = await flow.readSecret({
    message: `Token for ${providerId}`,
    validate: (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "Required.";
      if (/\s/u.test(trimmed)) return "A token contains no whitespace — check for a stray paste.";
      return undefined;
    },
  });
  if (key === undefined) return;

  await services.setCredential(providerId, key.trim());
  flow.renderLine(`Stored ${providerId} in the credential broker (redacted).`, "success");
  if (providerId === "discord_user_session") {
    flow.renderLine(
      "Reminder: the user-session body is personal-lab only and denied by the high-assurance and team profiles.",
      "warning",
    );
  }
}

async function editCore(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const snapshot = await discordSnapshot(services);
  const current = snapshot.settings;

  const applicationId = await flow.readText({
    message: "Application id",
    placeholder: current.applicationId ?? "numeric id from the Discord developer portal",
    validate: validateSnowflake(true),
  });
  if (applicationId === undefined) return;

  // Singular by design: this is only where slash commands register. Left blank
  // they register globally, i.e. in every server the bot is installed in.
  // Where Clankie may *operate* is the separate per-plane allowlist below.
  const guildId = await flow.readText({
    message: "Command-registration server id — blank registers commands globally",
    placeholder: current.guildId ?? "blank = all servers the bot is in",
    validate: validateSnowflake(true),
  });
  if (guildId === undefined) return;

  // The one server he controls, and the only one agent channels may be
  // projected into (ADR 0146). Never inferred from the servers he inhabits.
  const swarmGuildId = await flow.readText({
    message:
      "Managed server server id — where agent channels may get Discord rooms. Blank keeps, `none` clears.",
    placeholder: current.swarmGuildId ?? "blank = no server he may make rooms in",
    validate: (value) => (value.trim().toLowerCase() === "none" ? undefined : validateSnowflake(true)(value)),
  });
  if (swarmGuildId === undefined) return;
  const swarmHome = swarmGuildId.trim();

  const ambient = await flow.readText({
    message: "Ambient role ids (comma separated) — the ambient command tier",
    placeholder: current.ambientRoleIds.join(",") || "role id",
    validate: validateSnowflakeList,
  });
  if (ambient === undefined) return;

  // Naming a user directly is the honest way to express "only me": a
  // single-operator deployment has nobody to hand a role to, and inventing one
  // drifts the moment the role is edited in the Discord UI.
  const ambientUsers = await flow.readText({
    message: "Ambient user ids (comma separated) — individuals with the same authority, no role needed",
    placeholder: current.ambientUserIds.join(",") || "your Discord user id",
    validate: validateSnowflakeList,
  });
  if (ambientUsers === undefined) return;

  await apply(services, snapshot, ({ swarmGuildId: currentSwarmHome, ...discord }) => {
    const nextSwarmHome =
      swarmHome.toLowerCase() === "none" ? undefined : swarmHome ? swarmHome : currentSwarmHome;
    return {
      ...discord,
      ...(applicationId.trim() ? { applicationId: applicationId.trim() } : {}),
      ...(guildId.trim() ? { guildId: guildId.trim() } : {}),
      ...(nextSwarmHome === undefined ? {} : { swarmGuildId: nextSwarmHome }),
      ...(ambient.trim() ? { ambientRoleIds: splitList(ambient) } : {}),
      ...(ambientUsers.trim() ? { ambientUserIds: splitList(ambientUsers) } : {}),
    };
  });
  flow.renderLine("Saved server, application, and roles.", "success");
}

async function editServerOwners(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const snapshot = await discordSnapshot(services);
  const directory = await (services.setup
    ? new DiscordSetupClient(services.setup).directory({ kind: "servers" })
    : undefined);
  const options =
    directory?.entries.map((entry) => ({
      value: entry.id,
      label: stripVTControlCharacters(entry.name).replace(/[\r\n\t]/gu, " "),
    })) ?? snapshot.settings.servers.map((entry) => ({ value: entry.serverId, label: entry.serverId }));
  const serverId = await shell.setupFlow.readSelect({ message: "Server", options, allowBack: true });
  if (!serverId) return;
  const previous = snapshot.settings.servers.find((entry) => entry.serverId === serverId);
  const role = await shell.setupFlow.readSelect({
    message: "Clankie's role",
    options: [
      { value: "participant", label: "Participant" },
      { value: "admin", label: "Admin · dedicated server" },
    ],
    allowBack: true,
  });
  if (!role) return;
  const owners = await shell.setupFlow.readSelect({
    message: "Owners here",
    options: [
      { value: "me", label: "Just me" },
      { value: "everyone", label: "Everyone", hint: "Everyone gets machine access" },
      { value: "role", label: "A Discord role" },
    ],
    allowBack: true,
  });
  if (!owners) return;
  let ownerRoleId: string | undefined;
  if (owners === "role") {
    const roles = await (services.setup
      ? new DiscordSetupClient(services.setup).directory({ kind: "roles", guildId: serverId })
      : undefined);
    ownerRoleId = await shell.setupFlow.readSelect({
      message: "Owner role",
      options:
        roles?.entries.map((entry) => ({
          value: entry.id,
          label: stripVTControlCharacters(entry.name).replace(/[\r\n\t]/gu, " "),
        })) ?? [],
      allowBack: true,
    });
    if (!ownerRoleId) return;
  }
  await apply(services, snapshot, (current) => ({
    ...current,
    ...(serverId === current.serverId ? { role: role as "participant" | "admin" } : {}),
    servers: [
      ...current.servers.filter((entry) => entry.serverId !== serverId),
      {
        ...previous,
        serverId,
        role: role as "participant" | "admin",
        owners: owners as "me" | "everyone" | "role",
        ownerRoleId,
      },
    ],
  }));
  shell.setupFlow.renderLine("Saved server owners and role.", "success");
}

async function editRoomSkill(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const snapshot = await discordSnapshot(services);
  const servers = await (services.setup
    ? new DiscordSetupClient(services.setup).directory({ kind: "servers" })
    : undefined);
  const serverId = await shell.setupFlow.readSelect({
    message: "Server",
    options:
      servers?.entries.map((entry) => ({
        value: entry.id,
        label: stripVTControlCharacters(entry.name).replace(/[\r\n\t]/gu, " "),
      })) ?? [],
    allowBack: true,
  });
  if (!serverId) return;
  const rooms = await (services.setup
    ? new DiscordSetupClient(services.setup).directory({ kind: "channels", guildId: serverId })
    : undefined);
  const channelId = await shell.setupFlow.readSelect({
    message: "Room",
    options:
      rooms?.entries.map((entry) => ({
        value: entry.id,
        label: stripVTControlCharacters(entry.name).replace(/[\r\n\t]/gu, " "),
      })) ?? [],
    allowBack: true,
  });
  if (!channelId) return;
  const skill = await shell.setupFlow.readSelect({
    message: "This room can use",
    options: [
      { value: "house-hunting", label: "House hunting" },
      { value: "off", label: "No additional skill" },
    ],
    allowBack: true,
  });
  if (!skill) return;
  await apply(services, snapshot, (current) => ({
    ...current,
    roomSkills: [
      ...current.roomSkills.filter((entry) => entry.serverId !== serverId || entry.channelId !== channelId),
      ...(skill === "off"
        ? []
        : [
            {
              serverId,
              channelId,
              skill: "house-hunting" as const,
              ...(current.roomSkills.find(
                (entry) => entry.serverId === serverId && entry.channelId === channelId,
              )?.household === "existing"
                ? { household: "existing" as const }
                : {}),
            },
          ]),
    ],
  }));
  shell.setupFlow.renderLine("Saved this room's skill.", "success");
}

async function editIngress(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const snapshot = await discordSnapshot(services);
  const current = snapshot.settings;

  const enabled = await flow.readSelect({
    message: "Text ingress (requires Message Content Intent in the Discord portal)",
    options: [
      { value: "true", label: "Enabled", hint: "Clankie reads allowlisted channels" },
      { value: "false", label: "Disabled" },
    ],
  });
  const enabledChoice = enabled;
  if (enabledChoice === undefined) return;

  const guilds = await flow.readText({
    message: "Server ids Clankie may read in (comma separated) — blank uses the command server",
    placeholder: guildListPlaceholder(current.ingressGuildIds, current.guildId),
    validate: validateSnowflakeList,
  });
  if (guilds === undefined) return;

  const channels = await flow.readText({
    message: "Channel ids Clankie may read (comma separated) — blank admits every channel in those servers",
    placeholder: current.ingressChannelIds.join(",") || "blank = all channels",
    validate: validateSnowflakeList,
  });
  if (channels === undefined) return;

  const dmPolicy = await flow.readSelect({
    message: "Direct messages",
    options: [
      { value: "deny", label: "Deny all DMs" },
      { value: "owner_only", label: "Owner only", hint: "needs your user id" },
      { value: "allowlist", label: "Explicit allowlist" },
    ],
  });
  const policy = dmPolicy;
  if (policy === undefined) return;

  let ownerUserId = current.ownerUserId;
  if (policy === "owner_only") {
    const owner = await flow.readText({
      message: "Your Discord user id",
      placeholder: current.ownerUserId ?? "right-click yourself with Developer Mode on",
      validate: validateSnowflake(true),
    });
    if (owner === undefined) return;
    if (owner.trim()) ownerUserId = owner.trim();
  }

  const guildIds = resolveGuildList(guilds, current.ingressGuildIds, current.guildId);
  const channelIds = resolveIdList(channels, current.ingressChannelIds);
  if (enabledChoice === "true") {
    const problem = describeEmptyAllowlist("text ingress", guildIds, channelIds);
    if (problem !== undefined) {
      flow.renderLine(problem, "error");
      return;
    }
  }
  await apply(services, snapshot, (discord) => ({
    ...discord,
    textIngressEnabled: enabledChoice === "true",
    ...(channels.trim() ? { ingressChannelIds: splitList(channels) } : {}),
    ingressDmPolicy: policy as DiscordSettings["ingressDmPolicy"],
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
    // Readiness requires the ingress and presence allowlists to line up, so the
    // wizard mirrors them rather than letting an operator half-configure it.
    ...(guildIds.length === 0 ? {} : { ingressGuildIds: guildIds, presenceGuildIds: guildIds }),
    ...(channels.trim() ? { presenceChannelIds: splitList(channels) } : {}),
  }));
  flow.renderLine(
    `Saved text ingress across ${String(guildIds.length)} server${guildIds.length === 1 ? "" : "s"}` +
      (channelIds.length === 0 ? ", admitting every channel in them" : "") +
      ", and mirrored the presence allowlist to match.",
    "success",
  );
}

async function editVoice(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const snapshot = await discordSnapshot(services);
  const current = snapshot.settings;

  const enabled = await flow.readSelect({
    message: "Group voice",
    options: [
      { value: "true", label: "Enabled" },
      { value: "false", label: "Disabled" },
    ],
  });
  const enabledChoice = enabled;
  if (enabledChoice === undefined) return;

  const guilds = await flow.readText({
    message: "Server ids for voice (comma separated) — blank uses the command server",
    placeholder: guildListPlaceholder(current.voiceGuildIds, current.guildId),
    validate: validateSnowflakeList,
  });
  if (guilds === undefined) return;

  const channels = await flow.readText({
    message: "Voice channel ids (comma separated) — blank admits every voice channel in those servers",
    placeholder: current.voiceChannelIds.join(",") || "blank = all voice channels",
    validate: validateSnowflakeList,
  });
  if (channels === undefined) return;

  // Joining a call and steering him elsewhere have very different blast radii,
  // so they get separate bindings rather than one shared allowlist.
  const joinPolicy = await flow.readSelect({
    message: "Who may summon Clankie into a call?",
    options: [
      {
        value: "ambient",
        label: "Ambient tier only",
        hint: "same people who hold ambient commands",
        description: "Voice stays behind the ambient role and user bindings.",
      },
      {
        value: "guild_members",
        label: "Anyone in the allowlisted servers",
        hint: "voice only",
        description:
          "Any member may start or end a call. Ambient commands and person memory stay on the ambient tier.",
      },
    ],
  });
  const joinPolicyChoice = joinPolicy;
  if (joinPolicyChoice === undefined) return;

  const consentPolicy = await flow.readSelect({
    message: "Who may Clankie hear in a call?",
    options: [
      {
        value: "explicit",
        label: "Each person opts in each call",
        hint: "default",
        description: "Session-bound. Restart, leave, or rejoin clears consent.",
      },
      {
        value: "presence",
        label: "Anyone in the call",
        hint: "one-time switch",
        description:
          "Being in his active voice channel is consent. Opt-out still binds for that call. Best for a private server.",
      },
    ],
  });
  const consentPolicyChoice = consentPolicy;
  if (consentPolicyChoice === undefined) return;

  const transcriptLogging = await flow.readSelect({
    message: "Keep full voice transcripts for development?",
    options: [
      {
        value: "false",
        label: "Disabled",
        hint: "default",
        description: "Keep only content-free voice receipts.",
      },
      {
        value: "true",
        label: "Enabled",
        hint: "private local JSONL",
        description: "Retain consented speech and Clankie’s reply text with playback outcomes for debugging.",
      },
    ],
  });
  const transcriptLoggingChoice = transcriptLogging;
  if (transcriptLoggingChoice === undefined) return;

  const guildIds = resolveGuildList(guilds, current.voiceGuildIds, current.guildId);
  const channelIds = resolveIdList(channels, current.voiceChannelIds);
  if (enabledChoice === "true") {
    const problem = describeEmptyAllowlist("voice", guildIds, channelIds);
    if (problem !== undefined) {
      flow.renderLine(problem, "error");
      return;
    }
  }
  await apply(services, snapshot, (discord) => ({
    ...discord,
    voiceEnabled: enabledChoice === "true",
    voiceJoinPolicy: joinPolicyChoice as DiscordSettings["voiceJoinPolicy"],
    voiceConsentPolicy: consentPolicyChoice as DiscordSettings["voiceConsentPolicy"],
    voiceTranscriptLoggingEnabled: transcriptLoggingChoice === "true",
    ...(channels.trim()
      ? { voiceChannelIds: splitList(channels), voiceChannelId: splitList(channels)[0] }
      : {}),
    ...(guildIds.length === 0 ? {} : { voiceGuildIds: guildIds }),
  }));
  flow.renderLine(
    `Saved voice across ${String(guildIds.length)} server${guildIds.length === 1 ? "" : "s"}` +
      (channelIds.length === 0 ? ", admitting every voice channel in them." : ".") +
      (joinPolicyChoice === "guild_members"
        ? " Any member of those servers may start a call; ambient authority is unchanged."
        : "") +
      (consentPolicyChoice === "presence"
        ? " Anyone in his active voice channel can talk; opt-out still binds for that call."
        : " Each person still opts in per call.") +
      (transcriptLoggingChoice === "true"
        ? " Full consented transcripts will be retained in the private development log."
        : " Full transcript logging is off."),
    "success",
  );
}

const LAB_ACKNOWLEDGEMENT = "I accept Discord ToS and account risk for this personal-lab user-session body.";

async function editActiveBody(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const snapshot = await discordSnapshot(services);
  const current = snapshot.settings;
  const credentials = await services.listCredentials();
  const picked = await flow.readSelect({
    message: "Which Discord body is the mouth? Only one process is live.",
    options: [
      {
        value: "bot",
        label: "Official bot",
        hint: current.activeBody === "bot" ? "active" : "",
        description: "Slash commands, embedded activities, group voice. Cannot watch or Go Live.",
      },
      {
        value: "user_session",
        label: "Lab user body",
        hint: current.activeBody === "user_session" ? "active" : "",
        description: "Talk, watch shares, Go Live. No slash commands. Requires the lab body setup.",
      },
    ],
  });
  const choice = picked;
  if (choice !== "bot" && choice !== "user_session") return;

  if (choice === "user_session") {
    if (!current.userSessionEnabled) {
      flow.renderLine("Enable Lab user body first (token, allowlists, ToS opt-in).", "error");
      return;
    }
    if (credentials.discord_user_session === undefined) {
      flow.renderLine("Store a user token under Tokens before making the lab body active.", "error");
      return;
    }
  }

  await apply(services, snapshot, (discord) => ({ ...discord, activeBody: choice }));
  flow.renderLine(
    choice === "user_session"
      ? "Lab user body is the mouth. Run `clankie restart` so the official bot stays down."
      : "Official bot is the mouth. Run `clankie restart` so the lab body stays down.",
    "success",
  );
}

async function editLabBody(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const snapshot = await discordSnapshot(services);
  const current = snapshot.settings;

  const enabled = await flow.readSelect({
    message:
      "Lab user body — a normal Discord account. Make it the Active body to talk; the official bot stays down while it is.",
    options: [
      {
        value: "true",
        label: "Enabled",
        hint: "watch screen shares",
        description: "Requires a stored user token, allowlists, and a durable ToS opt-in.",
      },
      { value: "false", label: "Disabled", hint: "bot only" },
    ],
  });
  const enabledChoice = enabled;
  if (enabledChoice === undefined) return;

  const guilds = await flow.readText({
    message: "Server ids the lab body may enter (comma separated) — blank uses the command server",
    placeholder: guildListPlaceholder(current.userSessionGuildIds, current.guildId),
    validate: validateSnowflakeList,
  });
  if (guilds === undefined) return;

  const channels = await flow.readText({
    message: "Channel ids the lab body may enter (comma separated) — include the voice channel you share in",
    placeholder: current.userSessionChannelIds.join(",") || "channel id",
    validate: validateSnowflakeList,
  });
  if (channels === undefined) return;

  const voiceChannels = await flow.readText({
    message: "Voice channel ids to watch shares in (comma separated) — blank uses the list above",
    placeholder: current.userSessionVoiceChannelIds.join(",") || "voice channel id",
    validate: validateSnowflakeList,
  });
  if (voiceChannels === undefined) return;

  const guildIds = resolveGuildList(guilds, current.userSessionGuildIds, current.guildId);
  const textChannelIds = resolveIdList(channels, current.userSessionChannelIds);
  const voiceChannelIds = resolveIdList(voiceChannels, current.userSessionVoiceChannelIds);
  const channelIds = [...new Set([...textChannelIds, ...voiceChannelIds])];
  if (enabledChoice === "true") {
    if (guildIds.length === 0 || channelIds.length === 0) {
      flow.renderLine("Cannot enable the lab body without both a server and a channel allowlist.", "error");
      return;
    }
  }

  await apply(services, snapshot, (discord) => ({
    ...discord,
    userSessionEnabled: enabledChoice === "true",
    ...(guildIds.length === 0 ? {} : { userSessionGuildIds: guildIds }),
    ...(channelIds.length === 0 ? {} : { userSessionChannelIds: channelIds }),
    ...(voiceChannelIds.length === 0 ? {} : { userSessionVoiceChannelIds: voiceChannelIds }),
  }));

  if (enabledChoice !== "true") {
    if (services.userSessionOptIn !== undefined) {
      try {
        await services.userSessionOptIn.revokeDiscordUserSessionOptIn();
      } catch {
        // Nothing active is fine — disable is the intent.
      }
    }
    flow.renderLine(
      "Lab user body disabled. Restart with `clankie restart` so the process stays down.",
      "success",
    );
    return;
  }

  const credentials = await services.listCredentials();
  if (credentials.discord_user_session === undefined) {
    flow.renderLine("Store a user token under Tokens before the lab body can connect.", "warning");
  }

  if (services.userSessionOptIn === undefined) {
    flow.renderLine(
      "Saved allowlists. Record the ToS opt-in once the clankie service is up (`clankie restart`), then rerun this step.",
      "warning",
    );
    return;
  }

  const accept = await flow.readSelect({
    message: LAB_ACKNOWLEDGEMENT,
    options: [
      { value: "accept", label: "I accept", hint: "records a durable opt-in" },
      { value: "skip", label: "Skip for now" },
    ],
  });
  if (accept !== "accept") {
    flow.renderLine("Saved. The lab body will not connect until you record the opt-in.", "warning");
    return;
  }

  try {
    await services.userSessionOptIn.recordDiscordUserSessionOptIn({
      schemaVersion: 1,
      characterId: "clankie",
      acknowledgement: LAB_ACKNOWLEDGEMENT,
      guildIds,
      channelIds,
      dmPolicy: current.userSessionDmPolicy,
    });
    flow.renderLine(
      "Lab user body enabled and opted in. Run `pnpm --filter @clankie/vox build`, then `clankie restart`. Include the voice channel you share in.",
      "success",
    );
  } catch (error) {
    flow.renderLine(
      `Saved allowlists, but the opt-in failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function editActivity(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const snapshot = await discordSnapshot(services);
  const current = snapshot.settings;
  const applicationId = await flow.readText({
    message: "Embedded application id for the Fire Red surface",
    placeholder: current.activityApplicationIdGba ?? "usually the same application id",
    validate: validateSnowflake(true),
  });
  if (applicationId === undefined) return;
  await apply(services, snapshot, (discord) => ({
    ...discord,
    ...(applicationId.trim() ? { activityApplicationIdGba: applicationId.trim() } : {}),
  }));
  flow.renderLine(
    "Saved. An unverified activity is launchable only by app-team testers in servers under 25 members.",
    "success",
  );
}

export async function showDiscordInvite(
  shell: ClankieFaceShell,
  services: DiscordCommandServices,
): Promise<void> {
  const settings = (await discordSnapshot(services)).settings;
  const applicationId = settings.applicationId;
  if (applicationId === undefined) {
    shell.insertCommandResult(
      "/discord invite",
      `No application id stored yet.\n\n${DISCORD_BOT_PRIMER}`,
      "error",
    );
    return;
  }
  shell.insertCommandResult(
    "/discord invite",
    [
      "Open this as the Discord user who can add bots to the server:",
      discordBotInviteUrl(applicationId, settings.role, settings.serverId),
      "",
      "Then connect the server under /discord and recheck setup. Message Content is a portal intent, not this link.",
    ].join("\n"),
    "success",
  );
}

async function showEnvironmentExport(
  shell: ClankieFaceShell,
  services: DiscordCommandServices,
): Promise<void> {
  const stored = await discordSnapshot(services);
  const env = discordSettingsToEnvironment(stored.settings);
  const lines = Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`);
  shell.insertCommandResult(
    "/discord",
    lines.length === 0
      ? "Nothing configured yet."
      : ["Equivalent environment (for CI or a container):", "", ...lines].join("\n"),
    "success",
  );
}

export const DISCORD_EDITABLE_FIELDS = DISCORD_SETTING_GROUPS.flatMap((group) =>
  group.fields.map((field) => field.key),
);
async function editAllDiscordSettings(
  shell: ClankieFaceShell,
  services: DiscordCommandServices,
): Promise<void> {
  const snapshot = await discordSnapshot(services);
  const current = snapshot.settings;
  const fields =
    snapshot?.setup?.definition.advancedGroups.flatMap((group) => group.fields) ??
    DISCORD_SETTING_GROUPS.flatMap((group) => group.fields);
  const field = await shell.setupFlow.readSelect({
    message: "Discord setting",
    options: fields.map((entry) => ({
      value: entry.key,
      label: entry.label,
      hint: ["servers", "roomSkills", "houseHuntingAuthorBindings"].includes(entry.key)
        ? JSON.stringify(current[entry.key])
        : String(current[entry.key] ?? "unset"),
    })),
  });
  if (field === undefined) return;
  const key = field as keyof DiscordSettings;
  const raw = await shell.setupFlow.readText({
    message: `${key} — ${["servers", "roomSkills", "houseHuntingAuthorBindings"].includes(key) ? "JSON array" : "lists use commas"}; 'none' clears; blank keeps`,
    placeholder: ["servers", "roomSkills", "houseHuntingAuthorBindings"].includes(key)
      ? JSON.stringify(current[key])
      : String(current[key] ?? "unset"),
    validate: (value) => {
      if (!value.trim()) return undefined;
      try {
        DiscordSettingsSchema.shape[key].parse(
          value.trim() === "none" ? undefined : parseDiscordSettingValue(key, value, current),
        );
        return undefined;
      } catch {
        return "Invalid value for this setting";
      }
    },
  });
  if (raw === undefined || !raw.trim()) return;
  const transform = (value: DiscordSettings) =>
    discordServerSettings(
      DiscordSettingsSchema.parse({
        ...value,
        [key]: raw.trim() === "none" ? undefined : parseDiscordSettingValue(key, raw, value),
      }),
      value,
    );
  if (key === "houseHuntingAuthorBindings") {
    const next = transform(current);
    for (const binding of next.houseHuntingAuthorBindings) {
      if (
        current.houseHuntingAuthorBindings.some(
          (previous) => JSON.stringify(previous) === JSON.stringify(binding),
        )
      )
        continue;
      const confirmation = await shell.setupFlow.readSelect({
        message: `Confirm ${binding.household}: legacy author “${binding.legacyAuthor}” belongs to Discord ID ${binding.userId}?`,
        options: [
          { value: "confirm", label: "I confirm this exact binding" },
          { value: "cancel", label: "Cancel" },
        ],
        allowBack: true,
      });
      if (confirmation !== "confirm") return;
    }
  }
  await apply(services, snapshot, transform);
}
