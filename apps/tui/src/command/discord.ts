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
  "       clankie discord set --field value [--field value ...]",
  "       clankie discord clear --field [--field ...]",
  "Fields are the settings.json Discord keys in kebab-case; lists are comma-separated.",
].join("\n");

export interface DiscordCommandOptions {
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
    show("application id", settings.applicationId),
    `command server: ${settings.guildId ?? "— (commands register globally)"}`,
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
    showList("  tool progress channels", settings.toolProgressChannelIds),
    "",
    showList("presence guilds", settings.presenceGuildIds),
    showList("presence channels", settings.presenceChannelIds),
    "",
    `active body: ${settings.activeBody === "user_session" ? "lab user" : "official bot"}`,
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
  ];
}

export async function discordStatus(options: DiscordCommandOptions = {}): Promise<DiscordCommandResult> {
  const settings = store(options);
  return await result(settings, (await settings.load()).discord, options);
}

async function discordUpdate(
  patch: Partial<DiscordSettings>,
  options: DiscordCommandOptions = {},
): Promise<DiscordCommandResult> {
  return await discordTransform((current) => ({ ...current, ...patch }), options);
}

export async function discordTransform(
  transform: (current: DiscordSettings) => DiscordSettings,
  options: DiscordCommandOptions = {},
): Promise<DiscordCommandResult> {
  const settings = store(options);
  const updated = await settings.update((current) => ({
    ...current,
    discord: transform(current.discord),
  }));
  return await result(settings, updated.discord, options);
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

function parseValue(field: DiscordField, raw: string, current: DiscordSettings): unknown {
  const example = current[field] ?? emptySettings().discord[field];
  if (Array.isArray(example)) {
    return raw.toLowerCase() === "none"
      ? []
      : raw
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
  }
  if (typeof example === "boolean") {
    if (["true", "on", "enabled"].includes(raw)) return true;
    if (["false", "off", "disabled"].includes(raw)) return false;
    throw new Error(`${field} must be on or off.`);
  }
  if (typeof example === "number") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) throw new Error(`${field} must be a whole number.`);
    return parsed;
  }
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
    patch[field] = parseValue(field, raw, current);
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
  const settings = store(options);
  const updated = await settings.update((current) => {
    const discord = { ...current.discord } as Partial<DiscordSettings>;
    for (const field of fields) {
      if (field in defaults) discord[field] = defaults[field] as never;
      else delete discord[field];
    }
    return { ...current, discord: DiscordSettingsSchema.parse(discord) };
  });
  return await result(settings, updated.discord, options);
}

export async function runDiscordCommand(
  args: readonly string[],
  options: DiscordCommandOptions = {},
): Promise<DiscordCommandResult> {
  const verb = args[0];
  if (verb === undefined || verb === "status") return await discordStatus(options);
  if (verb === "set") return await discordSetArgs(args.slice(1), options);
  if (verb === "clear") return await discordClearArgs(args.slice(1), options);
  throw new Error(DISCORD_USAGE);
}
