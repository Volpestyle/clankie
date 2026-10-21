import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { FileCredentialStore } from "@clankie/credential-broker";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { assertFixedPromptFits } from "../src/captain/captain-session.ts";
import { BrokerCredentialStore } from "../src/captain/model.ts";
import { gateServiceTools, type ServiceReadiness } from "../src/captain/service-tools.ts";

// Real Pi against an HTTP model endpoint: what reaches the model is the request's
// own `tools` array, not the session's bookkeeping (VUH-2647).
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const PROVIDER = "service-tools-fixture";
const NOTHING_SET_UP: ServiceReadiness = {
  minecraft: false,
  discordBody: false,
  mailbox: false,
  linear: false,
};

function reply(): string {
  const frame = (delta: object, reason: string | null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "local", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  return `${frame({ role: "assistant", content: "ok" }, null)}${frame({}, "stop")}data: [DONE]\n\n`;
}

async function fixture(contextWindow = 100_000) {
  const root = await mkdtemp(join(tmpdir(), "service-tools-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const requestTools: string[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      tools?: { function: { name: string } }[];
    };
    requestTools.push((body.tools ?? []).map((tool) => tool.function.name).sort());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(reply());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture endpoint");
  const credentials = new BrokerCredentialStore(new FileCredentialStore(join(root, "credentials.json")));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(PROVIDER, {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    apiKey: "local",
    models: [
      {
        id: "local",
        name: "Local fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: 1000,
      },
    ],
  });
  const piSettings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    systemPrompt: "Service tools fixture.",
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    settingsManager: piSettings,
  });
  await loader.reload();
  const tool = (name: string) =>
    defineTool({
      name,
      label: name,
      description: `The ${name} fixture tool.`,
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: undefined }),
    });
  const { session } = await createAgentSession({
    cwd: root,
    model: runtime.getModel(PROVIDER, "local")!,
    thinkingLevel: "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.create(root, join(root, "pi")),
    settingsManager: piSettings,
    noTools: "builtin",
    customTools: [
      "memory",
      "minecraft_configure",
      "minecraft_status",
      "voice_join",
      "email_list",
      "linear_wake",
      "searched_tool",
    ].map(tool),
  });
  return { session, requestTools };
}

/** One run as the captain's pre-run sync would gate it. */
async function run(
  session: AgentSession,
  readiness: ServiceReadiness,
  lane: CaptainSessionLaneV2,
  withheld: Set<string>,
): Promise<void> {
  session.setActiveToolsByName(
    gateServiceTools(
      session.getActiveToolNames(),
      new Set(session.getAllTools().map((tool) => tool.name)),
      readiness,
      lane,
      withheld,
    ),
  );
  await session.prompt("Hello.");
}

it("leaves unset-up services out of the request and sends them once they are set up", async () => {
  const { session, requestTools } = await fixture();
  const withheld = new Set<string>();
  // A tool something else turned off (here: not yet found by a tool search) stays off.
  session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "searched_tool"));

  await run(session, NOTHING_SET_UP, "operator", withheld);
  await run(session, { ...NOTHING_SET_UP, minecraft: true, mailbox: true }, "operator", withheld);
  await run(
    session,
    { minecraft: true, discordBody: true, mailbox: true, linear: true },
    "operator",
    withheld,
  );

  // Setting a world up is itself a Minecraft tool, so it stays.
  expect(requestTools).toEqual([
    ["memory", "minecraft_configure"],
    ["email_list", "memory", "minecraft_configure", "minecraft_status"],
    ["email_list", "linear_wake", "memory", "minecraft_configure", "minecraft_status", "voice_join"],
  ]);
  expect(withheld.size).toBe(0);
});

it("keeps Discord body tools in a Discord room, which is the body", async () => {
  const { session, requestTools } = await fixture();

  await run(session, NOTHING_SET_UP, "discord_presence", new Set());

  expect(requestTools).toEqual([["memory", "minecraft_configure", "searched_tool", "voice_join"]]);
});

it("refuses a run whose instructions and tools alone exceed the served context", async () => {
  const roomy = await fixture(100_000);
  expect(() => assertFixedPromptFits(roomy.session, `${PROVIDER}/local`)).not.toThrow();

  const tight = await fixture(64);
  expect(() => assertFixedPromptFits(tight.session, `${PROVIDER}/local`)).toThrow(
    /serves 64 tokens of context, but Clankie's instructions and tools alone are about \d+ tokens/u,
  );
  expect(tight.requestTools).toEqual([]);
});
