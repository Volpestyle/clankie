import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { RedactedCredential } from "@clankie/credential-broker";
import type { SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell, FaceShellCommand } from "../src/shell/shell.ts";
import {
  buildVoiceCommands,
  describeVoice,
  validateVendorIdentifier,
  type VoiceCommandServices,
} from "../src/voice-commands.ts";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface CommandResult {
  readonly command: string;
  readonly text: string;
  readonly tone: string;
}

function testShell(
  selections: Array<string[] | undefined>,
  secrets: Array<string | undefined> = [],
  texts: Array<string | undefined> = [],
): {
  readonly lines: string[];
  readonly results: CommandResult[];
  readonly shell: ClankieFaceShell;
} {
  const results: CommandResult[] = [];
  const lines: string[] = [];
  const flow: SetupFlow = {
    begin: () => {},
    end: () => {},
    readSelect: async () => selections.shift(),
    readSecret: async (options) => {
      for (;;) {
        const value = secrets.shift();
        if (value === undefined) return undefined;
        if (options.validate?.(value) === undefined) return value;
      }
    },
    readText: async () => texts.shift(),
    renderLine: (text) => {
      lines.push(text);
    },
    setStatus: () => {},
    waitForInterrupt: () => ({ promise: new Promise<void>(() => {}), dispose: () => {} }),
  };
  const shell = {
    setupFlow: flow,
    insertCommandResult(command: string, text: string, tone: string): void {
      results.push({ command, text, tone });
    },
  } as unknown as ClankieFaceShell;
  return { lines, results, shell };
}

async function testServices(): Promise<{
  readonly credentials: Map<string, { type: "api"; key: string }>;
  readonly services: VoiceCommandServices;
  readonly settings: SettingsStore;
}> {
  const root = await mkdtemp(join(tmpdir(), "clankie-voice-commands-"));
  tempDirs.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new Map<string, { type: "api"; key: string }>();
  return {
    credentials,
    settings,
    services: {
      settings,
      listCredentials: () => {
        const redacted: Record<string, RedactedCredential> = {};
        for (const [id, credential] of credentials) {
          redacted[id] = { type: credential.type, key: `${credential.key.slice(0, 4)}…` };
        }
        return Promise.resolve(redacted);
      },
      setCredential: (providerId, key) => {
        credentials.set(providerId, { type: "api", key });
        return Promise.resolve();
      },
      removeCredential: (providerId) => {
        credentials.delete(providerId);
        return Promise.resolve();
      },
    },
  };
}

function command(commands: readonly FaceShellCommand[], name: string): FaceShellCommand {
  const found = commands.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`Missing /${name} command`);
  return found;
}

describe("/voice", () => {
  it("selects the ElevenLabs provider end to end, including the broker-owned key", async () => {
    const { credentials, services, settings } = await testServices();
    const voice = command(buildVoiceCommands(services), "voice");
    const view = testShell(
      // wizard: provider step → done; the missing-key follow-up asks nothing
      // (readSecret consumes from `secrets`).
      [["provider"], ["elevenlabs"], ["done"]],
      ["sk-openai", "xi-secret-key"],
      ["voice_abc123", "eleven_flash_v2_5"],
    );
    await voice.run("", view.shell);

    const stored = await settings.load();
    expect(stored.voice).toMatchObject({
      realtimeProvider: "openai",
      ttsProvider: "elevenlabs",
      elevenLabsVoiceId: "voice_abc123",
      elevenLabsModelId: "eleven_flash_v2_5",
    });
    // The key went to the broker, never to settings.json.
    expect(credentials.get("elevenlabs")).toEqual({ type: "api", key: "xi-secret-key" });
    expect(credentials.get("openai")).toEqual({ type: "api", key: "sk-openai" });
    expect(JSON.stringify(stored)).not.toContain("xi-secret-key");
    expect(view.lines.join("\n")).toContain("Restart the bridge to apply");
  });

  it("configures OpenAI models, voice, and broker-owned key", async () => {
    const { credentials, services, settings } = await testServices();
    const voice = command(buildVoiceCommands(services), "voice");
    const view = testShell(
      [["provider"], ["openai"], ["done"]],
      ["sk-openai"],
      ["gpt-realtime-2.1", "gpt-realtime-whisper", "cedar"],
    );
    await voice.run("", view.shell);

    const stored = await settings.load();
    expect(stored.voice.ttsProvider).toBe("openai");
    expect(stored.voice.realtimeProvider).toBe("openai");
    expect(stored.voice.openAiRealtimeModel).toBe("gpt-realtime-2.1");
    expect(stored.voice.openAiTranscribeModel).toBe("gpt-realtime-whisper");
    expect(stored.voice.openAiVoice).toBe("cedar");
    expect(credentials.get("openai")).toEqual({ type: "api", key: "sk-openai" });
  });

  it("configures Grok Voice end to end", async () => {
    const { credentials, services, settings } = await testServices();
    const voice = command(buildVoiceCommands(services), "voice");
    const view = testShell(
      [["provider"], ["xai"], ["none"], ["done"]],
      ["xai-secret"],
      ["grok-voice-think-fast-2.0", "eve"],
    );
    await voice.run("", view.shell);

    expect((await settings.load()).voice).toMatchObject({
      realtimeProvider: "xai",
      ttsProvider: "openai",
      xAiRealtimeModel: "grok-voice-think-fast-2.0",
      xAiVoice: "eve",
      xAiReasoningEffort: "none",
    });
    expect(credentials.get("xai")).toEqual({ type: "api", key: "xai-secret" });
  });

  it("writes nothing when the wizard is cancelled mid-step", async () => {
    const { services, settings } = await testServices();
    const voice = command(buildVoiceCommands(services), "voice");
    // Provider chosen, then the voice-id prompt is cancelled (undefined text).
    const view = testShell([["provider"], ["elevenlabs"], ["done"]], [], [undefined]);
    await voice.run("", view.shell);
    expect((await settings.load()).voice.ttsProvider).toBe("openai");
  });

  it("shows status with the credential presence and never the key", async () => {
    const { services, settings } = await testServices();
    await settings.update((current) => ({
      ...current,
      voice: {
        realtimeProvider: "openai",
        ttsProvider: "elevenlabs",
        xAiReasoningEffort: "high",
        elevenLabsVoiceId: "voice_abc123",
      },
    }));
    const voice = command(buildVoiceCommands(services), "voice");
    const view = testShell([]);
    await voice.run("status", view.shell);
    const text = view.results.map((result) => result.text).join("\n");
    expect(text).toContain("ElevenLabs");
    expect(text).toContain("voice_abc123");
    expect(text).toContain("MISSING");
  });
});

describe("voice command helpers", () => {
  it("validates vendor identifiers to the URL-safe shape", () => {
    expect(validateVendorIdentifier("voice_abc123")).toBeUndefined();
    expect(validateVendorIdentifier("")).toBe("Required.");
    expect(validateVendorIdentifier("../../etc")).toContain("letters, digits");
    expect(validateVendorIdentifier("x".repeat(129))).toContain("letters, digits");
  });

  it("describes both providers without leaking anything secret-shaped", () => {
    expect(
      describeVoice(
        {
          realtimeProvider: "openai",
          ttsProvider: "openai",
          xAiReasoningEffort: "high",
          openAiVoice: "marin",
        },
        false,
        false,
      ).join("\n"),
    ).toContain("realtime: OpenAI");
    const elevenLabs = describeVoice(
      {
        realtimeProvider: "openai",
        ttsProvider: "elevenlabs",
        xAiReasoningEffort: "high",
        elevenLabsVoiceId: "voice_abc123",
      },
      true,
      true,
    ).join("\n");
    expect(elevenLabs).toContain("voice_abc123");
    expect(elevenLabs).toContain("redacted");
  });
});
