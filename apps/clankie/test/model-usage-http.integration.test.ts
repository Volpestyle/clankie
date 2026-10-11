import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { captainModelUsageExtension } from "../src/captain/captain-model.ts";
import type { TurnModelUsage } from "@clankie/protocol/model-keys";

it("observes the served hosted model per HTTP response and reports unknown for an older proxy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "model-usage-http-"));
  let sendHeaders = true;
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        ...(sendHeaders ? { "x-clankie-model-provider": "openai", "x-clankie-model-id": "gpt-6-luna" } : {}),
      });
      response.end(
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"default","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\ndata: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"default","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test address");
  const observation: { used?: TurnModelUsage } = {};
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  runtime.registerProvider("clankie", {
    api: "openai-completions",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "local",
    models: [
      {
        id: "escalation",
        name: "Clankie escalation",
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        input: ["text"],
        contextWindow: 32000,
        maxTokens: 128,
      },
    ],
  });
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    systemPrompt: "test",
    noExtensions: true,
    extensionFactories: [captainModelUsageExtension(observation)],
    noSkills: true,
    noPromptTemplates: true,
    settingsManager,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    model: runtime.getModel("clankie", "escalation")!,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
    noTools: "builtin",
    thinkingLevel: "off",
  });
  try {
    await session.bindExtensions({ mode: "print" });
    await session.prompt("first turn, the proxy falls back to Luna");
    expect(session.getLastAssistantText()).toBe("done");
    expect(observation.used).toMatchObject({
      requestedRef: "clankie/escalation",
      actual: { providerId: "openai", modelId: "gpt-6-luna" },
      source: "hosted_proxy",
    });
    sendHeaders = false;
    await session.prompt("second turn, an older proxy");
    expect(session.getLastAssistantText()).toBe("done");
    expect(observation.used).toEqual({
      requestedRef: "clankie/escalation",
      actual: null,
      source: "unavailable",
    });
  } finally {
    session.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
