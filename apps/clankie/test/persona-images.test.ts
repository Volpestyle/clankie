import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFauxCore,
  fauxAssistantMessage,
  getCurrentSystemPrompt,
  InMemoryCredentialStore,
  type Api,
  type Context,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SettingsStore, emptySettings } from "@clankie/settings";
import { PERSONA_IMAGE_FRAMING } from "@clankie/persona-images";
import { personaImagesExtension } from "../src/persona-images.ts";
import { assembleLanePrompt } from "../src/captain/captain.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const board = {
  hash: "test",
  files: [],
  images: [
    {
      role: "appearance" as const,
      data: "PERSONA_PIXELS",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
    },
    {
      role: "vibe" as const,
      contactSheet: true as const,
      data: "VIBE_PIXELS",
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
    },
  ],
  description: "Appearance: A green seed creature with a leaf. Vibe: Joyful cosmic grandeur.",
};
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "persona-lanes-"));
  roots.push(dir);
  return dir;
}
it.each(["operator", "discord_presence", "discord_voice"] as const)(
  "prefixes every %s Pi turn without persisting pixels and falls back on model switch",
  async (lane) => {
    const dir = await temp();
    const core = createFauxCore({
      provider: "test",
      api: "faux-persona",
      models: [{ id: "vision" }, { id: "text" }],
    });
    core.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("hello")));
    const calls: Context[] = [];
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider("test", {
      api: "faux-persona" as Api,
      baseUrl: "http://localhost:1",
      apiKey: "test",
      streamSimple: (model, context, options) => {
        calls.push({
          systemPrompt: getCurrentSystemPrompt(context.messages),
          messages: structuredClone(context.messages.filter((message) => message.role !== "system")),
        });
        return core.streamSimple(model, context, options);
      },
      models: [true, false].map((vision) => ({
        id: vision ? "vision" : "text",
        name: "test",
        reasoning: false,
        input: vision ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000,
      })),
    });
    let memory = 0;
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      systemPrompt: assembleLanePrompt(lane, false, emptySettings()),
      noExtensions: true,
      noSkills: true,
      extensionFactories: [
        personaImagesExtension(
          async () => board,
          async () => `memory card ${++memory}`,
        ),
      ],
      settingsManager,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: dir,
      model: runtime.getModel("test", "vision")!,
      modelRuntime: runtime,
      thinkingLevel: "off",
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(dir),
      noTools: "builtin",
    });
    try {
      await session.bindExtensions({ mode: "print" });
      for (const text of ["hi", "again"]) {
        await session.prompt(text);
        await session.waitForIdle();
      }
      expect(calls[0]!.systemPrompt).toContain("# Character");
      expect(calls[0]!.messages[0]).toEqual(calls[1]!.messages[0]);
      expect(calls[0]!.systemPrompt).toEqual(calls[1]!.systemPrompt);
      expect(calls[0]!.messages[1]).not.toEqual(calls[1]!.messages[1]);
      expect(calls[0]!.messages[0]).toMatchObject({
        content: [
          { type: "text", text: PERSONA_IMAGE_FRAMING },
          { type: "text", text: "Appearance reference: how you look." },
          { type: "image", data: "PERSONA_PIXELS" },
          {
            type: "text",
            text: expect.stringMatching(/Vibe reference.*contact sheet.*the sequence is the point/),
          },
          { type: "image", data: "VIBE_PIXELS" },
        ],
      });
      expect(JSON.stringify(session.sessionManager.getEntries())).not.toContain("PERSONA_PIXELS");
      await session.setModel(runtime.getModel("test", "text")!);
      await session.prompt("text model now");
      await session.waitForIdle();
      expect(JSON.stringify(calls[2])).not.toContain("PERSONA_PIXELS");
      expect(JSON.stringify(calls[2]!.messages[0])).toContain(board.description);
    } finally {
      session.dispose();
    }
  },
);
it("protects persona API writes and status behind owner authentication", async () => {
  const settings = new SettingsStore(join(await temp(), "settings.json"));
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    authenticateOperator: async (r) =>
      r.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  try {
    expect((await clankie.app.request("/v1/operator/persona")).status).toBe(401);
    const headers = { authorization: "Bearer owner", "content-type": "application/json" };
    const response = await clankie.app.request("/v1/operator/persona", {
      method: "POST",
      headers,
      body: JSON.stringify({ imagesDir: join(await temp(), "missing") }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      images: { count: 0, error: expect.any(String) },
      restart: expect.stringContaining("Restart"),
    });
    const bad = await clankie.app.request("/v1/operator/persona", {
      method: "POST",
      headers,
      body: JSON.stringify({ imagesDir: ["not a path"] }),
    });
    expect(bad.status).toBe(400);
  } finally {
    clankie.close();
  }
});
it("sends only the bounded description into Discord realtime voice", async () => {
  const clankie = await createClankieApp({
    captain: createStubCaptain(),
    settings: { load: async () => emptySettings() },
    personaImages: async () => board,
    authenticateCaptain: async () => ({ captainId: "test", steerSourceLane: "discord_voice" }),
  });
  try {
    const response = await clankie.app.request("/v1/discord/voice-briefing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, guildId: "12345", channelId: "67890", consentedUserIds: [] }),
    });
    expect(response.status).toBe(200);
    const briefing = await response.text();
    expect(briefing).toContain(board.description);
    expect(briefing).not.toContain("PERSONA_PIXELS");
    expect(briefing).not.toContain("VIBE_PIXELS");
  } finally {
    clankie.close();
  }
});
