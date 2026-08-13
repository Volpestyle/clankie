import type { DiscordControlPlaneReadiness } from "@clankie/api-client";
import {
  DISCORD_BOT_PROVIDER_ID,
  resolveDiscordBridgeCredential,
  resolveDiscordVoiceBridgeCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { ApplicationFlagsBitField, REST, Routes } from "discord.js";

export interface DiscordReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly remediation: string;
}

export interface DiscordTextReadinessReport {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly checks: readonly DiscordReadinessCheck[];
}

interface DiscordRestReadPort {
  get(route: `/${string}`): Promise<unknown>;
}

interface DiscordControlPlaneReadinessPort {
  inspectDiscordReadiness(): Promise<DiscordControlPlaneReadiness>;
}

export interface InspectDiscordTextReadinessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly store: CredentialStore;
  readonly api: DiscordControlPlaneReadinessPort;
  readonly rest?: DiscordRestReadPort;
  readonly clock?: () => Date;
}

/**
 * Performs credential-safe live readiness checks for the official-bot text path.
 * No token, Discord message content, user name, guild name, or channel name enters
 * the report.
 */
export async function inspectDiscordTextReadiness(
  options: InspectDiscordTextReadinessOptions,
): Promise<DiscordTextReadinessReport> {
  const checks: DiscordReadinessCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, remediation: string): DiscordReadinessCheck => {
    const check = { name, ok, detail, remediation };
    checks.push(check);
    return check;
  };
  const forbiddenEnvironmentCredentials = [
    "DISCORD_BOT_TOKEN",
    "DISCORD_USER_TOKEN",
    "OPENAI_API_KEY",
  ].filter((name) => options.env[name]);
  add(
    "credential environment",
    forbiddenEnvironmentCredentials.length === 0,
    forbiddenEnvironmentCredentials.length === 0
      ? "Discord credentials are absent from the process environment"
      : `${forbiddenEnvironmentCredentials.length.toString()} forbidden credential variable(s) are set`,
    "Remove Discord token environment variables; store the official bot token as discord_bot.",
  );

  const botCredential = await options.store.get(DISCORD_BOT_PROVIDER_ID);
  const botToken = botCredential?.type === "api" ? botCredential.key : undefined;
  add(
    "official bot credential",
    botToken !== undefined,
    botToken === undefined
      ? "broker entry discord_bot is missing or not an API credential"
      : "present in broker",
    "Run clankie, open /auth, and add the official bot token under provider discord_bot.",
  );

  try {
    const bridgeToken = await resolveDiscordBridgeCredential({ store: options.store });
    add(
      "bridge identity",
      bridgeToken !== undefined,
      bridgeToken === undefined ? "broker entry clankie_discord_bridge is missing" : "present in broker",
      "Start the control plane once so it can mint the local Discord bridge identity.",
    );
  } catch (error) {
    add(
      "bridge identity",
      false,
      error instanceof Error ? error.message : "stored bridge identity is invalid",
      "Remove the malformed clankie_discord_bridge entry and restart the control plane.",
    );
  }
  const voiceEnabled = options.env.DISCORD_VOICE_ENABLED === "true";
  if (voiceEnabled) {
    try {
      const voiceBridgeToken = await resolveDiscordVoiceBridgeCredential({ store: options.store });
      add(
        "voice bridge identity",
        voiceBridgeToken !== undefined,
        voiceBridgeToken === undefined
          ? "broker entry clankie_discord_voice_bridge is missing"
          : "present in broker",
        "Start the control plane once so it can mint the local Discord voice identity.",
      );
    } catch (error) {
      add(
        "voice bridge identity",
        false,
        error instanceof Error ? error.message : "stored voice bridge identity is invalid",
        "Remove the malformed clankie_discord_voice_bridge entry and restart the control plane.",
      );
    }
  } else {
    add(
      "voice bridge identity",
      true,
      "voice is disabled",
      "Set DISCORD_VOICE_ENABLED=true when running the group-voice capability.",
    );
  }

  const applicationId = discordId(options.env.DISCORD_APPLICATION_ID);
  const guildId = discordId(options.env.DISCORD_GUILD_ID);
  const ambientRoles = discordIdSet(options.env.DISCORD_AMBIENT_ROLE_IDS);
  const ingressGuilds = discordIdSet(options.env.DISCORD_INGRESS_GUILD_IDS);
  const ingressChannels = discordIdSet(options.env.DISCORD_INGRESS_CHANNEL_IDS);
  const presenceGuilds = discordIdSet(options.env.DISCORD_PRESENCE_GUILD_IDS);
  const presenceChannels = discordIdSet(options.env.DISCORD_PRESENCE_CHANNEL_IDS);
  const voiceGuilds = discordIdSet(options.env.DISCORD_VOICE_GUILD_IDS);
  const voiceChannels = discordIdSet(options.env.DISCORD_VOICE_CHANNEL_IDS);

  add(
    "application id",
    applicationId !== undefined,
    applicationId === undefined ? "DISCORD_APPLICATION_ID is missing or invalid" : "configured",
    "Set DISCORD_APPLICATION_ID to the official Discord application's numeric id.",
  );
  add(
    "target guild",
    guildId !== undefined,
    guildId === undefined ? "DISCORD_GUILD_ID is missing or invalid" : "configured",
    "Set DISCORD_GUILD_ID to the guild used for live proof.",
  );
  add(
    "ambient roles",
    ambientRoles.size > 0,
    ambientRoles.size > 0
      ? `${ambientRoles.size.toString()} role binding(s) configured`
      : "no ambient role binding is configured",
    "Set DISCORD_AMBIENT_ROLE_IDS to the role ids granted the ambient command tier.",
  );
  const openAiCredential = voiceEnabled ? await options.store.get("openai") : undefined;
  add(
    "OpenAI speech credential",
    !voiceEnabled || openAiCredential?.type === "api",
    !voiceEnabled
      ? "voice is disabled"
      : openAiCredential?.type === "api"
        ? "brokered openai API credential is available"
        : "broker entry openai is missing or is not an API credential",
    "Use /auth to store the existing OpenAI API key under provider openai.",
  );
  // The channel allowlist is optional refinement: empty admits every voice
  // channel inside an allowlisted guild. Only the guild allowlist is required.
  const voiceAllowlistReady = !voiceEnabled || (guildId !== undefined && voiceGuilds.has(guildId));
  add(
    "voice allowlist",
    voiceAllowlistReady,
    !voiceEnabled
      ? "voice is disabled"
      : voiceAllowlistReady
        ? voiceChannels.size === 0
          ? "every voice channel in the target guild is admitted"
          : `${voiceChannels.size.toString()} voice channel(s) admitted in the target guild`
        : "target voice guild allowlist is incomplete",
    "Include DISCORD_GUILD_ID in DISCORD_VOICE_GUILD_IDS.",
  );
  add(
    "text ingress enabled",
    options.env.DISCORD_TEXT_INGRESS_ENABLED === "true",
    options.env.DISCORD_TEXT_INGRESS_ENABLED === "true" ? "enabled" : "disabled",
    "Set DISCORD_TEXT_INGRESS_ENABLED=true and enable Message Content Intent in the Discord portal.",
  );
  const ingressReady = guildId !== undefined && ingressGuilds.has(guildId) && ingressChannels.size > 0;
  add(
    "ingress allowlist",
    ingressReady,
    ingressReady
      ? `${ingressChannels.size.toString()} channel(s) admitted in the target guild`
      : "target guild or channel allowlist is incomplete",
    "Include DISCORD_GUILD_ID in DISCORD_INGRESS_GUILD_IDS and configure DISCORD_INGRESS_CHANNEL_IDS.",
  );
  const presenceReady =
    guildId !== undefined &&
    presenceGuilds.has(guildId) &&
    ingressChannels.size > 0 &&
    [...ingressChannels].every((id) => presenceChannels.has(id));
  add(
    "presence allowlist",
    presenceReady,
    presenceReady
      ? "every admitted ingress channel can receive governed replies"
      : "presence grants do not cover every admitted ingress channel",
    "Mirror the target guild and ingress channels into DISCORD_PRESENCE_GUILD_IDS and DISCORD_PRESENCE_CHANNEL_IDS.",
  );

  try {
    const readiness = await options.api.inspectDiscordReadiness();
    const ready = readiness.ready && Object.values(readiness.checks).every(Boolean);
    add(
      "control-plane composition",
      ready,
      ready
        ? "event store, Clankie channel turns, and Discord presence runtime are ready"
        : "one or more Discord control-plane dependencies are unavailable",
      "Start the control plane with CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE configured.",
    );
  } catch (error) {
    add(
      "control-plane composition",
      false,
      error instanceof Error ? error.message : "control-plane readiness request failed",
      "Start the control plane on CLANKIE_API_URL with the Discord presence runtime configured.",
    );
  }

  if (botToken !== undefined && applicationId !== undefined) {
    const rest = options.rest ?? new REST({ version: "10" }).setToken(botToken);
    try {
      const application = asRecord(await rest.get(Routes.currentApplication()));
      const liveApplicationId = typeof application.id === "string" ? application.id : undefined;
      add(
        "Discord application identity",
        liveApplicationId === applicationId,
        liveApplicationId === applicationId
          ? "brokered bot token matches DISCORD_APPLICATION_ID"
          : "brokered bot token does not match DISCORD_APPLICATION_ID",
        "Store the matching official bot token or correct DISCORD_APPLICATION_ID.",
      );
      const flags = typeof application.flags === "number" ? application.flags : 0;
      const applicationFlags = new ApplicationFlagsBitField(flags);
      const messageContentEnabled =
        applicationFlags.has(ApplicationFlagsBitField.Flags.GatewayMessageContent) ||
        applicationFlags.has(ApplicationFlagsBitField.Flags.GatewayMessageContentLimited);
      add(
        "Message Content Intent",
        messageContentEnabled,
        messageContentEnabled ? "enabled for the Discord application" : "not enabled for the application",
        "Enable Message Content Intent on the Bot page in the Discord developer portal.",
      );
    } catch (error) {
      add(
        "Discord application identity",
        false,
        error instanceof Error ? error.message : "Discord application lookup failed",
        "Verify the brokered bot token and network access, then rerun readiness.",
      );
      add(
        "Message Content Intent",
        false,
        "not checked because the Discord application lookup failed",
        "Resolve the Discord application identity check first.",
      );
    }

    if (guildId !== undefined) {
      try {
        // See voice-readiness.ts: fetching the guild is the bot-usable
        // membership probe; the `@me` member routes are unavailable to bots.
        await rest.get(Routes.guild(guildId));
        add("Discord guild membership", true, "official bot is installed in the target guild", "");
      } catch (error) {
        add(
          "Discord guild membership",
          false,
          error instanceof Error ? error.message : "target guild membership lookup failed",
          "Install the official bot in DISCORD_GUILD_ID with application.commands and required bot permissions.",
        );
      }
    } else {
      add(
        "Discord guild membership",
        false,
        "not checked because the target guild is missing",
        "Resolve the target guild check first.",
      );
    }
  } else {
    add(
      "Discord application identity",
      false,
      "not checked because the bot credential or application id is missing",
      "Resolve the official bot credential and application id checks first.",
    );
    add(
      "Message Content Intent",
      false,
      "not checked because the bot credential or application id is missing",
      "Resolve the official bot credential and application id checks first.",
    );
    add(
      "Discord guild membership",
      false,
      "not checked because live Discord identity is incomplete",
      "Resolve the bot credential, application id, and target guild checks first.",
    );
  }

  return {
    schemaVersion: 1,
    ready: checks.every((check) => check.ok),
    checkedAt: (options.clock ?? (() => new Date()))().toISOString(),
    checks,
  };
}

function discordId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{5,30}$/u.test(trimmed) ? trimmed : undefined;
}

function discordIdSet(value: string | undefined): ReadonlySet<string> {
  return new Set(
    value
      ?.split(",")
      .map((entry) => discordId(entry))
      .filter((entry): entry is string => entry !== undefined) ?? [],
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
