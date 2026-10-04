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

afterEach(async () => {
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
  return { XDG_CONFIG_HOME: root };
}

async function run(args: readonly string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const exit = await runHeadlessCaptainCommand(args, {
    repoRoot: "/unused",
    env,
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
        machineGrantGuilds: 0,
      },
      voice: { realtimeProvider: "openai", ttsProvider: "openai" },
      gameplay: { pokeagentMmoEnabled: true },
      skills: { selection: { opinionated: true, exclude: [] }, catalog: [] },
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

    expect(results[0]?.text).toContain("status: ready");
    expect(results[0]?.text).toContain("clankie: healthy");
    expect(JSON.parse(results[1]?.text ?? "")).toEqual(doctor);
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
    expect(await run(["persona", "status"], env)).toEqual(await personaStatus({ env }));
    expect(await run(["games", "status"], env)).toEqual(await gamesStatus({ env }));
    expect(await run(["discord", "status"], env)).toEqual(await discordStatus({ env }));
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
          stdout: stdout.stream,
          stderr: stderr.stream,
        }),
      ).toBe(1);
      expect(await store.load()).toEqual(before);
    }
  });
});
