// A durable lane's turn that arrives while the lane compacts before a run waits for it (#542).
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
import { runDurableTurn } from "../src/captain/captain-session.ts";
import type { TurnContext } from "../src/captain/tools.ts";
import { routeLaneRun } from "../src/captain/lane-route.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const userTexts = (messages: readonly { role: string; content: unknown }[]) =>
  messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : typeof message.content === "string"
        ? [message.content]
        : (message.content as { type: string; text?: string }[]).flatMap((part) =>
            part.type === "text" && part.text !== undefined ? [part.text] : [],
          ),
  );

it("runs a turn sent during the lane's pre-run compaction after the compaction, instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankie-compaction-wait-"));
  dirs.push(dir);
  const core = createFauxCore({ provider: "scripted", api: "faux-compaction", models: [{ id: "default" }] });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("scripted", {
    api: "faux-compaction" as Api,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "loopback",
    streamSimple: core.streamSimple,
    models: [
      {
        id: "default",
        name: "default",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_000,
      },
    ],
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 200 } });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    systemPrompt: "You are under test.",
    noExtensions: true,
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

  // History worth compacting: an older commitment, then filler past the kept tail.
  core.setResponses([
    fauxAssistantMessage("Yes, I'll bring the map on Friday."),
    fauxAssistantMessage("noted"),
    fauxAssistantMessage("noted"),
  ]);
  await session.prompt("Will you bring the map to Friday's game night?", { expandPromptTemplates: false });
  for (const n of [1, 2])
    await session.prompt(`filler ${String(n)}: ${"lorem ipsum dolor sit amet ".repeat(200)}`, {
      expandPromptTemplates: false,
    });
  await session.waitForIdle();

  // The compaction's summary call is held open until the second turn has arrived.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let summarizing!: () => void;
  const summaryStarted = new Promise<void>((resolve) => {
    summarizing = resolve;
  });
  core.setResponses([
    async () => {
      summarizing();
      await held;
      return fauxAssistantMessage("Summary: he promised to bring the map on Friday.");
    },
    ...Array.from({ length: 4 }, () => fauxAssistantMessage("on it")),
  ]);

  const lane = {
    session,
    capture: {} as TurnContext,
    purpose: "operator" as const,
    budget: { compactBeforeNextRun: true },
    running: undefined as Promise<boolean> | undefined,
    starting: undefined as Promise<void> | undefined,
  };
  const route = { resolveRoute: async () => ({}) as never };
  // Each turn the way a durable Discord turn runs it: synchronize (compacting if due), then run.
  const turn = async (text: string) => {
    await routeLaneRun(lane, route);
    return runDurableTurn(lane, text, []);
  };

  const first = turn("first turn after the trimmed run");
  await summaryStarted;
  expect(session.isCompacting).toBe(true);
  const second = turn("second turn, sent during the compaction");
  const early = await Promise.race([
    second.then(
      () => "settled",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    ),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 200)),
  ]);
  expect(early).toBe("waiting");
  release();

  const roles = await Promise.all([first, second]);
  expect(roles).toContain("ran");
  await session.waitForIdle();
  const entries = session.sessionManager.getEntries();
  expect(entries.filter((entry: { type: string }) => entry.type === "compaction")).toHaveLength(1);
  const texts = userTexts(session.messages as never);
  expect(texts).toEqual(
    expect.arrayContaining(["first turn after the trimmed run", "second turn, sent during the compaction"]),
  );
});
