import { SettingsStore, resolveVoiceSettings, type VoiceSettings } from "@clankie/settings";
import type { RedactedCredential } from "@clankie/credential-broker";
import type { ClankieFaceShell, FaceShellCommand } from "./shell/shell.ts";

export interface VoiceCommandServices {
  settings: SettingsStore;
  /** Redacted view of what the credential broker already holds. */
  listCredentials: () => Promise<Record<string, RedactedCredential>>;
  removeCredential: (providerId: string) => Promise<unknown>;
  /**
   * Stores a secret in the credential broker. The ElevenLabs key never
   * touches settings.json — `/voice` writes to the same broker entry the
   * featured `elevenlabs` provider in `/auth` manages, so an operator can
   * finish voice setup without leaving this wizard.
   */
  setCredential: (providerId: string, key: string) => Promise<void>;
}

const ELEVENLABS_PROVIDER_ID = "elevenlabs";
const VENDOR_IDENTIFIER = /^[\w-]{1,128}$/u;

/**
 * `/voice` edits **how Clankie sounds** in a voice channel
 * ([ADR 0070](../../../docs/adr/0070-external-voice-via-streaming-tts.md)):
 * the realtime model's own voice, or an ElevenLabs voice streamed from the
 * model's words. Like `/persona`, this is character, not authority — nothing
 * here widens what voice may do.
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

export function describeVoice(settings: VoiceSettings, elevenLabsKeyStored: boolean): string[] {
  if (settings.ttsProvider === "elevenlabs") {
    return [
      "voice: ElevenLabs (model text streamed through ElevenLabs TTS)",
      `  voice id: ${settings.elevenLabsVoiceId ?? "— (required)"}`,
      `  model: ${settings.elevenLabsModelId ?? "eleven_flash_v2_5 (runtime default)"}`,
      `  API key: ${elevenLabsKeyStored ? "stored in the credential broker (redacted)" : "MISSING — store it under provider elevenlabs"}`,
    ];
  }
  return [`voice: OpenAI realtime "${settings.openAiVoice ?? "marin"}" (the model speaks natively)`];
}

async function showVoiceStatus(shell: ClankieFaceShell, services: VoiceCommandServices): Promise<void> {
  const stored = await services.settings.load();
  const resolved = resolveVoiceSettings(stored.voice);
  const credentials = await services.listCredentials();
  const lines = [
    `settings file: ${services.settings.path}`,
    "",
    ...describeVoice(resolved.settings, ELEVENLABS_PROVIDER_ID in credentials),
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
            label: "How he sounds",
            hint: "OpenAI realtime or ElevenLabs",
            description: "The realtime model's own voice, or an ElevenLabs voice speaking his words.",
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

async function editProvider(shell: ClankieFaceShell, services: VoiceCommandServices): Promise<void> {
  const flow = shell.setupFlow;
  const current = (await services.settings.load()).voice;

  const provider = await flow.readSelect({
    kind: "single",
    message: "Who synthesizes his speech?",
    options: [
      {
        value: "openai",
        label: "OpenAI realtime voice",
        hint: "default",
        description: "The realtime model speaks natively — lowest latency, fixed voice list.",
      },
      {
        value: "elevenlabs",
        label: "ElevenLabs voice",
        hint: "custom voice",
        description:
          "The model writes text and ElevenLabs speaks it. Only his own words go to ElevenLabs — never room audio.",
      },
    ],
    required: true,
  });
  const providerChoice = provider?.[0];
  if (providerChoice === undefined) return;

  if (providerChoice === "openai") {
    const voice = await flow.readText({
      message: "OpenAI realtime voice name (blank keeps the current one)",
      placeholder: current.openAiVoice ?? "marin",
      validate: (value: string) => (value.trim().length > 64 ? "Keep it under 64 characters." : undefined),
    });
    if (voice === undefined) return;
    await apply(services, (settings) => ({
      ...settings,
      ttsProvider: "openai",
      ...(voice.trim().length > 0 ? { openAiVoice: voice.trim() } : {}),
    }));
    flow.renderLine("Saved. Restart the bridge to apply.", "success");
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
    ttsProvider: "elevenlabs",
    elevenLabsVoiceId: resolvedVoiceId,
    ...(modelId.trim().length > 0 ? { elevenLabsModelId: modelId.trim() } : {}),
  }));
  flow.renderLine("Saved. Restart the bridge to apply.", "success");

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
  const flow = shell.setupFlow;
  const stored = await services.listCredentials();

  const existing = stored[ELEVENLABS_PROVIDER_ID];
  if (existing !== undefined) {
    const decision = await flow.readSelect({
      kind: "single",
      message: `elevenlabs is already stored — ${existing.type} credential (redacted)`,
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
      await services.removeCredential(ELEVENLABS_PROVIDER_ID);
      flow.renderLine("Removed elevenlabs from the credential broker.", "success");
      return;
    }
  }

  // readSecret keeps the value off the rendered transcript; the broker
  // redacts it thereafter. It is never written to settings.json.
  const key = await flow.readSecret({
    message: "ElevenLabs API key",
    validate: (value: string) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) return "Required.";
      if (/\s/u.test(trimmed)) return "A key contains no whitespace — check for a stray paste.";
      return undefined;
    },
  });
  if (key === undefined) return;

  await services.setCredential(ELEVENLABS_PROVIDER_ID, key.trim());
  flow.renderLine("Stored elevenlabs in the credential broker (redacted).", "success");
}
