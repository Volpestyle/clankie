import { SettingsStore, resolveVoiceSettings, type VoiceSettings } from "@clankie/settings";
import type { RedactedCredential } from "@clankie/credential-broker";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface VoiceCommandServices {
  settings: SettingsStore;
  /** Redacted view of what the credential broker already holds. */
  listCredentials: () => Promise<Record<string, RedactedCredential>>;
  removeCredential: (providerId: string) => Promise<unknown>;
  /**
   * Stores a voice-vendor secret in the credential broker. `/voice` writes to
   * the same `openai`, `xai`, and `elevenlabs` entries `/auth` manages; keys
   * never touch settings.json.
   */
  setCredential: (providerId: string, key: string) => Promise<void>;
}

const ELEVENLABS_PROVIDER_ID = "elevenlabs";
const OPENAI_PROVIDER_ID = "openai";
const XAI_PROVIDER_ID = "xai";
const DEFAULT_OPENAI_REALTIME_MODEL = "gpt-realtime-2.1";
const DEFAULT_OPENAI_TRANSCRIBE_MODEL = "gpt-realtime-whisper";
const DEFAULT_XAI_REALTIME_MODEL = "grok-voice-think-fast-2.0";
const VENDOR_IDENTIFIER = /^[\w-]{1,128}$/u;
const MODEL_IDENTIFIER = /^[\w.-]{1,128}$/u;

/**
 * `/voice` selects the realtime provider and how Clankie sounds in a voice
 * channel ([ADR 0113](../../../docs/adr/0113-one-voice-port-has-multiple-realtime-providers.md)).
 * Like `/persona`, this is character, not authority — nothing here widens what
 * voice may do.
 */
export function buildVoiceCommands(services: VoiceCommandServices): FaceShellCommand[] {
  return [
    {
      name: "voice",
      aliases: [],
      description: "Configure how Clankie sounds in Discord voice",
      argumentHint: "[status]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        if (argument.trim() === "status") {
          await showVoiceStatus(shell, services);
          return;
        }
        await runVoiceWizard(shell, services);
      },
    },
  ];
}

/** Public identifier only; the shape the runtime embeds in a URL path. */
export function validateVendorIdentifier(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "Required.";
  if (!VENDOR_IDENTIFIER.test(trimmed)) {
    return "Use at most 128 letters, digits, underscores, or hyphens.";
  }
  return undefined;
}

export function describeVoice(
  settings: VoiceSettings,
  realtimeKeyStored: boolean,
  elevenLabsKeyStored: boolean,
): string[] {
  const realtime =
    settings.realtimeProvider === "xai"
      ? [
          `realtime: xAI ${settings.xAiRealtimeModel ?? DEFAULT_XAI_REALTIME_MODEL}`,
          `  voice: ${settings.xAiVoice ?? "eve"}`,
          `  reasoning: ${settings.xAiReasoningEffort}`,
        ]
      : [
          `realtime: OpenAI ${settings.openAiRealtimeModel ?? DEFAULT_OPENAI_REALTIME_MODEL}`,
          `  transcriber: ${settings.openAiTranscribeModel ?? DEFAULT_OPENAI_TRANSCRIBE_MODEL}`,
          `  voice: ${settings.openAiVoice ?? "marin"}`,
        ];
  realtime.push(
    `  API key: ${realtimeKeyStored ? "stored in the credential broker (redacted)" : `MISSING — store it under provider ${settings.realtimeProvider}`}`,
  );
  if (settings.ttsProvider === "elevenlabs") {
    return [
      ...realtime,
      "spoken replies: ElevenLabs (model text streamed through ElevenLabs TTS)",
      `  voice id: ${settings.elevenLabsVoiceId ?? "— (required)"}`,
      `  model: ${settings.elevenLabsModelId ?? "eleven_flash_v2_5 (runtime default)"}`,
      `  API key: ${elevenLabsKeyStored ? "stored in the credential broker (redacted)" : "MISSING — store it under provider elevenlabs"}`,
    ];
  }
  return [...realtime, "spoken replies: the realtime model speaks natively"];
}

async function showVoiceStatus(shell: ClankieFaceShell, services: VoiceCommandServices): Promise<void> {
  const stored = await services.settings.load();
  const resolved = resolveVoiceSettings(stored.voice);
  const credentials = await services.listCredentials();
  const lines = [
    `settings file: ${services.settings.path}`,
    "",
    ...describeVoice(
      resolved.settings,
      resolved.settings.realtimeProvider in credentials &&
        credentials[resolved.settings.realtimeProvider]?.type === "api",
      ELEVENLABS_PROVIDER_ID in credentials,
    ),
  ];
  if (resolved.overriddenByEnvironment.length > 0) {
    lines.push("", `overridden by environment: ${resolved.overriddenByEnvironment.join(", ")}`);
  }
  shell.insertCommandResult("/voice status", lines.join("\n"), "success");
}

async function runVoiceWizard(shell: ClankieFaceShell, services: VoiceCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("voice");
  try {
    for (;;) {
      const action = await flow.readSelect({
        kind: "single",
        message: "Voice",
        options: [
          {
            value: "provider",
            label: "Voice stack",
            hint: "OpenAI, Grok, or ElevenLabs",
            description: "Choose the realtime agent, model, voice, and optional external speech output.",
          },
          {
            value: "realtime-credential",
            label: "Realtime API key",
            hint: "broker-owned",
            description: "Store the selected OpenAI or xAI API key without leaving this wizard.",
          },
          {
            value: "credential",
            label: "ElevenLabs API key",
            hint: "broker-owned",
            description: "Stored in the credential broker under provider elevenlabs, never in settings.",
          },
          { value: "status", label: "Show status" },
          { value: "done", label: "Done" },
        ],
        required: true,
      });
      const choice = action?.[0];
      if (choice === undefined || choice === "done") break;
      if (choice === "status") {
        await showVoiceStatus(shell, services);
        continue;
      }
      if (choice === "provider") await editProvider(shell, services);
      else if (choice === "realtime-credential") await editRealtimeCredential(shell, services);
      else if (choice === "credential") await editElevenLabsCredential(shell, services);
    }
  } finally {
    flow.end();
  }
}

async function apply(
  services: VoiceCommandServices,
  patch: (current: VoiceSettings) => VoiceSettings,
): Promise<void> {
  await services.settings.update((current) => ({
    ...current,
    voice: patch(current.voice),
  }));
}

function readModel(
  flow: ClankieFaceShell["setupFlow"],
  message: string,
  placeholder: string,
): Promise<string | undefined> {
  return flow.readText({
    message,
    placeholder,
    validate: (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0 || MODEL_IDENTIFIER.test(trimmed)) return undefined;
      return "Use at most 128 letters, digits, dots, underscores, or hyphens.";
    },
  });
}

async function editProvider(shell: ClankieFaceShell, services: VoiceCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).voice;

  const provider = await flow.readSelect({
    kind: "single",
    message: "Which voice stack should Clankie use?",
    options: [
      {
        value: "openai",
        label: "OpenAI realtime",
        hint: "default",
        description: "OpenAI transcribes, reasons, and speaks with its native realtime voice.",
      },
      {
        value: "xai",
        label: "Grok Voice",
        hint: "xAI native",
        description: "xAI streaming STT wakes a Grok Voice agent that speaks with an xAI voice.",
      },
      {
        value: "elevenlabs",
        label: "ElevenLabs voice",
        hint: "custom voice",
        description:
          "OpenAI realtime writes text and ElevenLabs speaks it; room audio never reaches ElevenLabs.",
      },
    ],
    required: true,
  });
  const providerChoice = provider?.[0];
  if (providerChoice === undefined) return;

  if (providerChoice === "openai") {
    const model = await readModel(
      flow,
      "OpenAI realtime model (blank keeps the current/default)",
      current.openAiRealtimeModel ?? DEFAULT_OPENAI_REALTIME_MODEL,
    );
    if (model === undefined) return;
    const transcriber = await readModel(
      flow,
      "OpenAI transcription model (blank keeps the current/default)",
      current.openAiTranscribeModel ?? DEFAULT_OPENAI_TRANSCRIBE_MODEL,
    );
    if (transcriber === undefined) return;
    const voice = await flow.readText({
      message: "OpenAI realtime voice name (blank keeps the current one)",
      placeholder: current.openAiVoice ?? "marin",
      validate: (value: string) => (value.trim().length > 64 ? "Keep it under 64 characters." : undefined),
    });
    if (voice === undefined) return;
    await apply(services, (settings) => ({
      ...settings,
      realtimeProvider: "openai",
      ttsProvider: "openai",
      ...(model.trim().length > 0 ? { openAiRealtimeModel: model.trim() } : {}),
      ...(transcriber.trim().length > 0 ? { openAiTranscribeModel: transcriber.trim() } : {}),
      ...(voice.trim().length > 0 ? { openAiVoice: voice.trim() } : {}),
    }));
    flow.renderLine("Saved. Restart the bridge to apply.", "success");
    await offerMissingRealtimeCredential(shell, services, OPENAI_PROVIDER_ID);
    return;
  }

  if (providerChoice === "xai") {
    const model = await readModel(
      flow,
      "Grok Voice model (blank keeps the current/default)",
      current.xAiRealtimeModel ?? DEFAULT_XAI_REALTIME_MODEL,
    );
    if (model === undefined) return;
    const voice = await flow.readText({
      message: "xAI voice id (blank keeps the current/default)",
      placeholder: current.xAiVoice ?? "eve",
      validate: (value: string) => (value.trim().length === 0 ? undefined : validateVendorIdentifier(value)),
    });
    if (voice === undefined) return;
    const reasoning = await flow.readSelect({
      kind: "single",
      message: "Grok Voice reasoning",
      options: [
        { value: "high", label: "High", hint: "default" },
        { value: "none", label: "None", hint: "lowest latency" },
      ],
      required: true,
    });
    const reasoningChoice = reasoning?.[0];
    if (reasoningChoice !== "high" && reasoningChoice !== "none") return;
    await apply(services, (settings) => ({
      ...settings,
      realtimeProvider: "xai",
      ttsProvider: "openai",
      xAiReasoningEffort: reasoningChoice,
      ...(model.trim().length > 0 ? { xAiRealtimeModel: model.trim() } : {}),
      ...(voice.trim().length > 0 ? { xAiVoice: voice.trim() } : {}),
    }));
    flow.renderLine("Saved. Restart the active Discord body to apply.", "success");
    await offerMissingRealtimeCredential(shell, services, XAI_PROVIDER_ID);
    return;
  }

  const voiceId = await flow.readText({
    message: "ElevenLabs voice id (from the ElevenLabs voice library)",
    placeholder: current.elevenLabsVoiceId ?? "",
    validate: (value: string) =>
      value.trim().length === 0 && current.elevenLabsVoiceId !== undefined
        ? undefined
        : validateVendorIdentifier(value),
  });
  if (voiceId === undefined) return;
  const resolvedVoiceId = voiceId.trim().length > 0 ? voiceId.trim() : current.elevenLabsVoiceId;
  if (resolvedVoiceId === undefined) {
    flow.renderLine("An ElevenLabs voice id is required; nothing was changed.", "error");
    return;
  }

  const modelId = await flow.readText({
    message: "ElevenLabs model id (blank keeps the runtime default)",
    placeholder: current.elevenLabsModelId ?? "eleven_flash_v2_5",
    validate: (value: string) => (value.trim().length === 0 ? undefined : validateVendorIdentifier(value)),
  });
  if (modelId === undefined) return;

  await apply(services, (settings) => ({
    ...settings,
    realtimeProvider: "openai",
    ttsProvider: "elevenlabs",
    elevenLabsVoiceId: resolvedVoiceId,
    ...(modelId.trim().length > 0 ? { elevenLabsModelId: modelId.trim() } : {}),
  }));
  flow.renderLine("Saved. Restart the bridge to apply.", "success");
  await offerMissingRealtimeCredential(shell, services, OPENAI_PROVIDER_ID);

  // The provider is settings; the key is broker. Finish the thought here so
  // an operator is never left with a configured voice that cannot speak.
  const credentials = await services.listCredentials();
  if (!(ELEVENLABS_PROVIDER_ID in credentials)) {
    flow.renderLine(
      "No ElevenLabs API key is stored yet — without it the bridge refuses to start voice.",
      "warning",
    );
    await editElevenLabsCredential(shell, services);
  }
}

async function editElevenLabsCredential(
  shell: ClankieFaceShell,
  services: VoiceCommandServices,
): Promise<void> {
  await editApiCredential(shell, services, ELEVENLABS_PROVIDER_ID, "ElevenLabs");
}

async function editRealtimeCredential(
  shell: ClankieFaceShell,
  services: VoiceCommandServices,
): Promise<void> {
  const provider = (await services.settings.load()).voice.realtimeProvider;
  await editApiCredential(shell, services, provider, provider === "xai" ? "xAI" : "OpenAI");
}

async function offerMissingRealtimeCredential(
  shell: ClankieFaceShell,
  services: VoiceCommandServices,
  providerId: "openai" | "xai",
): Promise<void> {
  const credential = (await services.listCredentials())[providerId];
  if (credential?.type === "api") return;
  shell.setupFlow.renderLine(
    `No ${providerId} API key is stored yet — voice cannot start without one.`,
    "warning",
  );
  await editApiCredential(shell, services, providerId, providerId === "xai" ? "xAI" : "OpenAI");
}

async function editApiCredential(
  shell: ClankieFaceShell,
  services: VoiceCommandServices,
  providerId: string,
  label: string,
): Promise<void> {
  const flow = shell.setupFlow;
  const stored = await services.listCredentials();

  const existing = stored[providerId];
  if (existing !== undefined) {
    const decision = await flow.readSelect({
      kind: "single",
      message: `${providerId} is already stored — ${existing.type} credential (redacted)`,
      options: [
        { value: "keep", label: "Keep it", hint: "no change" },
        { value: "replace", label: "Replace it", hint: "enter a new key" },
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

  // readSecret keeps the value off the rendered transcript; the broker
  // redacts it thereafter. It is never written to settings.json.
  const key = await flow.readSecret({
    message: `${label} API key`,
    validate: (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "Required.";
      if (/\s/u.test(trimmed)) return "A key contains no whitespace — check for a stray paste.";
      return undefined;
    },
  });
  if (key === undefined) return;

  await services.setCredential(providerId, key.trim());
  flow.renderLine(`Stored ${providerId} in the credential broker (redacted).`, "success");
}
