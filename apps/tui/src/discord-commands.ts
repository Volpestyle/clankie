import {
  SettingsStore,
  discordSettingsToEnvironment,
  resolveDiscordSettings,
  type ClankieSettings,
  type DiscordSettings,
} from "@clankie/settings";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface DiscordCommandServices {
  settings: SettingsStore;
  /** Provider ids already present in the credential broker. */
  listCredentials: () => Promise<Record<string, unknown>>;
  /**
   * Stores a secret in the credential broker. Tokens never touch the settings
   * file: `/discord` is only a friendlier entry point to the same broker `/auth`
   * writes to, because `discord_bot` is not a featured provider and would
   * otherwise require typing the provider id by hand.
   */
  setCredential: (providerId: string, key: string) => Promise<void>;
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
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "status") {
          await showDiscordStatus(shell, services);
          return;
        }
        await runDiscordWizard(shell, services);
      },
    },
  ];
}

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

/** Typed input wins; blank keeps what was already configured. */
export function resolveIdList(typed: string, existing: readonly string[]): string[] {
  return typed.trim().length > 0 ? splitList(typed) : [...existing];
}

/**
 * An empty allowlist denies everything — it never means "allow all". Enabling a
 * plane with nothing allowlisted is therefore always a mistake, and one the
 * operator would otherwise discover much later: voice refuses to start the
 * bridge at all, while text ingress starts fine and then silently ignores every
 * message. Catching it here turns both into an answer at configuration time.
 */
export function describeEmptyAllowlist(
  plane: "voice" | "text ingress",
  guildIds: readonly string[],
  channelIds: readonly string[],
): string | undefined {
  // The server allowlist is what bounds a plane to servers the owner chose, so
  // it is required for both.
  if (guildIds.length === 0) return `Cannot enable ${plane} with no server allowlisted.`;
  // Voice treats an empty channel list as "every voice channel in those
  // servers" — joining is still gated by the ambient role check and by
  // per-participant consent. Text ingress has no such gate: an empty list there
  // would silently drop every message, so it stays required.
  if (plane === "text ingress" && channelIds.length === 0) {
    return "Cannot enable text ingress with no channel allowlisted — Clankie would ignore every message.";
  }
  return undefined;
}

async function showDiscordStatus(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const stored = await services.settings.load();
  const resolved = resolveDiscordSettings(stored.discord);
  const credentials = await services.listCredentials();
  const lines: string[] = [];

  lines.push(`settings file: ${services.settings.path}`);
  lines.push(
    `bot token: ${"discord_bot" in credentials ? "stored in credential broker" : "MISSING — run /auth, provider id discord_bot"}`,
  );
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
    showList("approval roles", settings.approvalRoleIds),
    show("owner user id", settings.ownerUserId),
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
    `voice: ${settings.voiceEnabled ? "enabled" : "disabled"}`,
    showList("  voice guilds", settings.voiceGuildIds),
    showList("  voice channels", settings.voiceChannelIds),
    "",
    show("activity application id (gba)", settings.activityApplicationIdGba),
  ];
}

async function runDiscordWizard(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("discord");
  try {
    for (;;) {
      const action = await flow.readSelect({
        kind: "single",
        message: "Discord configuration",
        options: [
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
            description: "Application id, guild id, and the roles allowed to create or steer missions.",
          },
          {
            value: "ingress",
            label: "Text chat",
            hint: "channels Clankie reads",
            description: "Enable bounded text ingress and set the deny-by-default guild/channel allowlists.",
          },
          { value: "voice", label: "Voice", hint: "group voice allowlists" },
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
      if (choice === "export") {
        await showEnvironmentExport(shell, services);
        continue;
      }
      if (choice === "credentials") await editCredentials(shell, services);
      else if (choice === "core") await editCore(shell, services);
      else if (choice === "ingress") await editIngress(shell, services);
      else if (choice === "voice") await editVoice(shell, services);
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
    message: "Ambient role ids (comma separated) — may create and steer missions",
    placeholder: current.ambientRoleIds.join(",") || "role id",
    validate: validateSnowflakeList,
  });
  if (ambient === undefined) return;

  await apply(services, (discord) => ({
    ...discord,
    ...(applicationId.trim() ? { applicationId: applicationId.trim() } : {}),
    ...(guildId.trim() ? { guildId: guildId.trim() } : {}),
    ...(ambient.trim() ? { ambientRoleIds: splitList(ambient) } : {}),
  }));
  flow.renderLine("Saved server, application, and roles.", "success");
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
    message: "Channel ids Clankie may read (comma separated, across all those servers)",
    placeholder: current.ingressChannelIds.join(",") || "channel id",
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
    `Saved text ingress across ${String(guildIds.length)} server${guildIds.length === 1 ? "" : "s"}, and mirrored the presence allowlist to match.`,
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
    ...(channels.trim()
      ? { voiceChannelIds: splitList(channels), voiceChannelId: splitList(channels)[0] }
      : {}),
    ...(guildIds.length === 0 ? {} : { voiceGuildIds: guildIds }),
  }));
  flow.renderLine(
    `Saved voice across ${String(guildIds.length)} server${guildIds.length === 1 ? "" : "s"}` +
      (channelIds.length === 0 ? ", admitting every voice channel in them." : "."),
    "success",
  );
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
