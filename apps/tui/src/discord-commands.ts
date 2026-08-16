import {
  SettingsStore,
  discordSettingsToEnvironment,
  resolveDiscordSettings,
  type ClankieSettings,
  type DiscordSettings,
} from "@clankie/settings";
import type { RedactedCredential } from "@clankie/credential-broker";
import type { DiscordUserSessionOptIn } from "@clankie/protocol";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface DiscordUserSessionOptInClient {
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

export interface DiscordCommandServices {
  settings: SettingsStore;
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
      description: "Configure Discord ids, allowlists, and the activity plane",
      argumentHint: "[status|invite]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const selector = argument.trim().toLowerCase();
        if (selector === "status") {
          await showDiscordStatus(shell, services);
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

/**
 * Bot invite permissions: View Channel, Send Messages, Embed Links, Attach
 * Files, Read Message History, Add Reactions, Connect, Speak, Use VAD, Use
 * Application Commands. Message Content is a privileged *intent*, not a bit
 * here — the primer tells the owner to flip it in the portal.
 */
export const DISCORD_BOT_INVITE_PERMISSIONS = 2_184_301_632;

export function discordBotInviteUrl(applicationId: string): string {
  return (
    `https://discord.com/oauth2/authorize?client_id=${applicationId}` +
    `&permissions=${String(DISCORD_BOT_INVITE_PERMISSIONS)}&scope=bot%20applications.commands`
  );
}

export const DISCORD_BOT_PRIMER = [
  "1. Open https://discord.com/developers/applications and click New Application.",
  "2. Bot → Add Bot → Reset Token. Paste that token under Tokens.",
  "3. Privileged Gateway Intents: enable Message Content (required for text).",
  "4. Copy the Application ID from General Information, then /discord invite.",
  "5. Open the invite link, pick your server, and come back to set allowlists.",
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

/** Typed input wins; blank keeps what was already configured. */
export function resolveIdList(typed: string, existing: readonly string[]): string[] {
  return typed.trim().length > 0 ? splitList(typed) : [...existing];
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
  const stored = await services.settings.load();
  const resolved = resolveDiscordSettings(stored.discord);
  const credentials = await services.listCredentials();
  const lines: string[] = [];

  lines.push(`settings file: ${services.settings.path}`);
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
  lines.push(...describeSettings(resolved.settings));

  if (resolved.overriddenByEnvironment.length > 0) {
    lines.push("");
    lines.push("environment overrides in effect (these win over stored values):");
    for (const name of resolved.overriddenByEnvironment) lines.push(`  ${name}`);
  }

  shell.insertCommandResult("/discord status", lines.join("\n"), "success");
}

function describeSettings(settings: DiscordSettings): string[] {
  const show = (label: string, value: string | undefined): string =>
    `${label}: ${value === undefined || value.length === 0 ? "—" : value}`;
  const showList = (label: string, values: readonly string[]): string =>
    `${label}: ${values.length === 0 ? "—" : values.join(", ")}`;
  return [
    show("application id", settings.applicationId),
    // Singular on purpose: only slash-command registration is one-server.
    `command server: ${settings.guildId ?? "— (commands register globally)"}`,
    showList("ambient roles", settings.ambientRoleIds),
    showList("ambient users", settings.ambientUserIds),
    showList("approval roles", settings.approvalRoleIds),
    show("owner user id", settings.ownerUserId),
    showList("system actors", settings.systemActorUserIds),
    "",
    `text ingress: ${settings.textIngressEnabled ? "enabled" : "disabled"}`,
    showList("  ingress guilds", settings.ingressGuildIds),
    showList("  ingress channels", settings.ingressChannelIds),
    `  dm policy: ${settings.ingressDmPolicy}`,
    `  context messages: ${String(settings.ingressContextMessages)}`,
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
    "",
    show("activity application id (gba)", settings.activityApplicationIdGba),
  ];
}

export async function runDiscordWizard(
  shell: ClankieFaceShell,
  services: DiscordCommandServices,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("discord");
  try {
    for (;;) {
      const settings = (await services.settings.load()).discord;
      const action = await flow.readSelect({
        kind: "single",
        message: "Discord configuration",
        options: [
          {
            value: "primer",
            label: "How to create the bot",
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
            label: "Machine control from Discord",
            hint: "who may ask him to drive herdr / the shell",
            description:
              "Discord users whose text turns get bash, files, and herdr. Empty means nobody — Discord stays social. The operator console is always privileged.",
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
          { value: "status", label: "Show status" },
          { value: "done", label: "Done" },
        ],
        required: true,
      });
      const choice = action?.[0];
      if (choice === undefined || choice === "done") break;
      if (choice === "status") {
        await showDiscordStatus(shell, services);
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
      if (choice === "credentials") await editCredentials(shell, services);
      else if (choice === "core") await editCore(shell, services);
      else if (choice === "system") await editSystemActors(shell, services);
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

type Patch = (current: DiscordSettings) => DiscordSettings;

async function apply(services: DiscordCommandServices, patch: Patch): Promise<ClankieSettings> {
  return services.settings.update((current) => ({
    ...current,
    discord: patch(current.discord),
  }));
}

async function editCredentials(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const stored = await services.listCredentials();
  const picked = await flow.readSelect({
    kind: "single",
    message: "Which token?",
    options: DISCORD_CREDENTIALS.map((credential) => ({
      value: credential.id,
      label: credential.label,
      hint: credential.id in stored ? "configured" : credential.hint,
      description: credential.description,
    })),
    required: true,
    allowBack: true,
  });
  const providerId = picked?.[0];
  if (providerId === undefined) return;

  // Show what is already there before offering to overwrite it. Re-prompting
  // blindly invites an accidental clobber of a working credential, and gives an
  // operator no way to answer "is the token even set?" without replacing it.
  const existing = stored[providerId];
  if (existing !== undefined) {
    const decision = await flow.readSelect({
      kind: "single",
      message: `${providerId} is already stored — ${describeRedactedCredential(existing)}`,
      options: [
        { value: "keep", label: "Keep it", hint: "no change" },
        { value: "replace", label: "Replace it", hint: "enter a new token" },
        { value: "remove", label: "Remove it", hint: "delete from the broker" },
      ],
      required: true,
      allowBack: true,
    });
    const choice = decision?.[0];
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
  const current = (await services.settings.load()).discord;

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

  await apply(services, (discord) => ({
    ...discord,
    ...(applicationId.trim() ? { applicationId: applicationId.trim() } : {}),
    ...(guildId.trim() ? { guildId: guildId.trim() } : {}),
    ...(ambient.trim() ? { ambientRoleIds: splitList(ambient) } : {}),
    ...(ambientUsers.trim() ? { ambientUserIds: splitList(ambientUsers) } : {}),
  }));
  flow.renderLine("Saved server, application, and roles.", "success");
}

async function editSystemActors(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).discord;

  const typed = await flow.readText({
    message:
      "Discord user ids who may ask him to control this machine (comma separated) — bash, files, herdr. Blank keeps the current list. Empty list means nobody; Discord stays social.",
    placeholder: current.systemActorUserIds.join(",") || current.ownerUserId || "your Discord user id",
    validate: validateSnowflakeList,
  });
  if (typed === undefined) return;

  const systemActorUserIds = resolveIdList(typed, current.systemActorUserIds);
  await apply(services, (discord) => ({ ...discord, systemActorUserIds }));
  flow.renderLine(
    systemActorUserIds.length === 0
      ? "Saved machine-control allowlist (empty — Discord stays social)."
      : `Saved machine-control allowlist (${String(systemActorUserIds.length)} user${systemActorUserIds.length === 1 ? "" : "s"}).`,
    "success",
  );
}

async function editIngress(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).discord;

  const enabled = await flow.readSelect({
    kind: "single",
    message: "Text ingress (requires Message Content Intent in the Discord portal)",
    options: [
      { value: "true", label: "Enabled", hint: "Clankie reads allowlisted channels" },
      { value: "false", label: "Disabled" },
    ],
    required: true,
  });
  const enabledChoice = enabled?.[0];
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
    kind: "single",
    message: "Direct messages",
    options: [
      { value: "deny", label: "Deny all DMs" },
      { value: "owner_only", label: "Owner only", hint: "needs your user id" },
      { value: "allowlist", label: "Explicit allowlist" },
    ],
    required: true,
  });
  const policy = dmPolicy?.[0];
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
  await apply(services, (discord) => ({
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
  const current = (await services.settings.load()).discord;

  const enabled = await flow.readSelect({
    kind: "single",
    message: "Group voice",
    options: [
      { value: "true", label: "Enabled" },
      { value: "false", label: "Disabled" },
    ],
    required: true,
  });
  const enabledChoice = enabled?.[0];
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
    kind: "single",
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
    required: true,
  });
  const joinPolicyChoice = joinPolicy?.[0];
  if (joinPolicyChoice === undefined) return;

  const consentPolicy = await flow.readSelect({
    kind: "single",
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
    required: true,
  });
  const consentPolicyChoice = consentPolicy?.[0];
  if (consentPolicyChoice === undefined) return;

  const guildIds = resolveGuildList(guilds, current.voiceGuildIds, current.guildId);
  const channelIds = resolveIdList(channels, current.voiceChannelIds);
  if (enabledChoice === "true") {
    const problem = describeEmptyAllowlist("voice", guildIds, channelIds);
    if (problem !== undefined) {
      flow.renderLine(problem, "error");
      return;
    }
  }
  await apply(services, (discord) => ({
    ...discord,
    voiceEnabled: enabledChoice === "true",
    voiceJoinPolicy: joinPolicyChoice as DiscordSettings["voiceJoinPolicy"],
    voiceConsentPolicy: consentPolicyChoice as DiscordSettings["voiceConsentPolicy"],
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
        : " Each person still opts in per call."),
    "success",
  );
}

const LAB_ACKNOWLEDGEMENT = "I accept Discord ToS and account risk for this personal-lab user-session body.";

async function editActiveBody(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).discord;
  const credentials = await services.listCredentials();
  const picked = await flow.readSelect({
    kind: "single",
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
    required: true,
  });
  const choice = picked?.[0];
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

  await apply(services, (discord) => ({ ...discord, activeBody: choice }));
  flow.renderLine(
    choice === "user_session"
      ? "Lab user body is the mouth. Run `clankie restart` so the official bot stays down."
      : "Official bot is the mouth. Run `clankie restart` so the lab body stays down.",
    "success",
  );
}

async function editLabBody(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).discord;

  const enabled = await flow.readSelect({
    kind: "single",
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
    required: true,
  });
  const enabledChoice = enabled?.[0];
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

  await apply(services, (discord) => ({
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
    kind: "single",
    message: LAB_ACKNOWLEDGEMENT,
    options: [
      { value: "accept", label: "I accept", hint: "records a durable opt-in" },
      { value: "skip", label: "Skip for now" },
    ],
    required: true,
  });
  if (accept?.[0] !== "accept") {
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
  const current = (await services.settings.load()).discord;
  const applicationId = await flow.readText({
    message: "Embedded application id for the Fire Red surface",
    placeholder: current.activityApplicationIdGba ?? "usually the same application id",
    validate: validateSnowflake(true),
  });
  if (applicationId === undefined) return;
  await apply(services, (discord) => ({
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
  const applicationId = (await services.settings.load()).discord.applicationId;
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
      discordBotInviteUrl(applicationId),
      "",
      "Then enable text/voice under /discord. Message Content is a portal intent, not this link.",
    ].join("\n"),
    "success",
  );
}

async function showEnvironmentExport(
  shell: ClankieFaceShell,
  services: DiscordCommandServices,
): Promise<void> {
  const stored = await services.settings.load();
  const env = discordSettingsToEnvironment(stored.discord);
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
