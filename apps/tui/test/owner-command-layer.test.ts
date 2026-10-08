import { DiscordRoomObservations } from "../../clankie/src/discord-room-observations.ts";
import { mintOperatorToken } from "@clankie/credential-broker";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import { discordStatus } from "../src/command/discord.ts";
import { effortStatus } from "../src/command/effort.ts";
import { gamesStatus } from "../src/command/games.ts";
import { imageModelStatus } from "../src/command/image-model.ts";
import { modelStatus } from "../src/command/model.ts";
import { modelRoutingStatus } from "../src/command/model-routing.ts";
import { personaStatus } from "../src/command/persona.ts";
import { videoModelStatus } from "../src/command/video-model.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const tempDirs: string[] = [];
const ownerServices = new Map<
  string,
  { service: Awaited<ReturnType<typeof createClankieApp>>; voiceEnv: NodeJS.ProcessEnv }
>();

afterEach(async () => {
  for (const fixture of ownerServices.values()) fixture.service.close();
  ownerServices.clear();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function outputBuffer(): { readonly stream: { write(chunk: string): void }; readonly text: () => string } {
  let output = "";
  return {
    stream: { write: (chunk) => void (output += chunk) },
    text: () => output,
  };
}

async function isolatedEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-owner-commands-"));
  tempDirs.push(root);
  const env = { XDG_CONFIG_HOME: root, CLANKIE_OPERATOR_TOKEN: mintOperatorToken() };
  const voiceEnv = { ...env };
  const service = await createClankieApp({
    captain: createStubCaptain(),
    settings: new SettingsStore(defaultSettingsPath(env)),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${env.CLANKIE_OPERATOR_TOKEN}`
        ? { operatorId: "owner" }
        : undefined,
    voiceSettingsEnv: voiceEnv,
    roomObservations: new DiscordRoomObservations(join(root, "rooms.json")),
  });
  ownerServices.set(root, { service, voiceEnv });
  return env;
}

function ownerClient(env: NodeJS.ProcessEnv) {
  const fixture = ownerServices.get(env.XDG_CONFIG_HOME!);
  if (!fixture) throw new Error("Missing owner command service fixture");
  for (const key of Object.keys(fixture.voiceEnv)) delete fixture.voiceEnv[key];
  Object.assign(fixture.voiceEnv, env);
  return {
    host: "http://clankie.test",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
      fixture.service.app.fetch(new Request(String(url), init))) as typeof fetch,
  };
}

async function run(args: readonly string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const exit = await runHeadlessCaptainCommand(args, {
    repoRoot: "/unused",
    env,
    ...ownerClient(env),
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  expect(exit, stderr.text()).toBe(0);
  return JSON.parse(stdout.text());
}

describe("canonical owner command layer", () => {
  it("renders injected status and doctor command results in the TUI", async () => {
    const doctor = {
      ok: true,
      kind: "checkout",
      version: "0.2.0",
      repoRoot: "/repo",
      model: "xai/grok-4.6",
      captain: { ready: true, model: "xai/grok-4.6", providerId: "xai", auth: "credential" },
      imageModel: null,
      videoModel: null,
      persona: { displayName: "Clankie" },
      discord: {
        activeBody: "bot",
        textIngressEnabled: false,
        voiceEnabled: false,
        userSessionEnabled: false,
        machineGrantUsers: 0,
        serverOwnershipPolicies: 0,
        roomSkillGrants: 0,
      },
      voice: { realtimeProvider: "openai", ttsProvider: "openai" },
      gameplay: { pokeagentMmoEnabled: true },
      skills: { catalog: [] },
      emailConfigured: false,
      mcpServers: [],
      credentials: [],
      commands: {},
      herdrPlugin: { bundled: false },
      harnessBridges: {
        linkedSession: { state: "no-link", panes: [], unownedBridges: [] },
        profiles: {
          machine: { platform: "darwin", home: "/home" },
          claude: [],
          otherHarnesses: [],
          codex: {
            executable: false,
            executablePath: null,
            executableDetail: "Native Codex unavailable",
            registered: false,
            pluginInstalled: false,
            registration: "absent",
            registrationIdentityForwarding: false,
            bridge: false,
            identityForwarding: false,
            enabled: false,
            version: null,
            expectedVersion: null,
            versionMatches: null,
            configPath: "/config",
            configSource: "/config",
            skill: false,
            replies: "native-control",
            liveReceiver: "not-observed",
          },
        },
        codex: { registered: false, configPath: "/config", configSource: "/config" },
        claude: { installed: false, enabled: false },
        localFleet: { platform: "darwin", membership: "no-link", sharedDaemon: false, detail: "missing" },
        remediation: [],
      },
      laneTools: { url: "http://127.0.0.1:4310/v1/mcp", reachable: true },
      doorway: { state: "connected" },
      power: {
        state: "always_on",
        source: "ac",
        sleepAfterMinutes: 0,
        heldAwakeBy: [] as string[],
        keepAwakeRequested: false,
      },
      selectedModel: null,
      nextStep: "Pair a phone or tablet: run `clankie pair` (or /pair).",
      remediations: [],
    } as const;
    const results: Array<{ command: string; text: string }> = [];
    const identity = (value: string): string => value;
    const shell = {
      theme: {
        ansi: {
          bold: identity,
          cyan: identity,
          dim: identity,
          green: identity,
          yellow: identity,
          red: identity,
        },
      },
      insertCommandResult(command: string, text: string) {
        results.push({ command, text });
      },
    } as unknown as ClankieFaceShell;
    const commands = buildConsoleCommands({
      commandStatus: () =>
        Promise.resolve({
          ok: true,
          status: "ready",
          host: "http://127.0.0.1:4310",
          operatorCredential: { present: true, source: "store", consistency: "store_only" },
          services: [{ id: "clankie", label: "Clankie", state: "healthy", owned: true }],
        }),
      commandDoctor: () => Promise.resolve(doctor),
    });

    await commands.find((command) => command.name === "status")?.run("", shell);
    await commands.find((command) => command.name === "doctor")?.run("", shell);
    await commands.find((command) => command.name === "doctor")?.run("json", shell);

    expect(results[0]?.text).toContain("status: ready");
    expect(results[0]?.text).toContain("clankie: healthy");
    expect(results[1]?.text).toContain("✓ Captain · xai/grok-4.6 via credential");
    expect(results[1]?.text).toContain("Next: Pair a phone or tablet");
    expect(JSON.parse(results[2]?.text ?? "")).toEqual(doctor);
  });

  it("sets when long sessions compact through argv", async () => {
    const env = await isolatedEnv();
    expect(await run(["model", "compaction"], env)).toEqual({
      ok: true,
      compactAtTokens: null,
      includedUsageDefault: 250_000,
      appliesTo: "included usage",
    });
    expect(await run(["model", "compaction", "set", "120_000"], env)).toMatchObject({
      compactAtTokens: 120_000,
      appliesTo: "every model",
    });
    expect(await run(["model", "compaction", "default"], env)).toMatchObject({ compactAtTokens: null });
  });

  it("configures task-based model routing through argv", async () => {
    const env = await isolatedEnv();
    await run(["model", "set", "openai/work-model"], env);

    const off = (await run(["model", "routing"], env)) as { enabled: boolean; purposes: unknown };
    expect(off).toMatchObject({
      ok: true,
      enabled: false,
      routineModel: null,
      workModel: "openai/work-model",
    });
    expect(off.purposes).toMatchObject({ discord_social: { tier: "work", model: "openai/work-model" } });

    await run(["model", "routing", "set", "openai/routine-model"], env);
    await run(["model", "routing", "escalate", "on"], env);
    await run(["model", "routing", "purpose", "gameplay", "routine"], env);
    const on = await run(["model", "routing", "turn-limit", "5"], env);
    expect(on).toEqual(await modelRoutingStatus({ env }));
    expect(on).toMatchObject({
      enabled: true,
      routineModel: "openai/routine-model",
      escalate: true,
      escalationModel: "openai/work-model",
      routineTurnLimit: 5,
      purposes: {
        operator: { tier: "work", model: "openai/work-model" },
        discord_social: { tier: "routine", model: "openai/routine-model", escalatesTo: "openai/work-model" },
        discord_granted: { tier: "work", model: "openai/work-model" },
        gameplay: { tier: "routine", model: "openai/routine-model", escalatesTo: "openai/work-model" },
      },
    });

    await run(["model", "routing", "purpose", "gameplay", "default"], env);
    expect(await run(["model", "routing", "off"], env)).toMatchObject({
      enabled: false,
      purposes: { gameplay: { tier: "work", model: "openai/work-model" } },
    });
  });

  it("finishes non-secret setup through argv and returns the command functions' results", async () => {
    const env = await isolatedEnv();

    await run(["model", "set", "xai/grok-4.6"], env);
    await run(["effort", "set", "high"], env);
    await run(["image-model", "set", "openai/gpt-image-2"], env);
    await run(["video-model", "set", "xai/grok-imagine-video-1.5"], env);
    await run(
      [
        "persona",
        "set",
        "--display-name",
        "Clankie",
        "--aliases",
        "Clanky,Clanker",
        "--character-notes",
        "Warm, direct, and funny.",
        "--chattiness",
        "chatty",
        "--reply-policy",
        "all",
        "--live-message-window",
        "8",
      ],
      env,
    );
    await run(["games", "set", "off"], env);
    await run(["games", "budget", "max-tokens", "5000"], env);
    await run(["games", "budget", "max-cost-usd", "0.25"], env);
    expect(await gamesStatus({ env })).toMatchObject({
      games: { pokemonBudget: { maxTokens: 5000, maxCostUsd: 0.25 } },
    });
    await run(["games", "budget", "max-cost-usd", "default"], env);
    expect(await gamesStatus({ env })).toMatchObject({ games: { pokemonBudget: { maxTokens: 5000 } } });
    await run(
      [
        "discord",
        "set",
        "--application-id",
        "12345",
        "--guild-id",
        "23456",
        "--owner-user-id",
        "34567",
        "--system-actor-user-ids",
        "34567,45678",
        "--text-ingress-enabled",
        "on",
        "--ingress-guild-ids",
        "23456",
        "--active-body",
        "bot",
      ],
      env,
    );

    expect(await run(["model", "status"], env)).toEqual(await modelStatus({ env }));
    expect(await run(["effort", "status"], env)).toEqual(await effortStatus({ env }));
    expect(await run(["image-model", "status"], env)).toEqual(await imageModelStatus({ env }));
    expect(await run(["video-model", "status"], env)).toEqual(await videoModelStatus({ env }));
    expect(await run(["persona", "status"], env)).toEqual(await personaStatus({ env, ...ownerClient(env) }));
    expect(await run(["games", "status"], env)).toEqual(await gamesStatus({ env }));
    expect(await run(["discord", "status"], env)).toEqual(await discordStatus({ env, ...ownerClient(env) }));
  });

  it("keeps scoped TUI faces free of private durable-config writers", async () => {
    const files = [
      "src/commands.ts",
      "src/discord-commands.ts",
      "src/persona-commands.ts",
      "src/provider-commands.ts",
    ];
    const forbidden = /settings\.update|updateGlobalConfig|declareLocalProvider|setCaptainModel/u;
    for (const file of files) {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(forbidden);
      expect(source, file).toMatch(/\.\/command\//u);
    }
    const entrypoint = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(entrypoint).toMatch(/statusCommand/u);
    expect(entrypoint).toMatch(/doctorCommand/u);
  });
});

describe("headless ElevenLabs model selection", () => {
  it("changes only the model, reports environment precedence, and restores an unset model", async () => {
    const env = await isolatedEnv();
    const store = new SettingsStore(defaultSettingsPath(env));
    const before = await store.update((current) => ({
      ...current,
      voice: {
        ...current.voice,
        ttsProvider: "elevenlabs",
        elevenLabsVoiceId: "existing_voice",
        openAiVoice: "marin",
      },
      discord: { ...current.discord, voiceConsentPolicy: "presence" },
    }));
    const selected = await run(["voice", "model", "set", "eleven_v4_turbo"], env);
    expect(selected).toMatchObject({
      ok: true,
      voice: { elevenLabsModelId: "eleven_v4_turbo", elevenLabsVoiceId: "existing_voice" },
      restart: "clankie restart",
    });
    expect(await store.load()).toEqual({
      ...before,
      voice: { ...before.voice, elevenLabsModelId: "eleven_v4_turbo" },
    });
    expect(
      await run(["voice", "status"], { ...env, CLANKIE_VOICE_ELEVENLABS_MODEL_ID: "eleven_flash_v2_5" }),
    ).toMatchObject({
      voice: { elevenLabsModelId: "eleven_v4_turbo" },
      effectiveVoice: { elevenLabsModelId: "eleven_flash_v2_5" },
      overriddenByEnvironment: ["CLANKIE_VOICE_ELEVENLABS_MODEL_ID"],
    });
    await run(["voice", "model", "clear"], env);
    expect(await store.load()).toEqual(before);
  });

  it("refuses unknown commands, unsafe IDs and native-provider selection without writing", async () => {
    const env = await isolatedEnv();
    const store = new SettingsStore(defaultSettingsPath(env));
    const before = await store.load();
    for (const args of [
      ["voice", "status", "extra"],
      ["voice", "model", "set", "../bad"],
      ["voice", "model", "set", "eleven_v4_turbo"],
    ]) {
      const stdout = outputBuffer();
      const stderr = outputBuffer();
      expect(
        await runHeadlessCaptainCommand(args, {
          repoRoot: "/unused",
          env,
          ...ownerClient(env),
          stdout: stdout.stream,
          stderr: stderr.stream,
        }),
      ).toBe(1);
      expect(await store.load()).toEqual(before);
    }
  });
});

describe("headless voice brain selection", () => {
  it("refuses unusable effective environment overrides before persisting a valid candidate", async () => {
    const env = await isolatedEnv();
    const store = new SettingsStore(defaultSettingsPath(env));
    const before = await store.update((current) => ({
      ...current,
      voice: {
        ...current.voice,
        ttsProvider: "elevenlabs",
        elevenLabsVoiceId: "owned_voice",
      },
    }));
    for (const { args, overrides, errorField } of [
      {
        args: ["voice", "brain", "set", "anthropic"],
        overrides: { CLANKIE_VOICE_REALTIME_PROVIDER: "xai" },
        errorField: "ttsProvider",
      },
      {
        args: ["voice", "brain", "set", "openai", "saved-valid-model"],
        overrides: { CLANKIE_VOICE_REALTIME_MODEL: "../unsafe" },
        errorField: "openAiRealtimeModel",
      },
      {
        args: ["voice", "model", "set", "eleven_v4_turbo"],
        overrides: { CLANKIE_VOICE_TTS_PROVIDER: "unsupported" },
        errorField: "ttsProvider",
      },
    ]) {
      const stdout = outputBuffer(),
        stderr = outputBuffer();
      expect(
        await runHeadlessCaptainCommand(args, {
          repoRoot: "/unused",
          env: { ...env, ...overrides },
          ...ownerClient({ ...env, ...overrides }),
          stdout: stdout.stream,
          stderr: stderr.stream,
        }),
      ).toBe(1);
      expect(stderr.text()).toContain(errorField);
      expect(await store.load()).toEqual(before);
    }
  });

  it("selects an Anthropic brain, honors model overrides, and restores the retained native stacks", async () => {
    const env = await isolatedEnv();
    const store = new SettingsStore(defaultSettingsPath(env));
    const before = await store.update((current) => ({
      ...current,
      voice: {
        ...current.voice,
        elevenLabsVoiceId: "owned_voice",
        openAiRealtimeModel: "saved-openai-brain",
        openAiTranscribeModel: "gpt-realtime-whisper",
        xAiRealtimeModel: "saved-xai-brain",
      },
      discord: { ...current.discord, voiceConsentPolicy: "presence" },
    }));
    const selected = await run(["voice", "brain", "set", "anthropic", "claude-sonnet-5-5"], env);
    expect(selected).toMatchObject({
      voice: {
        realtimeProvider: "anthropic",
        anthropicModel: "claude-sonnet-5-5",
        ttsProvider: "elevenlabs",
        elevenLabsVoiceId: "owned_voice",
        openAiRealtimeModel: "saved-openai-brain",
        xAiRealtimeModel: "saved-xai-brain",
      },
    });
    expect(
      await run(["voice", "status"], { ...env, CLANKIE_VOICE_REALTIME_MODEL: "explicit-brain" }),
    ).toMatchObject({
      voice: { anthropicModel: "claude-sonnet-5-5" },
      effectiveVoice: { anthropicModel: "explicit-brain" },
    });
    await run(["voice", "brain", "model", "clear"], env);
    expect((await store.load()).voice.anthropicModel).toBeUndefined();
    await run(["voice", "brain", "set", "xai"], env);
    expect((await store.load()).voice).toMatchObject({
      realtimeProvider: "xai",
      xAiRealtimeModel: "saved-xai-brain",
      ttsProvider: "openai",
    });
    await run(["voice", "brain", "set", "openai"], env);
    expect(await store.load()).toEqual(before);
  });

  it("refuses missing external voice setup and invalid brain commands without writing", async () => {
    const env = await isolatedEnv();
    const store = new SettingsStore(defaultSettingsPath(env));
    const before = await store.load();
    for (const args of [
      ["voice", "brain", "set", "anthropic"],
      ["voice", "brain", "set", "unknown"],
      ["voice", "brain", "set", "openai", "../unsafe"],
      ["voice", "brain", "model", "clear", "extra"],
    ]) {
      const stdout = outputBuffer(),
        stderr = outputBuffer();
      expect(
        await runHeadlessCaptainCommand(args, {
          repoRoot: "/unused",
          env,
          ...ownerClient(env),
          stdout: stdout.stream,
          stderr: stderr.stream,
        }),
      ).toBe(1);
      expect(await store.load()).toEqual(before);
    }
  });
});
