import type { DiscordControlPlaneReadiness } from "@clankie/api-client";
import {
  DISCORD_BOT_PROVIDER_ID,
  resolveDiscordVoiceBridgeCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { REST, Routes } from "discord.js";
import { opus } from "prism-media";
import type { VoiceSpeechReadiness, VoiceSpeechRuntime } from "@clankie/discord-presence-core";
import type { DiscordReadinessCheck } from "./readiness.ts";

export interface DiscordVoiceReadinessReport {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly checks: readonly DiscordReadinessCheck[];
  readonly speech: VoiceSpeechReadiness;
}

interface DiscordControlPlaneReadinessPort {
  inspectDiscordReadiness(): Promise<DiscordControlPlaneReadiness>;
}

interface DiscordRestReadPort {
  get(route: `/${string}`): Promise<unknown>;
}

export interface InspectDiscordVoiceReadinessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly store: CredentialStore;
  readonly api: DiscordControlPlaneReadinessPort;
  readonly speech: VoiceSpeechRuntime;
  readonly rest?: DiscordRestReadPort;
  readonly opusAvailable?: () => boolean;
  readonly clock?: () => Date;
}

/** Credential-safe readiness for official-bot DAVE group voice; no Discord names or content enter it. */
export async function inspectDiscordVoiceReadiness(
  options: InspectDiscordVoiceReadinessOptions,
): Promise<DiscordVoiceReadinessReport> {
  const checks: DiscordReadinessCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, remediation: string): void => {
    checks.push({ name, ok, detail, remediation });
  };
  const forbiddenCredentials = ["DISCORD_BOT_TOKEN", "DISCORD_USER_TOKEN", "OPENAI_API_KEY"].filter(
    (name) => options.env[name],
  );
  add(
    "credential environment",
    forbiddenCredentials.length === 0,
    forbiddenCredentials.length === 0
      ? "Discord credentials are absent from the process environment"
      : `${String(forbiddenCredentials.length)} forbidden credential variable(s) are set`,
    "Remove Discord token environment variables; use brokered discord_bot.",
  );
  add(
    "voice enabled",
    options.env.DISCORD_VOICE_ENABLED === "true",
    options.env.DISCORD_VOICE_ENABLED === "true" ? "enabled" : "disabled",
    "Set DISCORD_VOICE_ENABLED=true for the bridge process.",
  );

  const applicationId = discordId(options.env.DISCORD_APPLICATION_ID);
  const guildId = discordId(options.env.DISCORD_GUILD_ID);
  const channelId = discordId(options.env.DISCORD_VOICE_CHANNEL_ID);
  const voiceGuildIds = discordIdSet(options.env.DISCORD_VOICE_GUILD_IDS);
  const voiceChannelIds = discordIdSet(options.env.DISCORD_VOICE_CHANNEL_IDS);
  add(
    "application id",
    applicationId !== undefined,
    applicationId === undefined ? "missing or invalid" : "configured",
    "Set DISCORD_APPLICATION_ID to the official Discord application id.",
  );
  add(
    "target guild",
    guildId !== undefined,
    guildId === undefined ? "missing or invalid" : "configured",
    "Set DISCORD_GUILD_ID to the private live-proof guild.",
  );
  add(
    "target voice channel",
    channelId !== undefined &&
      guildId !== undefined &&
      voiceGuildIds.has(guildId) &&
      voiceChannelIds.has(channelId),
    channelId === undefined
      ? "missing or invalid"
      : voiceGuildIds.has(guildId ?? "") && voiceChannelIds.has(channelId)
        ? "configured and allowlisted"
        : "live-proof target is outside the configured voice allowlist",
    "Set DISCORD_VOICE_CHANNEL_ID and include the target in DISCORD_VOICE_GUILD_IDS and DISCORD_VOICE_CHANNEL_IDS.",
  );

  const botCredential = await options.store.get(DISCORD_BOT_PROVIDER_ID);
  const botToken = botCredential?.type === "api" ? botCredential.key : undefined;
  add(
    "official bot credential",
    botToken !== undefined,
    botToken === undefined ? "broker entry discord_bot is missing" : "present in broker",
    "Add the official bot token under provider discord_bot on the authenticated /auth surface.",
  );
  try {
    const bridgeToken = await resolveDiscordVoiceBridgeCredential({ store: options.store });
    add(
      "bridge identity",
      bridgeToken !== undefined,
      bridgeToken === undefined
        ? "broker entry clankie_discord_voice_bridge is missing"
        : "present in broker",
      "Start the control plane once so it can mint the local Discord voice bridge identity.",
    );
  } catch (error) {
    add(
      "bridge identity",
      false,
      error instanceof Error ? error.message : "stored bridge identity is invalid",
      "Replace the malformed clankie_discord_voice_bridge broker entry by restarting the control plane.",
    );
  }

  const speech = await options.speech.readiness();
  add(
    "OpenAI speech",
    speech.ready,
    speech.ready
      ? `${speech.sttModel} transcription and ${speech.ttsModel}/${speech.voice} AI voice are configured`
      : "broker-backed OpenAI speech is unavailable",
    "Store the existing OpenAI API key under provider openai; do not put it in the environment.",
  );
  let opusReady = false;
  try {
    opusReady =
      options.opusAvailable?.() ??
      (() => {
        const decoder = new opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
        decoder.destroy();
        return opus.Decoder.type === "@discordjs/opus";
      })();
  } catch {
    opusReady = false;
  }
  add(
    "native Opus",
    opusReady,
    opusReady ? "@discordjs/opus encoder/decoder is loadable" : "native Opus codec is unavailable",
    "Run pnpm install with the repository-approved @discordjs/opus build enabled.",
  );

  try {
    const readiness = await options.api.inspectDiscordReadiness();
    const ready = readiness.ready && Object.values(readiness.checks).every(Boolean);
    add(
      "control-plane composition",
      ready,
      ready ? "captain lane and event store are ready" : "control-plane Discord dependencies are incomplete",
      "Start the control plane and Eve captain before the bridge.",
    );
  } catch (error) {
    add(
      "control-plane composition",
      false,
      error instanceof Error ? error.message : "control-plane readiness request failed",
      "Start the control plane on CLANKIE_API_URL.",
    );
  }

  if (botToken !== undefined && applicationId !== undefined && guildId !== undefined) {
    const rest = options.rest ?? new REST({ version: "10" }).setToken(botToken);
    try {
      const application = asRecord(await rest.get(Routes.currentApplication()));
      add(
        "Discord application identity",
        application.id === applicationId,
        application.id === applicationId ? "brokered bot matches application id" : "bot/application mismatch",
        "Correct DISCORD_APPLICATION_ID or the brokered discord_bot credential.",
      );
    } catch (error) {
      add(
        "Discord application identity",
        false,
        error instanceof Error ? error.message : "application lookup failed",
        "Verify the official bot credential and Discord network access.",
      );
    }
    try {
      await rest.get(Routes.guildMember(guildId, "@me"));
      add("Discord guild membership", true, "official bot is installed in the target guild", "");
    } catch (error) {
      add(
        "Discord guild membership",
        false,
        error instanceof Error ? error.message : "guild membership lookup failed",
        "Install the official bot in the target guild with Connect and Speak permissions.",
      );
    }
  } else {
    add(
      "Discord application identity",
      false,
      "not checked because live bot identity is incomplete",
      "Resolve the bot credential, application id, and guild checks first.",
    );
    add(
      "Discord guild membership",
      false,
      "not checked because live bot identity is incomplete",
      "Resolve the bot credential, application id, and guild checks first.",
    );
  }

  return {
    schemaVersion: 1,
    ready: checks.every((check) => check.ok),
    checkedAt: (options.clock ?? (() => new Date()))().toISOString(),
    checks,
    speech,
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
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
