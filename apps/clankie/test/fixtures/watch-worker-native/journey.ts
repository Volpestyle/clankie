import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { guardWatchedRequests } from "../../../src/captain/watch-request.ts";
import { createWatchGate } from "../../../src/watch.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { readHerdrSeatTranscript } from "@clankie/agent-transcript";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
import { createClankieApp } from "../../../src/app.ts";
import { createStubCaptain } from "../../../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../../../src/operator-auth.ts";
import { HerdrWatchStore, createHerdrWatchRunner } from "../../../src/captain/herdr-watch.ts";
import { ClaudeHookQuestions } from "../../../src/captain/claude-hook-questions.ts";
import {
  createClaudeWorkerSeatAdapter,
  SeatHookLog,
  claudeWorkerChannelConsent,
} from "../../../src/captain/claude-worker-seat.ts";
import { connectWorkerQuestions } from "../../../src/captain/worker-question-routing.ts";
import { ConversationStore } from "../../../src/captain/conversations.ts";
import { LocalFleetLink } from "../../../src/local-fleet-link.ts";
import { localFleetProof, localProjectProof } from "../../../src/local-fleet-proof.ts";
import { requireRuntimeMachineAccess } from "../../../src/machine-access.ts";
import { isolatedHerdr } from "../local-fleet-proof/herdr-fixture.ts";

if (process.platform !== "linux" || process.env.WATCH_WORKER_NATIVE_PROOF !== "1")
  throw new Error("Run the owned Linux fixture through scripts/manual/watch-worker-questions.mjs");
const repoRoot = resolve(import.meta.dirname, "../../../../..");
const evidenceRoot = process.env.WATCH_PROOF_EVIDENCE ?? "/proof";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  label: string,
  ms = 45000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await delay(100);
  }
}
const close: (() => unknown | Promise<unknown>)[] = [];
const results: unknown[] = [];
try {
  const root = await mkdtemp("/tmp/watch-native-");
  close.push(() => rm(root, { recursive: true, force: true }));
  let allowAsk!: () => void;
  let askGate = new Promise<void>((r) => {
    allowAsk = r;
  });
  let toolResults = 0,
    messages = 0;
  let activeScenario = "";
  const consumed = new Set<string>();
  const provider = createServer((request, response) => {
    void (async () => {
      let text = "";
      for await (const chunk of request) text += String(chunk);
      if (request.url?.includes("count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"input_tokens":100}');
        return;
      }
      if (!request.url?.includes("/messages")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const body = JSON.parse(text);
      messages++;
      await writeFile(join(evidenceRoot, `provider-${messages}.json`), JSON.stringify(body, null, 2));
      const inputs = body.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
      const answered = inputs.find(
        (c: any) => c.type === "tool_result" && c.tool_use_id === `ask-framework-${activeScenario}`,
      );
      const read = inputs.find((c: any) => c.type === "tool_result" && c.tool_use_id === "read-brief");
      let block: any;
      if (answered) {
        assert.match(JSON.stringify(answered), /React/);
        toolResults++;
        consumed.add(activeScenario);
        block = { type: "text", text: "The worker received the owner answer." };
      } else if (read) {
        await askGate;
        block = {
          type: "tool_use",
          id: `ask-framework-${activeScenario}`,
          name: "AskUserQuestion",
          input: {
            questions: [
              {
                question: "Which framework?",
                header: "Framework",
                options: [
                  { label: "React", description: "Components" },
                  { label: "Vue", description: "Views" },
                ],
                multiSelect: false,
              },
            ],
          },
        };
      } else {
        const all = JSON.stringify(body.messages);
        const match = all.match(/(\/[^\s"\\]*clankie-brief-[0-9a-f-]+\.json)/);
        assert.ok(match, "Real launch must carry its native brief pointer");
        block = { type: "tool_use", id: "read-brief", name: "Read", input: { file_path: match[1] } };
      }
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (type: string, value: unknown) =>
          response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
        event("message_start", {
          type: "message_start",
          message: {
            id: "local-" + messages,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        });
        const initial = block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" };
        event("content_block_start", { type: "content_block_start", index: 0, content_block: initial });
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta:
            block.type === "tool_use"
              ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
              : { type: "text_delta", text: block.text },
        });
        event("content_block_stop", { type: "content_block_stop", index: 0 });
        event("message_delta", {
          type: "message_delta",
          delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 40 },
        });
        event("message_stop", { type: "message_stop" });
        response.end();
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "local-" + messages,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [block],
            stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 40 },
          }),
        );
      }
    })().catch((error) => {
      console.error("provider", error);
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
  close.push(async () => {
    provider.closeAllConnections();
    await new Promise<void>((r) => provider.close(() => r()));
  });
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(provider.address() as any).port}`;
  process.env.ANTHROPIC_API_KEY = "local-loopback-fixture-key";
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  process.env.DISABLE_AUTOUPDATER = "1";
  for (const scenario of ["already-watching", "already-answering"] as const) {
    activeScenario = scenario;
    const evidence = join(evidenceRoot, scenario);
    await mkdir(evidence, { recursive: true });
    const h = await isolatedHerdr(evidence);
    close.push(h.close);
    process.env.HOME = h.env.HOME;
    process.env.CLAUDE_CONFIG_DIR = h.env.CLAUDE_CONFIG_DIR;
    await mkdir(h.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    const consent = {
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      customApiKeyResponses: { approved: ["local-loopback-fixture-key".slice(-20)], rejected: [] },
      theme: "dark",
      projects: { [h.root]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    };
    await writeFile(join(h.env.HOME!, ".claude.json"), JSON.stringify(consent));
    await writeFile(join(h.env.CLAUDE_CONFIG_DIR!, ".claude.json"), JSON.stringify(consent));
    await promisify(execFile)("herdr", ["integration", "install", "claude"], { env: h.env });
    const state = join(h.root, "state");
    await mkdir(state, { recursive: true });
    h.env.CLANKIE_STATE = state; // launch-specific profile below also carries the link root.
    const settings = new SettingsStore(join(state, "settings.json"));
    await settings.update((s) => ({
      ...s,
      machineAccess: { local: "workers" },
      autonomy: {
        ...s.autonomy,
        confirmedAt: new Date().toISOString(),
        fleet: { ...s.autonomy.fleet, everydayWork: "lead" },
      },
    }));
    const hooks = new SeatHookLog(join(state, "hooks.json"));
    const registry = new ClaudeHookQuestions(join(state, "claims.json"));
    const runner = createHerdrWatchRunner(
      () => true,
      async (args, signal, timeout) => {
        const r = await promisify(execFile)("herdr", [...args], {
          env: h.env,
          timeout: timeout ?? 10000,
          maxBuffer: 2_000_000,
          ...(signal ? { signal } : {}),
        });
        return r.stdout;
      },
    );
    const adapter = createClaudeWorkerSeatAdapter({
      consent: () => claudeWorkerChannelConsent(),
      hooks,
      hookQuestions: registry,
      agent: async (pane) => runner.get(pane),
      transcript: async (a) => {
        const observed = await runner.get(a.paneId);
        return readHerdrSeatTranscript(observed.agent, observed.session);
      },
      mailbox: { bound: () => false, deliver: async () => false },
      timing: { firstTurnMs: 1000 },
    });
    // Synthetic zero-cost loopback-provider budget; no real account is installed or queried.
    const fixtureAccounts = async () => ({
      machine: "local",
      shell: "posix" as const,
      observedAt: new Date().toISOString(),
      accounts: [
        {
          harness: "claude" as const,
          label: "default",
          home: h.env.CLAUDE_CONFIG_DIR!,
          signedIn: true,
          usable: true,
          plan: "pro",
          headroom: 1,
          usage: {
            source: "claude-usage" as const,
            observedAt: new Date().toISOString(),
            windows: [{ id: "week", label: "loopback fixture", usedPercent: 0 }],
          },
        },
      ],
    });
    const watches = new HerdrWatchStore(join(state, "watches.json"), {
      runner,
      seatAdapters: [adapter],
      requireWorkerAccess: (fleet) => requireRuntimeMachineAccess(settings, fleet, "workers"),
      maximumTrustMode: async () => true,
      workerAccounts: fixtureAccounts,
      workerAccountsReport: fixtureAccounts,
      claudeAccounts: async () => [{ label: "default", home: h.env.CLAUDE_CONFIG_DIR! }],
    });
    close.push(() => watches.close());
    const conversations = new ConversationStore(join(state, "conversations"), async () => {});
    close.push(async () => conversations.close());
    const shutdown = new AbortController();
    close.push(async () => shutdown.abort());
    connectWorkerQuestions({ conversations, herdrWatches: watches, settingsStore: settings, shutdown });
    watches.questionGate = async () => "lead";
    watches.permissionLeadAllowed = async () => true;
    let leadQuestions = 0,
      modelAnswering = false;
    let sourceQuestion: any;
    let releaseModel!: () => void;
    const answerGate = new Promise<void>((r) => {
      releaseModel = r;
    });
    let originalAttempt: unknown;
    const core = createFauxCore({
      provider: "watch-proof",
      api: "faux-watch-proof",
      models: [{ id: "default" }],
    });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider("watch-proof", {
      api: "faux-watch-proof" as Api,
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "loopback",
      streamSimple: core.streamSimple,
      models: [
        {
          id: "default",
          name: "fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4000,
        },
      ],
    });
    const sm = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: h.root,
      agentDir: join(h.root, "model"),
      systemPrompt: "Answer the native worker question.",
      noExtensions: true,
      noPromptTemplates: true,
      settingsManager: sm,
    });
    await loader.reload();
    const answerTool = defineTool({
      name: "choose_native_answer",
      label: "Choose native answer",
      description: "Choose the answer to the held question",
      parameters: Type.Object({}),
      execute: async () => {
        modelAnswering = true;
        await answerGate;
        const current = await runner.get(sourceQuestion.ref.paneId);
        originalAttempt = await watches.answerSeatQuestion(
          current.terminalId,
          { requestId: sourceQuestion.q.requestId, answers: { q0: { answers: ["Vue"] } } },
          { owner: { conversationId: "global-default" }, current: () => true, authorize: async () => true },
        );
        assert.equal((originalAttempt as any).outcome, "undelivered");
        return {
          content: [{ type: "text" as const, text: "Watch routes this question to the owner." }],
          details: undefined,
        };
      },
    });
    const { session: modelSession } = await createAgentSession({
      cwd: h.root,
      model: runtime.getModel("watch-proof", "default") as Model<Api>,
      thinkingLevel: "off",
      modelRuntime: runtime,
      customTools: [answerTool],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(h.root),
      settingsManager: sm,
      noTools: "builtin",
    });
    guardWatchedRequests(modelSession, createWatchGate(settings));
    await modelSession.bindExtensions({ mode: "print" });
    close.push(async () => {
      releaseModel();
      modelSession.dispose();
    });
    core.setResponses([
      fauxAssistantMessage(fauxToolCall("choose_native_answer", {})),
      fauxAssistantMessage("No follow-up on Watch"),
    ]);
    watches.start(async (_id, text, _discord, guard) => {
      await guard?.();
      assert.notEqual((await settings.load()).autonomy.watch, true, "No lead delivery on Watch");
      leadQuestions++;
      // allow-swallowed-rejection -- Watch deliberately stops this held deterministic lead turn.
      void modelSession.prompt(text, { expandPromptTemplates: false }).catch(() => {});
      return "accepted";
    });
    const binding = { runtime: "external" as const, socketPath: h.socketPath, session: "default" };
    const prove = localFleetProof({
      herdrBinary: join(repoRoot, ".data/herdr/bin/herdr"),
      processHelper: join(repoRoot, ".local/fleet-proof/native-process-proof"),
      binding: async () => binding,
    });
    const project = localProjectProof({
      herdrBinary: join(repoRoot, ".data/herdr/bin/herdr"),
      processHelper: join(repoRoot, ".local/fleet-proof/native-process-proof"),
      binding: async () => binding,
    });
    const link = new LocalFleetLink({
      directory: join(h.env.HOME!, ".clankie", "links"),
      binding: async () => binding,
      prove,
      projectProof: project,
    });
    close.push(() => link.close());
    const credentials = new FileCredentialStore(join(state, "credentials.json"));
    const owner = await ensureOperatorCredential({ env: {}, store: credentials });
    const routes: string[] = [];
    let nativeAsks = 0;
    const app = await createClankieApp({
      settings,
      localFleet: link,
      authenticateCaptain: async () => undefined,
      authenticateOperator: createCredentialBackedOperatorAuthenticator({
        env: {},
        store: credentials,
        identity: { operatorId: "local-owner", steerSourceLane: "tui" },
      }),
      captain: createStubCaptain({
        serveOperatorConversation: (request, auth) => conversations.serve(request as any, auth) as any,
        recordSeatHook: async (pane, hook, _proof, signal, progress) => {
          const agent = await runner.get(pane);
          if (agent.session?.value !== hook.sessionId) return false;
          const ref = { harness: "claude" as const, paneId: pane, sessionId: hook.sessionId };
          if (hook.deliveredQuestionId) return registry.acknowledge(ref, hook.deliveredQuestionId);
          if (
            hook.event === "PermissionRequest" ||
            (hook.event === "PreToolUse" && hook.toolName === "AskUserQuestion")
          ) {
            nativeAsks++;
            const hookOutput = await registry.open(
              ref,
              hook,
              (q) => {
                sourceQuestion = { q, ref };
                return watches.forwardNativeQuestion(ref, q, (route) => {
                  routes.push(route);
                  progress?.(route);
                });
              },
              signal,
              agent.workingDirectory,
            );
            return { recorded: true, hookOutput: { ...hookOutput } };
          }
          hooks.record(pane, hook);
          return true;
        },
      }),
    });
    close.push(async () => app.close());
    const nativeFetch = link.fetch((request) => app.app.fetch(request));
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, env) => {
        const path = new URL(request.url).pathname;
        const response = await (path === OPERATOR_CONVERSATION_DISPATCH_PATH
          ? app.app.fetch(request)
          : nativeFetch(request, env));
        if (path.endsWith("/hook"))
          console.log("hook-http", response.status, response.ok ? "ok" : await response.clone().text());
        return response;
      },
    });
    if (!server.listening) await new Promise<void>((r) => server.once("listening", r));
    close.push(async () => {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    // The registry mints the link for this exact owned Herdr namespace.
    await link.publish((server.address() as any).port);
    const hired = await watches.spawnSeat(
      {
        schemaVersion: 1,
        harness: "claude",
        title: "Watch loopback proof",
        workingDirectory: h.root,
        effort: "medium",
        effortReason: "Prove owner feed native answers without a paid model",
      },
      undefined,
      "Ask which framework the owner wants; then report the answer.",
      undefined,
      { owner: { conversationId: "global-default" }, current: () => true, authorize: async () => true },
    );
    await writeFile(join(evidence, "hire.json"), JSON.stringify(hired, null, 2));
    if (hired.outcome !== "spawned") {
      await writeFile(
        join(evidence, "snapshot.json"),
        JSON.stringify(await h.cli("api", "snapshot"), null, 2),
      );
      await writeFile(
        join(evidence, "pane.txt"),
        await runner.readPane!((hired as any).paneId ?? "w1:p3", "visible", "text"),
      );
    }
    assert.equal(hired.outcome, "spawned", JSON.stringify(hired));
    let done = false;
    close.push(async () => {
      if (!done) {
        console.error(
          JSON.stringify({ scenario, nativeAsks, messages, routes, sourceQuestion, modelAnswering }),
        );
        await writeFile(
          join(evidence, "native-pane.txt"),
          await runner.readPane!((hired as any).seat.paneId, "visible", "text"),
        );
        await writeFile(
          join(evidence, "native-transcript.json"),
          JSON.stringify(await runner.transcript!(await runner.get((hired as any).seat.paneId)), null, 2),
        );
      }
    });
    const call = async (request: any) => {
      const response = await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, url), {
        method: "POST",
        headers: { authorization: `Bearer ${owner.token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as any;
    };
    if (scenario === "already-watching")
      await settings.update((s) => ({ ...s, autonomy: { ...s.autonomy, watch: true } }));
    allowAsk();
    if (scenario === "already-answering") {
      await until(() => (modelAnswering ? true : undefined), "built-in answering state");
      await settings.update((s) => ({ ...s, autonomy: { ...s.autonomy, watch: true } }));
    }
    const ask = await until(async () => {
      const page = await call({ schemaVersion: 1, op: "input_list" });
      return page.result.questions[0];
    }, "owner feed");
    if (scenario === "already-answering") {
      releaseModel();
      await until(() => (originalAttempt !== undefined ? true : undefined), "original model answer refused");
    }
    const request = {
      schemaVersion: 1,
      op: "input_answer",
      conversationId: ask.conversationId,
      requestId: ask.question.requestId,
      incarnationId: ask.incarnationId,
      expectedRevision: ask.revision,
      answer: { kind: "worker", answers: { q0: { answers: ["React"] } } },
    };
    const answered = await call(request);
    assert.equal(answered.result.status, "resolved");
    assert.equal(answered.result.question.reason, undefined);
    await until(() => (consumed.has(scenario) ? true : undefined), "real Claude tool_result consumption");
    await until(
      () => (hooks.latest(sourceQuestion.ref.sessionId)?.type === "turn_completed" ? true : undefined),
      "native completion hook",
    );
    assert.deepEqual(await call(request), answered);
    assert.equal(nativeAsks, 1);
    assert.equal(leadQuestions, scenario === "already-answering" ? 1 : 0);
    assert.ok(routes.includes("owner_feed"));
    results.push({
      scenario,
      nativeAsks,
      leadQuestions,
      routes,
      askId: ask.question.requestId,
      nativeRequest: ask.question.workerQuestion.requestId,
      answerStatus: answered.result.status,
      toolResults,
      originalAttempt,
    });
    await writeFile(join(evidence, "result.json"), JSON.stringify(results.at(-1), null, 2));
    done = true;
    await h.close();
    askGate = new Promise<void>((r) => {
      allowAsk = r;
    });
  }
  await writeFile(join(evidenceRoot, "result.json"), JSON.stringify({ result: "passed", results }, null, 2));
  console.log(JSON.stringify({ result: "passed", results }));
} finally {
  for (const action of close.reverse())
    await Promise.resolve()
      .then(action)
      .catch((error) => console.error("cleanup", String(error)));
}
