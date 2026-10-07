import { ownerSettingsApi } from "./owner-settings-api.ts";
import { DISCORD_SETTINGS_PATH, DiscordSettingsSnapshotSchema } from "@clankie/protocol";
import { ClankieApiClient } from "@clankie/api-client";
import { runDiscordSetupCommand } from "./discord-setup.ts";
import { runDiscordOfficialCommand, type DiscordOfficialResult } from "./discord-official.ts";
import { DISCORD_SETTING_GROUPS, discordServerSettings, discordWakeTrigger } from "@clankie/protocol";
import { DiscordDirectoryRequestSchema, type DiscordDirectorySnapshot } from "@clankie/protocol";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import type {
  DiscordRoomStatus,
  DiscordRoomGuidance,
  DiscordRoomVoiceStatus,
  DiscordSetupSnapshot,
} from "@clankie/protocol";
import { parseArgs } from "node:util";
import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import { DiscordVoiceTranscriptCursorSchema, type DiscordVoiceTranscriptPage } from "@clankie/protocol";
import { createCaptainRouteClient } from "../session/operator-conversations.ts";
import { createDiscordVoiceTranscriptClient } from "../session/voice-transcripts.ts";
import { commandHost } from "./io.ts";
import {
  DiscordSettingsSchema,
  SettingsStore,
  defaultSettingsPath,
  emptySettings,
  resolveDiscordSettings,
  type DiscordSettings,
} from "@clankie/settings";

const DISCORD_USAGE = [
  "Usage: clankie discord [status]",
  "       clankie discord rooms",
  "       clankie discord definition",
  "       clankie discord setup [check | choices connect|fleet|tracking]",
  "       clankie discord setup connect [--server NAME] [--role participant|admin]",
  "       clankie discord setup invite [--role participant|admin]",
  "       clankie discord setup fleet --enabled on|off",
  "       clankie discord setup tracking --level off|project_updates|project_activity|all_issues",
  "       clankie discord directory [servers|channels|roles|people] [--server ID] [--limit N] [--after ID]",
  "       clankie discord setup test-post --channel NAME",
  "       clankie discord guide CONVERSATION_ID TEXT|--clear",
  "       clankie discord transcripts [--cursor CURSOR] [--limit N]",
  "       clankie discord official [status|on|off]   (free official bot via your Clankie account)",
  "       clankie discord set --field value [--field value ...]",
  "       clankie discord clear --field [--field ...]",
  "Fields are the settings.json Discord keys in kebab-case; lists are comma-separated.",
].join("\n");

export interface DiscordCommandOptions {
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly captainCredentialStore?: CredentialStore;
  readonly operatorCredentialStore?: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
}

export interface DiscordCommandResult {
  readonly ok: true;
  readonly discord: DiscordSettings;
  readonly effectiveDiscord: DiscordSettings;
  readonly overriddenByEnvironment: readonly string[];
  readonly settingsFile: string;
  readonly restart: string;
}

function store(options: DiscordCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

async function result(
  settings: SettingsStore,
  discord: DiscordSettings,
  options: DiscordCommandOptions,
): Promise<DiscordCommandResult> {
  const resolved = resolveDiscordSettings(discord, options.env ?? process.env);
  return {
    ok: true,
    discord,
    effectiveDiscord: resolved.settings,
    overriddenByEnvironment: resolved.overriddenByEnvironment,
    settingsFile: settings.path,
    restart: "clankie restart",
  };
}

export function formatDiscordSettings(settings: DiscordSettings): string[] {
  const show = (label: string, value: string | undefined): string =>
    `${label}: ${value === undefined || value.length === 0 ? "—" : value}`;
  const showList = (label: string, values: readonly string[]): string =>
    `${label}: ${values.length === 0 ? "—" : values.join(", ")}`;
  return [
    show("connected server", settings.serverId),
    `role: ${settings.role}`,
    `fleet in Discord: ${settings.fleetEnabled ? "on" : "off"}`,
    `project tracking: ${settings.trackingLevel}`,
    show("participant fleet channel (Advanced)", settings.fleetChannelId),
    "",
    show("application id", settings.applicationId),
    `command server: ${settings.guildId ?? "— (commands register globally)"}`,
    // Separate from the command server on purpose: this is the one server he
    // controls, and the only one his agents can be given rooms in.
    `managed server: ${settings.swarmGuildId ?? "— (no server he may make rooms in)"}`,
    showList("ambient roles", settings.ambientRoleIds),
    showList("ambient users", settings.ambientUserIds),
    showList("approval roles", settings.approvalRoleIds),
    show("owner user id", settings.ownerUserId),
    showList("system actors", settings.systemActorUserIds),
    showList("system guilds", settings.systemActorGuildIds),
    showList("system channels", settings.systemActorChannelIds),
    "",
    `text ingress: ${settings.textIngressEnabled ? "enabled" : "disabled"}`,
    showList("  ingress guilds", settings.ingressGuildIds),
    showList("  ingress channels", settings.ingressChannelIds),
    `  dm policy: ${settings.ingressDmPolicy}`,
    `  context messages: ${String(settings.ingressContextMessages)}`,
    `  what wakes him: ${discordWakeTrigger(settings.wakeTrigger) ?? "this body's default (self-hosted: persona reply policy; hosted: mention)"}`,
    showList("  followed between wakes (hosted/official)", settings.ambientChannelIds),
    showList("  tool progress channels", settings.toolProgressChannelIds),
    "",
    showList("presence guilds", settings.presenceGuildIds),
    showList("presence channels", settings.presenceChannelIds),
    "",
    `active body: ${settings.activeBody === "user_session" ? "lab user" : "official bot"}`,
    `free official Clankie bot (account route): ${settings.officialBotEnabled ? "on" : "off"}`,
    `lab user body: ${settings.userSessionEnabled ? "enabled" : "disabled"}`,
    showList("  lab guilds", settings.userSessionGuildIds),
    showList("  lab channels", settings.userSessionChannelIds),
    showList("  lab voice channels", settings.userSessionVoiceChannelIds),
    `  lab voice: ${settings.userSessionVoiceEnabled ? "enabled" : "disabled"}`,
    `  lab DMs: ${settings.userSessionDmPolicy}`,
    "",
    `voice: ${settings.voiceEnabled ? "enabled" : "disabled"}`,
    showList("  voice guilds", settings.voiceGuildIds),
    showList("  voice channels", settings.voiceChannelIds),
    `  who may summon: ${settings.voiceJoinPolicy === "guild_members" ? "any member of those servers" : "ambient tier only"}`,
    `  who he hears: ${
      settings.voiceConsentPolicy === "presence"
        ? "anyone in his active voice channel (one-time owner switch)"
        : "only people who opt in each call"
    }`,
    `  full transcript log: ${settings.voiceTranscriptLoggingEnabled ? "enabled" : "disabled"}`,
    "",
    show("activity application id (gba)", settings.activityApplicationIdGba),
    show("activity tunnel name", settings.activityTunnelName),
    show("activity tunnel hostname", settings.activityTunnelHostname),
    showList("ingress DM users", settings.ingressDmUserIds),
    showList("lab DM users", settings.userSessionDmUserIds),
    show("default voice channel", settings.voiceChannelId),
  ];
}

export async function discordStatus(options: DiscordCommandOptions = {}): Promise<DiscordCommandResult> {
  const api = await ownerSettingsApi(options);
  const snapshot = await api.get(DISCORD_SETTINGS_PATH, DiscordSettingsSnapshotSchema);
  return await result(store(options), snapshot.settings, options);
}

async function discordUpdate(
  patch: Partial<DiscordSettings>,
  options: DiscordCommandOptions = {},
): Promise<DiscordCommandResult> {
  return await discordTransform((current) => ({ ...current, ...patch }), options);
}

async function discordTransform(
  transform: (current: DiscordSettings) => DiscordSettings,
  options: DiscordCommandOptions = {},
): Promise<DiscordCommandResult> {
  const api = await ownerSettingsApi(options);
  const snapshot = await api.get(DISCORD_SETTINGS_PATH, DiscordSettingsSnapshotSchema);
  const discord = discordServerSettings(
    DiscordSettingsSchema.parse(transform(snapshot.settings)),
    snapshot.settings,
  );
  const updated = await api.write(
    DISCORD_SETTINGS_PATH,
    { expectedRevision: snapshot.revision, settings: discord },
    DiscordSettingsSnapshotSchema,
  );
  return await result(store(options), updated.settings, options);
}

type DiscordField = keyof DiscordSettings;

function fieldForFlag(flag: string): DiscordField {
  if (!flag.startsWith("--")) throw new Error(DISCORD_USAGE);
  const field = flag
    .slice(2)
    .replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase()) as DiscordField;
  if (!(field in DiscordSettingsSchema.shape))
    throw new Error(`Unknown Discord field ${flag}.\n${DISCORD_USAGE}`);
  return field;
}

export function parseDiscordSettingValue(
  field: DiscordField,
  raw: string,
  current: DiscordSettings,
): unknown {
  const example = current[field] ?? emptySettings().discord[field];
  if (Array.isArray(example)) {
    return raw.toLowerCase() === "none"
      ? []
      : raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
  }
  if (
    typeof example === "boolean" ||
    DISCORD_SETTING_GROUPS.some((group) =>
      group.fields.some((entry) => entry.key === field && entry.kind === "boolean"),
    )
  ) {
    if (["true", "on", "enabled"].includes(raw)) return true;
    if (["false", "off", "disabled"].includes(raw)) return false;
    throw new Error(`${field} must be on or off.`);
  }
  if (typeof example === "number") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) throw new Error(`${field} must be a whole number.`);
    return parsed;
  }
  // `addressed` was the first spelling of `mention`; save the current one.
  if (field === "wakeTrigger" && raw === "addressed") return "mention";
  return raw;
}

async function discordSetArgs(
  args: readonly string[],
  options: DiscordCommandOptions,
): Promise<DiscordCommandResult> {
  if (args.length === 0 || args.length % 2 !== 0) throw new Error(DISCORD_USAGE);
  const current = (await discordStatus(options)).discord;
  const patch: Partial<Record<DiscordField, unknown>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const raw = args[index + 1];
    if (flag === undefined || raw === undefined) throw new Error(DISCORD_USAGE);
    const field = fieldForFlag(flag);
    patch[field] = parseDiscordSettingValue(field, raw, current);
  }
  return await discordUpdate(patch as Partial<DiscordSettings>, options);
}

async function discordClearArgs(
  args: readonly string[],
  options: DiscordCommandOptions,
): Promise<DiscordCommandResult> {
  if (args.length === 0) throw new Error(DISCORD_USAGE);
  const fields = args.map(fieldForFlag);
  const defaults = emptySettings().discord;
  return discordTransform((current) => {
    const discord = { ...current } as Partial<DiscordSettings>;
    for (const field of fields) {
      if (field in defaults) discord[field] = defaults[field] as never;
      else delete discord[field];
    }
    return DiscordSettingsSchema.parse(discord);
  }, options);
}

export async function runDiscordCommand(
  args: readonly string[],
  options: DiscordCommandOptions = {},
): Promise<
  | DiscordCommandResult
  | DiscordVoiceTranscriptPage
  | { rooms: DiscordRoomStatus[] }
  | DiscordRoomGuidance
  | DiscordRoomVoiceStatus
  | DiscordSetupSnapshot
  | DiscordDirectorySnapshot
  | Awaited<ReturnType<typeof runDiscordSetupCommand>>
  | DiscordOfficialResult
> {
  const verb = args[0];
  if (verb === "official")
    return await runDiscordOfficialCommand(args.slice(1), {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.operatorCredentialStore === undefined
        ? {}
        : { credentials: options.operatorCredentialStore }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  if (
    verb === "rooms" ||
    verb === "guide" ||
    verb === "call" ||
    verb === "definition" ||
    verb === "setup" ||
    verb === "directory"
  ) {
    let directoryQuery;
    if (verb === "directory") {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        allowPositionals: true,
        options: { server: { type: "string" }, limit: { type: "string" }, after: { type: "string" } },
      });
      if (positionals.length > 1) throw new Error(DISCORD_USAGE);
      directoryQuery = DiscordDirectoryRequestSchema.parse({
        kind: positionals[0] ?? "servers",
        ...(values.server ? { guildId: values.server } : {}),
        ...(values.limit ? { limit: values.limit } : {}),
        ...(values.after ? { after: values.after } : {}),
      });
    }
    if (verb === "definition" && args.length !== 1) throw new Error(DISCORD_USAGE);
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (!credential) throw new Error("Operator authentication is unavailable");
    const client = new ClankieApiClient({
      baseUrl: commandHost(options),
      operatorToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    if (directoryQuery) return client.discordDirectory(directoryQuery);
    if (verb === "setup") return runDiscordSetupCommand(args.slice(1), client);
    if (verb === "definition") {
      const snapshot = await client.discordSettings();
      if (!snapshot.setup)
        throw new Error("This host does not provide the shared Discord settings definition yet.");
      return snapshot.setup;
    }
    if (verb === "call") {
      if (args.length === 1) return client.discordRoomVoice();
      const action = args[1];
      const conversationId = args[2];
      if (!conversationId || !["join", "leave", "mute_output", "unmute_output"].includes(action ?? ""))
        throw new Error(
          "Usage: clankie discord call [join|leave|mute_output|unmute_output CONVERSATION_ID [STAY_ID]]",
        );
      return client.controlDiscordRoomVoice({
        action,
        conversationId,
        ...(args[3] === undefined ? {} : { stayId: args[3] }),
      });
    }
    if (verb === "rooms") {
      if (args.length !== 1) throw new Error(DISCORD_USAGE);
      return client.discordRooms();
    }
    const id = args[1];
    const text = args.slice(2).join(" ");
    if (!id || !text) throw new Error("Usage: clankie discord guide CONVERSATION_ID TEXT (or --clear)");
    const room = (await client.discordRooms()).rooms.find((value) => value.conversationId === id);
    if (!room) throw new Error("Room not found; inspect clankie discord rooms first");
    return client.discordRoomGuidance({
      conversationId: id,
      expectedRevision: room.guidance.revision,
      ...(text === "--clear" ? {} : { text }),
    });
  }

  if (verb === "transcripts") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: { cursor: { type: "string" }, limit: { type: "string", default: "100" } },
    });
    const limit = Number(values.limit);
    if (
      positionals.length ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (values.cursor !== undefined && !DiscordVoiceTranscriptCursorSchema.safeParse(values.cursor).success)
    )
      throw new Error(DISCORD_USAGE);
    const env = options.env ?? process.env;
    const credential = await resolveCaptainCredential({
      env,
      ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
    });
    if (credential === undefined)
      throw new Error("No captain credential is available; start the clankie service once first.");
    return createDiscordVoiceTranscriptClient(
      createCaptainRouteClient({
        host: commandHost({ ...options, env }),
        captainToken: credential.token,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      }),
    ).read({ limit, ...(values.cursor === undefined ? {} : { cursor: values.cursor }) });
  }
  if (verb === undefined || verb === "status") return await discordStatus(options);
  if (verb === "set") return await discordSetArgs(args.slice(1), options);
  if (verb === "clear") return await discordClearArgs(args.slice(1), options);
  throw new Error(DISCORD_USAGE);
}
