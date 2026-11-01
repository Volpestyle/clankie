import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { updateGlobalConfig } from "@clankie/model-provider";
import {
  CAPTAIN_TURN_METRICS_PATH,
  CaptainTurnMetricsPageSchema,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import type { OperatorConversationStreamEvent } from "@clankie/protocol";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
type ProviderRequest = {
  model: string;
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }>;
};
type Reply = { tool?: string; args?: Record<string, unknown>; actual?: string | null };

// The production service, broker, Pi transport, tools and durable owner history
// run unchanged. Only the external paid provider is replaced by an owned HTTP
// endpoint speaking its real streaming protocol; this is not a model-quality eval.
it("routes real HTTP turns without replay and retains authenticated serving identity and usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "turn-model-http-"));
  let replies: Reply[] = [];
  const requests: ProviderRequest[] = [];
  const provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as ProviderRequest;
    requests.push(body);
    const reply = replies.shift() ?? {};
    const headers: Record<string, string> = { "content-type": "text/event-stream" };
    if (reply.actual !== null) {
      headers["x-clankie-model-provider"] = "openai";
      headers["x-clankie-model-id"] = reply.actual ?? "gpt-5.4-mini";
    }
    response.writeHead(200, headers);
    const delta =
      reply.tool === undefined
        ? { role: "assistant", content: "VUH2109 fixture turn completed." }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: "function",
                function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) },
              },
            ],
          };
    const chunk = (choices: unknown[], usage?: unknown) =>
      response.write(
        `data: ${JSON.stringify({ id: `chat_${requests.length}`, object: "chat.completion.chunk", created: 1, model: reply.actual ?? body.model, choices, ...(usage === undefined ? {} : { usage }) })}\n\n`,
      );
    chunk([{ index: 0, delta, finish_reason: null }]);
    chunk([{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }]);
    chunk([], { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
    response.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("provider not listening");
  await promisify(execFile)(process.execPath, [join(root, "scripts/scratch-stack.mjs"), dir]);
  const env = parseEnv(await readFile(join(dir, "stack.env"), "utf8"));
  expect(env.CLANKIE_SCRATCH).toBe("1");
  Object.assign(env, {
    NODE_ENV: "test",
    VITEST: "true",
    CLANKIE_DISABLE_MODELS_FETCH: "1",
    CLANKIE_MODELS_PATH: join(dir, "catalog.json"),
  });
  await writeFile(env.CLANKIE_MODELS_PATH!, "{}");
  await writeFile(join(dir, "proof.txt"), "completed tool result");
  const target = `http://127.0.0.1:${address.port}/v1`;
  const configure = (escalation = "clankie/escalation") =>
    updateGlobalConfig(
      (config) => {
        config.enabled_providers = ["clankie", "fixture"];
        config.model ??= "clankie/default";
        config.routing = { routine_model: "clankie/default", escalate: true, escalation_model: escalation };
        config.provider = Object.fromEntries(
          ["clankie", "fixture"].map((id) => [
            id,
            {
              name: id,
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: target },
              models: Object.fromEntries(
                (id === "clankie" ? ["default", "escalation"] : ["first", "second"]).map((model) => [
                  model,
                  { name: model, limit: { context: 100000, output: 512 } },
                ]),
              ),
            },
          ]),
        );
      },
      { env },
    );
  await configure();
  let output = "";
  const start = () => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        join(root, "apps/clankie/node_modules/tsx/dist/loader.mjs"),
        join(root, "apps/clankie/src/index.ts"),
      ],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, LANG: process.env.LANG, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    return child;
  };
  let child = start();
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  };
  const host = env.CLANKIE_CAPTAIN_URL!;
  const dispatch = async (body: OperatorConversationServiceRequest, authorized = true) => {
    OperatorConversationServiceRequestSchema.parse(body);
    const response = await fetch(`${host}/operator/v1/dispatch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: `Bearer ${env.CLANKIE_CAPTAIN_TOKEN}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!authorized) return response.status;
    if (!response.ok) throw new Error(`dispatch ${response.status}: ${await response.text()}\n${output}`);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const ready = () =>
    expect
      .poll(
        async () => {
          if (child.exitCode !== null) throw new Error(output);
          try {
            return (
              await fetch(`${host}/v1/model-settings`, {
                headers: { authorization: `Bearer ${env.CLANKIE_OPERATOR_TOKEN}` },
              })
            ).status;
          } catch {
            return 0;
          }
        },
        { timeout: 45000 },
      )
      .toBe(200);
  try {
    await ready();
    const created = await dispatch({
      schemaVersion: 1,
      op: "create",
      scope: { kind: "global" },
      title: "VUH2109 routing proof",
    });
    if (typeof created === "number" || created.op !== "create") throw new Error("missing conversation");
    const id = created.conversation.conversationId;
    const replayRequest = {
      schemaVersion: 1 as const,
      op: "replay" as const,
      replay: { schemaVersion: 1 as const, conversationId: id, surfaceClientId: "routing-proof", limit: 500 },
    };
    const history = async () => {
      const result = await dispatch(replayRequest);
      if (typeof result === "number" || result.op !== "replay" || result.result.status !== "page")
        throw new Error("missing history");
      return result.result.events;
    };
    const turn = async (script: Reply[]) => {
      replies = script;
      const before = requests.length;
      const previousCursors = new Set((await history()).map((event) => event.cursor));
      const current = await dispatch({ schemaVersion: 1, op: "get", conversationId: id });
      if (typeof current === "number" || current.op !== "get" || !current.conversation)
        throw new Error("missing conversation");
      const sent = await dispatch({
        schemaVersion: 1,
        op: "send",
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: id,
          surfaceClientId: "routing-proof",
          expectedRevision: current.conversation.revision,
          message: `VUH2109 turn ${before}`,
        },
      });
      if (typeof sent === "number" || sent.op !== "send" || sent.result.status !== "accepted")
        throw new Error(`turn not accepted ${JSON.stringify(sent)}`);
      const runId = sent.result.runId;
      await expect
        .poll(
          async () =>
            (await history()).find(
              (event) => event.type === "turn" && event.runId === runId && event.phase !== "accepted",
            ),
          { timeout: 30000 },
        )
        .toMatchObject({ phase: "completed" });
      return {
        events: (await history()).filter((event) => !previousCursors.has(event.cursor)),
        calls: requests.slice(before),
        runId,
      };
    };
    const calls = (events: OperatorConversationStreamEvent[]) =>
      events.flatMap((event) =>
        event.type === "activity" && event.modelCall?.phase === "completed" ? [event.modelCall] : [],
      );
    const decisions = (events: OperatorConversationStreamEvent[]) =>
      events.flatMap((event) =>
        event.type === "activity" && event.routingDecision ? [event.routingDecision] : [],
      );
    const normal = await turn([{}]);
    expect(normal.calls.map((call) => call.model)).toEqual(["default"]);
    expect(calls(normal.events)).toMatchObject([
      {
        preference: "clankie/default",
        modelUsage: { actual: { providerId: "openai", modelId: "gpt-5.4-mini" }, source: "hosted_proxy" },
        tokens: { input: 10, output: 3, total: 13 },
      },
    ]);
    const escalated = await turn([
      { tool: "read", args: { path: join(dir, "proof.txt") } },
      { tool: "escalate", args: { reason: "careful reasoning" } },
      { actual: "gpt-5.4" },
    ]);
    expect(escalated.calls.map((call) => call.model)).toEqual(["default", "default", "escalation"]);
    const users = escalated.calls[0]!.messages.filter((message) => message.role === "user");
    expect(escalated.calls.map((call) => call.messages.filter((message) => message.role === "user"))).toEqual(
      [users, users, users],
    );
    expect(decisions(escalated.events).map((decision) => decision.outcome)).toEqual([
      "requested",
      "selected",
    ]);
    expect(calls(escalated.events).map((call) => call.modelUsage.actual?.modelId)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4-mini",
      "gpt-5.4",
    ]);
    expect(new Set(calls(escalated.events).map((call) => call.id)).size).toBe(3);
    // The completed read remains a single result in the continuing context.
    expect(
      escalated.calls[2]!.messages.filter(
        (message) =>
          message.role === "tool" && JSON.stringify(message.content).includes("completed tool result"),
      ),
    ).toHaveLength(1);
    expect(
      escalated.events.filter(
        (event) => event.type === "tool" && event.name === "read" && event.phase === "started",
      ),
    ).toHaveLength(1);
    const fallback = await turn([{ tool: "escalate" }, { actual: "gpt-5.4-mini" }]);
    expect(fallback.calls.map((call) => call.model)).toEqual(["default", "escalation"]);
    expect(calls(fallback.events)[1]!.modelUsage).toMatchObject({
      requestedRef: "clankie/escalation",
      actual: { modelId: "gpt-5.4-mini" },
    });
    await configure("clankie/missing");
    const unavailable = await turn([{ tool: "escalate" }, { actual: null }]);
    expect(unavailable.calls.map((call) => call.model)).toEqual(["default", "default"]);
    expect(decisions(unavailable.events).map((decision) => decision.outcome)).toEqual([
      "requested",
      "unavailable",
    ]);
    expect(calls(unavailable.events)[1]!.modelUsage).toEqual({
      requestedRef: "clankie/default",
      actual: null,
      source: "unavailable",
    });
    await configure();
    const selection = await fetch(`${host}/v1/model-settings`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CLANKIE_OPERATOR_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/first" }),
    });
    expect(selection.status).toBe(200);
    const pinned = await turn([{ tool: "escalate" }, {}]);
    expect(pinned.calls.map((call) => call.model)).toEqual(["first", "first"]);
    expect(pinned.calls[0]!.tools?.some((tool) => tool.function.name === "escalate")).toBe(false);
    expect(
      calls(pinned.events).every(
        (call) => call.preference === "fixture/first" && call.modelUsage.actual?.providerId === "fixture",
      ),
    ).toBe(true);
    await configure("fixture/second");
    const refused = await turn([{ tool: "escalate" }, { tool: "escalate" }, {}]);
    expect(refused.calls.map((call) => call.model)).toEqual(["first", "second", "second"]);
    expect(decisions(refused.events).map((decision) => decision.outcome)).toEqual([
      "requested",
      "selected",
      "refused",
    ]);
    const reset = await turn([{}]);
    expect(reset.calls.map((call) => call.model)).toEqual(["first"]);
    expect(
      reset.events.every(
        (event) => event.type !== "activity" || event.modelCall === undefined || event.runId === reset.runId,
      ),
    ).toBe(true);
    expect(await dispatch(replayRequest, false)).toBe(401);
    // Fresh authenticated reads retain observations after the active run unsubscribes.
    expect(
      (await history()).filter(
        (event) => event.type === "activity" && event.modelCall?.phase === "completed",
      ),
    ).toHaveLength(14);
    expect(replies).toEqual([]);
    const retained = await history();
    const metricsResponse = await fetch(`${host}${CAPTAIN_TURN_METRICS_PATH}?limit=20`, {
      headers: { authorization: `Bearer ${env.CLANKIE_OPERATOR_TOKEN}` },
    });
    expect(metricsResponse.status).toBe(200);
    const metrics = CaptainTurnMetricsPageSchema.parse(await metricsResponse.json());
    for (const run of [normal, escalated, fallback, unavailable, pinned, refused, reset]) {
      expect(metrics.items.find((item) => item.runId === run.runId)?.usage).toEqual({
        totalTokens: calls(run.events).reduce((sum, call) => sum + (call.tokens?.total ?? 0), 0),
        reports: calls(run.events).length,
      });
    }
    await stop();
    child = start();
    await ready();
    expect(await history()).toEqual(retained);
    // Opt-in receipt export for a manual evidence run; ordinary CI stays ephemeral.
    const evidenceDirectory = process.env.VUH2109_EVIDENCE_DIRECTORY;
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        join(evidenceDirectory, "turn-events.json"),
        JSON.stringify(
          { events: retained, metrics, durableReplayAfterRestart: true, unauthorizedStatus: 401 },
          null,
          2,
        ),
      );
      await writeFile(
        join(evidenceDirectory, "provider-requests.json"),
        JSON.stringify(
          requests.map(({ model, messages, tools }) => ({
            model,
            messages: messages.filter((message) => message.role !== "system"),
            tools: tools?.map((tool) => tool.function.name),
          })),
          null,
          2,
        ),
      );
    }
  } finally {
    await stop();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 120000);
