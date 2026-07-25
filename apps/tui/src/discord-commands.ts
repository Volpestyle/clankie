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
}

/**
 * `/discord` edits **non-secret** Discord configuration.
 *
 * The bot token deliberately does not appear here: secrets belong to the
 * credential broker via `/auth`, which redacts them and can use the OS
 * keychain. Everything this command writes is a public identifier an operator
 * wants to read back plainly, which is why it lives in `settings.json` instead.
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
    show("guild id", settings.guildId),
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
      if (choice === "core") await editCore(shell, services);
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

async function editCore(shell: ClankieFaceShell, services: DiscordCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).discord;

  const applicationId = await flow.readText({
    message: "Application id",
    placeholder: current.applicationId ?? "numeric id from the Discord developer portal",
    validate: validateSnowflake(true),
  });
  if (applicationId === undefined) return;

  const guildId = await flow.readText({
    message: "Server (guild) id",
    placeholder: current.guildId ?? "right-click your server with Developer Mode on",
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

  const channels = await flow.readText({
    message: "Channel ids Clankie may read (comma separated)",
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

  const guildIds = (await services.settings.load()).discord.guildId;
  await apply(services, (discord) => ({
    ...discord,
    textIngressEnabled: enabledChoice === "true",
    ...(channels.trim() ? { ingressChannelIds: splitList(channels) } : {}),
    ingressDmPolicy: policy as DiscordSettings["ingressDmPolicy"],
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
    // Readiness requires the ingress and presence allowlists to line up, so the
    // wizard mirrors them rather than letting an operator half-configure it.
    ...(guildIds === undefined ? {} : { ingressGuildIds: [guildIds], presenceGuildIds: [guildIds] }),
    ...(channels.trim() ? { presenceChannelIds: splitList(channels) } : {}),
  }));
  flow.renderLine("Saved text ingress, and mirrored the presence allowlist to match.", "success");
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

  const channels = await flow.readText({
    message: "Voice channel ids (comma separated)",
    placeholder: current.voiceChannelIds.join(",") || "voice channel id",
    validate: validateSnowflakeList,
  });
  if (channels === undefined) return;

  const guildId = (await services.settings.load()).discord.guildId;
  await apply(services, (discord) => ({
    ...discord,
    voiceEnabled: enabledChoice === "true",
    ...(channels.trim()
      ? { voiceChannelIds: splitList(channels), voiceChannelId: splitList(channels)[0] }
      : {}),
    ...(guildId === undefined ? {} : { voiceGuildIds: [guildId] }),
  }));
  flow.renderLine("Saved voice configuration.", "success");
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
