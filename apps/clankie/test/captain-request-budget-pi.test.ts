import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedContextModel, INCLUDED_USAGE_MAX_REQUEST_BYTES } from "@clankie/model-provider";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  captainRequestExtension,
  INCLUDED_USAGE_REQUEST_BUDGET_BYTES,
} from "../src/captain/request-budget.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A real Pi session on the included-usage provider (`clankie`), advertising the
 * pinned model's 1.05M window. Each model call builds the OpenAI Responses body
 * Pi's own transport would send, runs it through the captain's request hook, and
 * records the bytes that would reach the fleet proxy.
 */
async function includedSession(input: { bounded: boolean; extension: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), "clankie-request-budget-"));
  dirs.push(dir);
  const core = createFauxCore({ provider: "clankie", api: "faux-included", models: [{ id: "default" }] });
  const sent: number[] = [];
  let compactBeforeNextRun = false;
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("clankie", {
    api: "faux-included" as Api,
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "loopback",
    streamSimple: (model, context, options) => {
      const payload = {
        model: model.id,
        input: convertResponsesMessages(model, context, new Set(["clankie"])),
        prompt_cache_key: options?.sessionId,
        stream: true,
      };
      const shaped = options?.onPayload?.(payload, model) ?? payload;
      void Promise.resolve(shaped).then((body) =>
        sent.push(Buffer.byteLength(JSON.stringify(body ?? payload))),
      );
      return core.streamSimple(model, context, options);
    },
    models: [
      {
        id: "default",
        name: "default",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_050_000,
        maxTokens: 8_000,
      },
    ],
  });
  const advertised = runtime.getModel("clankie", "default") as Model<Api>;
  const model = input.bounded ? boundedContextModel(advertised, {}) : advertised;
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    systemPrompt: "You are under test.",
    noExtensions: true,
    extensionFactories: input.extension
      ? [
          captainRequestExtension({
            lane: "operator",
            cacheSalt: "0123456789ab",
            onTrimmed: () => {
              compactBeforeNextRun = true;
            },
          }),
        ]
      : [],
    noPromptTemplates: true,
    settingsManager,
  });
  await loader.reload();
  const dump = defineTool({
    name: "dump",
    label: "Dump",
    description: "Returns a large log.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text" as const, text: `LOG-${"x".repeat(1024 * 1024)}-END` }],
      details: undefined,
    }),
  });
  const { session } = await createAgentSession({
    cwd: dir,
    model,
    thinkingLevel: "off",
    modelRuntime: runtime,
    customTools: [dump],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
    noTools: "builtin",
  });
  await session.bindExtensions({ mode: "print" });
  const compactions = () =>
    session.sessionManager.getEntries().filter((entry: { type: string }) => entry.type === "compaction")
      .length;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  /** One turn the way the captain runs it: compact first if the last run was trimmed (syncModel). */
  const turn = async (text: string, images?: Array<{ type: "image"; mimeType: string; data: string }>) => {
    if (compactBeforeNextRun) {
      compactBeforeNextRun = false;
      // Pi's own threshold may already have compacted at the end of that run.
      await session.compact().catch((error: unknown) => {
        const benign = ["Already compacted", "Nothing to compact (session too small)"];
        if (!(error instanceof Error && benign.includes(error.message))) throw error;
      });
    }
    await session.prompt(text, { expandPromptTemplates: false, ...(images === undefined ? {} : { images }) });
    await session.waitForIdle();
    await settle();
  };
  return { session, core, sent, compactions, settle, model, turn };
}

/** About 37k tokens of text by Pi's estimate (four characters a token). */
const chapter = (n: number) => `chapter ${String(n)}: ${"lorem ipsum dolor sit amet ".repeat(5_500)}`;

describe("a long included-usage session never builds a request the proxy refuses", () => {
  it("compacts at the 250k token threshold, and without it the same session outgrows 2 MiB", async () => {
    for (const bounded of [true, false]) {
      const pi = await includedSession({ bounded, extension: true });
      pi.core.setResponses(Array.from({ length: 80 }, () => fauxAssistantMessage("noted")));
      for (let turn = 1; turn <= 16; turn += 1) await pi.turn(chapter(turn));
      await pi.settle();
      const largest = Math.max(...pi.sent);
      if (bounded) {
        expect(pi.model.contextWindow).toBe(250_000 + 16_384);
        expect(pi.compactions()).toBeGreaterThan(0);
        expect(largest).toBeLessThanOrEqual(INCLUDED_USAGE_REQUEST_BUDGET_BYTES);
      } else {
        // The bug: Pi would wait for the advertised 1.05M window, and the proxy refuses at 2 MiB first.
        expect(pi.compactions()).toBe(0);
        expect(largest).toBeGreaterThan(INCLUDED_USAGE_MAX_REQUEST_BYTES);
      }
    }
  }, 120_000);

  it("trims images and outsized tool output that tokens do not bound", async () => {
    for (const extension of [true, false]) {
      const pi = await includedSession({ bounded: true, extension });
      pi.core.setResponses([
        fauxAssistantMessage(fauxToolCall("dump", {})),
        fauxAssistantMessage(fauxToolCall("dump", {})),
        fauxAssistantMessage("two logs read"),
        ...Array.from({ length: 20 }, () => fauxAssistantMessage("seen")),
      ]);
      await pi.turn("read the logs");
      const photo = { type: "image" as const, mimeType: "image/png", data: "A".repeat(700 * 1024) };
      for (let turn = 1; turn <= 3; turn += 1) await pi.turn(`photo ${String(turn)}`, [photo]);
      await pi.turn("anything else?");
      await pi.settle();
      const largest = Math.max(...pi.sent);
      if (extension) {
        // Every request fits: the log turn through trimming (and Pi's own
        // compaction after it), the photo turns through the byte guard alone,
        // since images are far under 250k tokens.
        expect(largest).toBeLessThanOrEqual(INCLUDED_USAGE_REQUEST_BUDGET_BYTES);
      } else {
        expect(largest).toBeGreaterThan(INCLUDED_USAGE_MAX_REQUEST_BYTES);
      }
    }
  }, 120_000);
});
