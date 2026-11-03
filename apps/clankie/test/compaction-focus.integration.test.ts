// Every compaction of his lanes asks Pi's summary to keep people and commitments (#542).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFauxCore,
  fauxAssistantMessage,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it } from "vitest";
import { captainCompactionExtension } from "../src/captain/compaction-focus.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A real Pi session on a scripted model with a small window, so its own threshold compacts. */
async function lane(focused: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "clankie-compaction-focus-"));
  dirs.push(dir);
  const core = createFauxCore({ provider: "scripted", api: "faux-focus", models: [{ id: "default" }] });
  const requests: string[] = [];
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("scripted", {
    api: "faux-focus" as Api,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "loopback",
    streamSimple: (model, context, options) => {
      requests.push(JSON.stringify(context.messages));
      return core.streamSimple(model, context, options);
    },
    models: [
      {
        id: "default",
        name: "default",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 12_000,
        maxTokens: 2_000,
      },
    ],
  });
  const settingsManager = SettingsManager.inMemory({
    compaction: { reserveTokens: 4_000, keepRecentTokens: 500 },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    systemPrompt: "You are under test.",
    noExtensions: true,
    extensionFactories: focused ? [captainCompactionExtension()] : [],
    noPromptTemplates: true,
    settingsManager,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    model: runtime.getModel("scripted", "default") as Model<Api>,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
    noTools: "builtin",
  });
  await session.bindExtensions({ mode: "print" });
  core.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("noted")));
  const summaries = () => requests.filter((request) => request.includes("<conversation>"));
  return { session, summaries };
}

const say = (n: number) => `message ${String(n)}: ${"we planned the trip in detail ".repeat(180)}`;

it("asks every compaction, threshold and manual, to keep people, commitments and who asked", async () => {
  for (const focused of [true, false]) {
    const { session, summaries } = await lane(focused);
    await session.prompt("Will you bring the map to Friday's game night?", { expandPromptTemplates: false });
    for (let n = 1; n <= 6 && summaries().length === 0; n += 1)
      await session.prompt(say(n), { expandPromptTemplates: false });
    await session.waitForIdle();
    // Pi's own threshold compacted the lane.
    expect(summaries().length).toBeGreaterThan(0);
    const threshold = summaries()[0]!;
    for (let n = 7; n <= 9; n += 1) await session.prompt(say(n), { expandPromptTemplates: false });
    await session.waitForIdle();
    const before = summaries().length;
    // The captain's pre-run compaction (routeLaneRun) is a manual one.
    await session.compact().catch((error: unknown) => {
      if (!(error instanceof Error && error.message === "Already compacted")) throw error;
    });
    const manual = summaries().slice(before);
    for (const request of [threshold, ...manual]) {
      expect(request.includes("Additional focus:")).toBe(focused);
      expect(request.includes("every commitment he or anyone made")).toBe(focused);
      expect(request.includes("who asked for each")).toBe(focused);
    }
    if (focused) expect(manual.length).toBeGreaterThan(0);
  }
}, 60_000);
