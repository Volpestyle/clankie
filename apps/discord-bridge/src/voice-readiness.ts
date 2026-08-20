import type {
  DiscordControlPlaneReadiness,
  DiscordVoiceBriefing,
  DiscordVoiceBriefingRequest,
} from "@clankie/api-client";
import {
  DISCORD_BOT_PROVIDER_ID,
  resolveDiscordVoiceBridgeCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { REST, Routes } from "discord.js";
import {
  ASK_CLANKIE_TOOL_NAME,
  DEFAULT_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT,
  DEFAULT_VOICE_REALTIME_MODEL,
  DEFAULT_VOICE_REALTIME_PROVIDER,
  DEFAULT_VOICE_REALTIME_VOICE,
  DEFAULT_VOICE_TRANSCRIBE_MODEL,
  DEFAULT_VOICE_TRUNCATION_RETENTION,
  DEFAULT_VOICE_TTS_PROVIDER,
  DEFAULT_XAI_VOICE_REALTIME_MODEL,
  DEFAULT_XAI_VOICE_REALTIME_VOICE,
  openRealtimeConversationSession,
  openRealtimeTranscriptionSession,
  openXaiStreamingTranscriptionSession,
  parseVoiceRealtimeEnv,
  XAI_REALTIME_BASE_URL,
  type RealtimeSocketFactory,
  type RealtimeTimers,
  type VoiceRealtimeEnvConfig,
  type VoiceRealtimeProvider,
  type VoiceTtsProvider,
} from "@clankie/discord-presence-core";
import { asRecord, discordId, discordIdSet, type DiscordReadinessCheck } from "./readiness.ts";
import { probeVoxProcess, type VoxProcessProbeResult } from "./vox-process.ts";

/** Content-free realtime configuration echo: provider, models, and truncation scalars only. */
export interface VoiceRealtimeReadiness {
  readonly provider: VoiceRealtimeProvider;
  readonly transcribeModel: string;
  readonly realtimeModel: string;
  readonly voice: string;
  /** Who synthesizes his speech (ADR 0070); the ids are public identifiers. */
  readonly ttsProvider: VoiceTtsProvider;
  readonly elevenLabsVoiceId?: string;
  readonly elevenLabsModelId?: string;
  /** OpenAI-only explicit context truncation controls. */
  readonly truncationRetentionRatio?: number;
  readonly postInstructionsTokenLimit?: number;
}

export interface DiscordVoiceReadinessReport {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly checks: readonly DiscordReadinessCheck[];
  readonly realtime: VoiceRealtimeReadiness;
}

interface DiscordVoiceControlPlanePort {
  inspectDiscordReadiness(): Promise<DiscordControlPlaneReadiness>;
  fetchDiscordVoiceBriefing(input: DiscordVoiceBriefingRequest): Promise<DiscordVoiceBriefing>;
}

interface DiscordRestReadPort {
  get(route: `/${string}`): Promise<unknown>;
}

/**
 * One stage of the live wake probe: whether it passed and a content-free
 * detail line. No transcript, response, or audio ever enters a result.
 */
export interface VoiceWakeProbeStage {
  readonly ok: boolean;
  readonly detail: string;
}

export interface VoiceWakeTransitionProbeResult {
  readonly listener: VoiceWakeProbeStage;
  readonly engaged: VoiceWakeProbeStage;
  readonly capability: VoiceWakeProbeStage;
}

/**
 * Injected by tests (fakes) and defaulted to {@link probeVoiceWakeTransition}
 * by the CLI path, mirroring how the Discord REST probes default live.
 */
export type VoiceWakeTransitionProbe = () => Promise<VoiceWakeTransitionProbeResult>;

export interface InspectDiscordVoiceReadinessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly store: CredentialStore;
  readonly api: DiscordVoiceControlPlanePort;
  readonly rest?: DiscordRestReadPort;
  readonly voxProbe?: () => Promise<VoxProcessProbeResult>;
  readonly clock?: () => Date;
  /**
   * The dormant→engaged live probe. When omitted it is built from the
   * brokered openai credential and the parsed realtime configuration — the
   * live CLI path — and skipped (as failed checks) when either is missing.
   * Unit tests inject a fake to stay offline.
   */
  readonly wakeProbe?: VoiceWakeTransitionProbe;
}

/** Credential-safe readiness for official-bot DAVE group voice; no Discord names or content enter it. */
export async function inspectDiscordVoiceReadiness(
  options: InspectDiscordVoiceReadinessOptions,
): Promise<DiscordVoiceReadinessReport> {
  const checks: DiscordReadinessCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, remediation: string): void => {
    checks.push({ name, ok, detail, remediation });
  };
  const forbiddenCredentials = [
    "DISCORD_BOT_TOKEN",
    "DISCORD_USER_TOKEN",
    "OPENAI_API_KEY",
    "XAI_API_KEY",
    "ELEVENLABS_API_KEY",
    "XI_API_KEY",
  ].filter((name) => options.env[name]);
  add(
    "credential environment",
    forbiddenCredentials.length === 0,
    forbiddenCredentials.length === 0
      ? "Discord and voice-vendor credentials are absent from the process environment"
      : `${String(forbiddenCredentials.length)} forbidden credential variable(s) are set`,
    "Remove credential environment variables; use the brokered discord_bot, selected realtime provider, and elevenlabs entries.",
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
  // An empty channel allowlist admits every voice channel in an allowlisted
  // guild, so the live-proof target only has to sit inside such a guild.
  const channelAdmitted =
    voiceChannelIds.size === 0 || (channelId !== undefined && voiceChannelIds.has(channelId));
  add(
    "target voice channel",
    channelId !== undefined && guildId !== undefined && voiceGuildIds.has(guildId) && channelAdmitted,
    channelId === undefined
      ? "missing or invalid"
      : voiceGuildIds.has(guildId ?? "") && channelAdmitted
        ? voiceChannelIds.size === 0
          ? "admitted (every channel in the guild is allowlisted)"
          : "configured and allowlisted"
        : "live-proof target is outside the configured voice allowlist",
    "Set DISCORD_VOICE_CHANNEL_ID and include its guild in DISCORD_VOICE_GUILD_IDS.",
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
      "Start the clankie service once so it can mint the local Discord voice bridge identity.",
    );
  } catch (error) {
    add(
      "bridge identity",
      false,
      error instanceof Error ? error.message : "stored bridge identity is invalid",
      "Replace the malformed clankie_discord_voice_bridge broker entry by restarting the clankie service.",
    );
  }

  // The realtime configuration is validated exactly as the bridge validates it
  // at startup: truncation and idle auto-leave are configured, never unbounded.
  let realtimeConfig: VoiceRealtimeEnvConfig | undefined;
  try {
    realtimeConfig = parseVoiceRealtimeEnv(options.env);
    const mouth =
      realtimeConfig.ttsProvider === "elevenlabs"
        ? `elevenlabs TTS ${realtimeConfig.elevenLabsVoiceId ?? ""}`
        : realtimeConfig.voice;
    const context =
      realtimeConfig.realtimeProvider === "xai"
        ? "provider-managed context"
        : `truncation ${String(realtimeConfig.truncationRetentionRatio)} retention / ` +
          `${String(realtimeConfig.postInstructionsTokenLimit)} post-instructions tokens`;
    add(
      "realtime configuration",
      true,
      `${realtimeConfig.realtimeProvider}/${realtimeConfig.realtimeProvider === "xai" ? "streaming-stt" : realtimeConfig.transcribeModel} listener, ` +
        `${realtimeConfig.realtimeModel}/${mouth} engaged session, ${context}`,
      "",
    );
  } catch (error) {
    add(
      "realtime configuration",
      false,
      error instanceof Error ? error.message : "realtime voice environment is invalid",
      "Correct the CLANKIE_VOICE_* realtime environment variables.",
    );
  }
  const provider = realtimeConfig?.realtimeProvider ?? DEFAULT_VOICE_REALTIME_PROVIDER;
  const realtimeCredential = await options.store.get(provider);
  const realtimeKey = realtimeCredential?.type === "api" ? realtimeCredential.key : undefined;
  add(
    `${provider} realtime credential`,
    realtimeKey !== undefined,
    realtimeKey === undefined
      ? `broker entry ${provider} is missing or is not an API credential`
      : "present in broker",
    `Store the ${provider} API key under provider ${provider}; do not put it in the environment.`,
  );
  // Only when the external voice is configured: readiness must fail the same
  // way the bridge startup gate would, before a call ever depends on it.
  if (realtimeConfig?.ttsProvider === "elevenlabs") {
    const elevenLabsCredential = await options.store.get("elevenlabs");
    const elevenLabsKey = elevenLabsCredential?.type === "api" ? elevenLabsCredential.key : undefined;
    add(
      "ElevenLabs voice credential",
      elevenLabsKey !== undefined,
      elevenLabsKey === undefined
        ? "broker entry elevenlabs is missing or is not an API credential"
        : "present in broker",
      "Store the ElevenLabs API key under provider elevenlabs via /auth; do not put it in the environment.",
    );
  }

  let voxProbe: VoxProcessProbeResult;
  try {
    voxProbe = await (options.voxProbe ?? (() => probeVoxProcess({ env: options.env })))();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Vox process smoke failed";
    voxProbe = {
      binaryResolved: false,
      binaryDetail: detail,
      processReady: false,
      processDetail: detail,
    };
  }
  add(
    "Vox binary",
    voxProbe.binaryResolved,
    voxProbe.binaryDetail,
    "Run pnpm --filter @clankie/vox build or set CLANKIE_VOX_BIN to the owned Vox executable.",
  );
  add(
    "Vox process",
    voxProbe.processReady,
    voxProbe.processDetail,
    "Run the Vox binary directly and resolve any startup error before joining Discord voice.",
  );

  try {
    const readiness = await options.api.inspectDiscordReadiness();
    const ready = readiness.ready && Object.values(readiness.checks).every(Boolean);
    add(
      "service composition",
      ready,
      ready
        ? "Clankie's lane and event store are ready"
        : "the service's Discord dependencies are incomplete",
      "Start the clankie service before the bridge.",
    );
  } catch (error) {
    add(
      "service composition",
      false,
      error instanceof Error ? error.message : "service readiness request failed",
      "Start the clankie service on CLANKIE_API_URL.",
    );
  }

  // The briefing path end-to-end (T4→T6): the service composes
  // instructions and a projection for the configured channel with zero
  // consented ids, so nobody's person memory is touched by a readiness run.
  let voiceInstructions: string | undefined;
  if (guildId !== undefined && channelId !== undefined) {
    try {
      const briefing = await options.api.fetchDiscordVoiceBriefing({
        schemaVersion: 1,
        guildId,
        channelId,
        consentedUserIds: [],
      });
      voiceInstructions = briefing.instructions;
      add(
        "voice briefing endpoint",
        true,
        `the service composed ${String(briefing.instructions.length)} instruction and ` +
          `${String(briefing.briefing.length)} briefing character(s)`,
        "",
      );
    } catch (error) {
      add(
        "voice briefing endpoint",
        false,
        error instanceof Error ? error.message : "voice briefing request failed",
        "Start the clankie service with the Discord voice briefing route and a valid voice bridge identity.",
      );
    }
  } else {
    add(
      "voice briefing endpoint",
      false,
      "not checked because the target guild or voice channel is missing",
      "Resolve the target guild and voice channel checks first.",
    );
  }

  // The wake transition is a new failure surface (ADR 0057): a dropped wake
  // means he ignores someone who addressed him. Readiness therefore exercises
  // dormant→engaged — a real listener session, then a real conversation
  // session — not just one session round trip.
  const wakeProbe =
    options.wakeProbe ??
    (realtimeKey !== undefined && realtimeConfig !== undefined && voiceInstructions !== undefined
      ? buildDefaultWakeProbe(realtimeKey, realtimeConfig, voiceInstructions)
      : undefined);
  if (wakeProbe === undefined) {
    const detail = `not checked because the brokered ${provider} credential, realtime configuration, or voice briefing is missing`;
    const remediation = `Resolve the ${provider} realtime credential, configuration, and voice briefing checks first.`;
    add("listener session", false, detail, remediation);
    add("engaged session", false, detail, remediation);
    add("captain capability routing", false, detail, remediation);
    add("wake transition", false, detail, remediation);
  } else {
    let probe: VoiceWakeTransitionProbeResult;
    try {
      probe = await wakeProbe();
    } catch (error) {
      const detail = error instanceof Error ? error.message : "wake transition probe failed";
      probe = {
        listener: { ok: false, detail },
        engaged: { ok: false, detail },
        capability: { ok: false, detail },
      };
    }
    add(
      "listener session",
      probe.listener.ok,
      probe.listener.detail,
      `Verify the brokered ${provider} credential has voice API access.`,
    );
    add(
      "engaged session",
      probe.engaged.ok,
      probe.engaged.detail,
      `Verify the brokered ${provider} credential has access to the configured realtime model.`,
    );
    add(
      "captain capability routing",
      probe.capability.ok,
      probe.capability.detail,
      "Verify the voice briefing presents ask_clankie as Clankie's own route to web browsing and other captain tools.",
    );
    add(
      "wake transition",
      probe.listener.ok && probe.engaged.ok,
      probe.listener.ok && probe.engaged.ok
        ? "dormant listener and engaged session opened in sequence"
        : "the dormant to engaged transition could not be exercised",
      "Resolve the listener and engaged session checks first.",
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
      // Membership is probed by fetching the guild itself: it returns 404
      // "Unknown Guild" to a bot that is not installed. The obvious-looking
      // alternatives are both wrong here — `/guilds/{id}/members/@me` coerces
      // user_id to a snowflake and rejects `@me`, and
      // `/users/@me/guilds/{id}/member` is OAuth2-only ("Bots cannot use this
      // endpoint").
      await rest.get(Routes.guild(guildId));
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
    realtime: {
      provider: realtimeConfig?.realtimeProvider ?? DEFAULT_VOICE_REALTIME_PROVIDER,
      transcribeModel:
        (realtimeConfig?.realtimeProvider ?? provider) === "xai"
          ? "xai-streaming-stt"
          : (realtimeConfig?.transcribeModel ?? DEFAULT_VOICE_TRANSCRIBE_MODEL),
      realtimeModel:
        realtimeConfig?.realtimeModel ??
        (provider === "xai" ? DEFAULT_XAI_VOICE_REALTIME_MODEL : DEFAULT_VOICE_REALTIME_MODEL),
      voice:
        realtimeConfig?.voice ??
        (provider === "xai" ? DEFAULT_XAI_VOICE_REALTIME_VOICE : DEFAULT_VOICE_REALTIME_VOICE),
      ttsProvider: realtimeConfig?.ttsProvider ?? DEFAULT_VOICE_TTS_PROVIDER,
      ...(realtimeConfig?.elevenLabsVoiceId === undefined
        ? {}
        : { elevenLabsVoiceId: realtimeConfig.elevenLabsVoiceId }),
      ...(realtimeConfig?.elevenLabsModelId === undefined
        ? {}
        : { elevenLabsModelId: realtimeConfig.elevenLabsModelId }),
      ...(provider === "openai"
        ? {
            truncationRetentionRatio:
              realtimeConfig?.truncationRetentionRatio ?? DEFAULT_VOICE_TRUNCATION_RETENTION,
            postInstructionsTokenLimit:
              realtimeConfig?.postInstructionsTokenLimit ?? DEFAULT_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT,
          }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The live wake-transition probe.
// ---------------------------------------------------------------------------

export interface VoiceWakeTransitionProbeOptions {
  /** Broker-resolved OpenAI key. */
  readonly apiKey: string;
  readonly config: VoiceRealtimeEnvConfig;
  /** The same service-composed instructions used by the live voice room. */
  readonly instructions?: string;
  /** Injected by tests; production uses the runtime's WebSocket factory. */
  readonly socketFactory?: RealtimeSocketFactory;
  readonly timers?: RealtimeTimers;
  /** Per-stage cap. A probe must never hang readiness. */
  readonly timeoutMs?: number;
}

const WAKE_PROBE_TIMEOUT_MS = 20_000;
const WAKE_PROBE_INSTRUCTIONS =
  "You are Clankie. Use ask_clankie as your own captain mind for every action or lookup outside this conversation.";
const WAKE_PROBE_ITEM =
  "Readiness probe: use your web browsing ability to look up the current weather in Chicago. Do not answer from memory.";

/**
 * Exercises the dormant→engaged wake transition against the live Realtime API:
 * opens a real transcription session and waits for a clean open, then — with
 * the listener still connected, exactly like a wake — opens a real
 * conversation session with the live room instructions, sends one web-lookup
 * item plus one `response.create`, and requires the response to select
 * `ask_clankie`. The
 * runtime's byte caps bound everything received; audio deltas are zeroed on
 * arrival and nothing content-bearing enters the result.
 */
export async function probeVoiceWakeTransition(
  options: VoiceWakeTransitionProbeOptions,
): Promise<VoiceWakeTransitionProbeResult> {
  const timeoutMs = options.timeoutMs ?? WAKE_PROBE_TIMEOUT_MS;
  const injected = {
    ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  };
  let listener: { close(): void } | undefined;
  let listenerStage: VoiceWakeProbeStage;
  let engagedStage: VoiceWakeProbeStage = {
    ok: false,
    detail: "not attempted because the listener session failed",
  };
  let capabilityStage: VoiceWakeProbeStage = {
    ok: false,
    detail: "not attempted because the listener session failed",
  };
  try {
    const openListener: Promise<{ close(): void }> =
      options.config.realtimeProvider === "xai"
        ? openXaiStreamingTranscriptionSession({
            apiKey: options.apiKey,
            ...(options.config.language === undefined ? {} : { language: options.config.language }),
            ...injected,
            onTranscript: () => undefined,
          })
        : openRealtimeTranscriptionSession({
            apiKey: options.apiKey,
            model: options.config.transcribeModel,
            ...(options.config.language === undefined ? {} : { language: options.config.language }),
            ...injected,
            onTranscript: () => undefined,
          });
    listener = await withTimeout(openListener, timeoutMs, "listener session open timed out");
    listenerStage = { ok: true, detail: "dormant transcription session opened cleanly" };
  } catch (error) {
    listenerStage = {
      ok: false,
      detail: error instanceof Error ? error.message : "listener session open failed",
    };
  }
  if (listenerStage.ok) {
    try {
      let settle: (() => void) | undefined;
      let capabilityCalled = false;
      const responded = new Promise<void>((resolvePromise) => {
        settle = resolvePromise;
      });
      // Under the external voice (ADR 0070) the engaged session runs in text
      // modality, so the probe settles on text exactly as the runtime speaks
      // it. The ElevenLabs socket is deliberately not probed — its credential
      // is checked separately, and a readiness run should not spend paid
      // synthesis to prove connectivity the first utterance will prove anyway.
      const textModality = options.config.ttsProvider === "elevenlabs";
      const engaged = await withTimeout(
        openRealtimeConversationSession({
          apiKey: options.apiKey,
          model: options.config.realtimeModel,
          ...(options.config.realtimeProvider === "xai"
            ? {
                provider: "xai" as const,
                baseUrl: XAI_REALTIME_BASE_URL,
                reasoningEffort: options.config.xaiReasoningEffort ?? "high",
              }
            : {}),
          ...(textModality ? { outputModality: "text" as const } : { voice: options.config.voice }),
          instructions: options.instructions ?? WAKE_PROBE_INSTRUCTIONS,
          truncationRetentionRatio: options.config.truncationRetentionRatio,
          postInstructionsTokenLimit: options.config.postInstructionsTokenLimit,
          ...injected,
          onAudioDelta: (pcm) => {
            pcm.fill(0);
          },
          ...(textModality
            ? {
                onTextDelta: () => undefined,
              }
            : {}),
          onResponseDone: () => {
            settle?.();
          },
          onFunctionCall: (call) => {
            if (call.name !== ASK_CLANKIE_TOOL_NAME) return;
            capabilityCalled = true;
            settle?.();
          },
        }),
        timeoutMs,
        "engaged session open timed out",
      );
      try {
        engaged.createTextItem(WAKE_PROBE_ITEM);
        engaged.createResponse();
        await withTimeout(responded, timeoutMs, "engaged session produced no response");
        engagedStage = { ok: true, detail: "conversation session opened and produced a response" };
        capabilityStage = capabilityCalled
          ? { ok: true, detail: "web lookup routed through ask_clankie" }
          : { ok: false, detail: "realtime model answered a web lookup without ask_clankie" };
      } finally {
        try {
          engaged.close();
        } catch {
          // Already closed; the probe result stands either way.
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "engaged session probe failed";
      engagedStage = {
        ok: false,
        detail,
      };
      capabilityStage = { ok: false, detail };
    }
  }
  try {
    listener?.close();
  } catch {
    // Already closed; the probe result stands either way.
  }
  return { listener: listenerStage, engaged: engagedStage, capability: capabilityStage };
}

function buildDefaultWakeProbe(
  apiKey: string,
  config: VoiceRealtimeEnvConfig,
  instructions: string,
): VoiceWakeTransitionProbe {
  return () => probeVoiceWakeTransition({ apiKey, config, instructions });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolvePromise(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}
