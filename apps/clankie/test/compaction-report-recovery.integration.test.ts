import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createDurableSessions } from "../src/captain/durable-sessions.ts";
import { runDurableTurn } from "../src/captain/captain-session.ts";
import { CONVERSATION_RUN_STALL_MS } from "../src/captain/conversation-run.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import type { LaneSession } from "../src/captain/captain-types.ts";

it.each([
  ["operator", "operator"],
  ["ask-social", "discord_presence"],
  ["discord", "discord_presence"],
] as const)(
  "%s drains a queued report, watch and owner input after abandoning stalled compaction",
  async (namespace, laneKind) => {
    const root = await mkdtemp(join(tmpdir(), "compaction-report-"));
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(body);
      // The first request is a real Pi summarization. Leave it silent until the
      // production watchdog abandons it; later model calls answer normally.
      if (body.includes("You are a context summarization assistant")) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": pending compaction\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'data: {"id":"local","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{"role":"assistant","content":"Received"},"finish_reason":null}]}\n\ndata: {"id":"local","object":"chat.completion.chunk","created":1,"model":"local","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture listener");
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    runtime.registerProvider("local", {
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture",
      models: [
        {
          id: "local",
          name: "Disposable model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 128,
        },
      ],
    });
    const dir = join(root, "pi");
    const oversized = SessionManager.create(root, dir);
    oversized.appendMessage({ role: "user", content: "Earlier owner request", timestamp: Date.now() });
    oversized.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old context ".repeat(3000) }],
      api: "openai-completions",
      provider: "local",
      model: "local",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 7800,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 7900,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const sessions = new Map<string, Promise<LaneSession>>();
    const built: string[] = [];
    let compactionStarted = false;
    const durable = createDurableSessions({
      sessions,
      recoveryContext: (id) => store.compactionRecoveryContext(id),
      buildSession: async (_lane, sessionManager) => {
        built.push(sessionManager.getSessionId());
        const settingsManager = SettingsManager.inMemory({
          retry: { enabled: false },
          compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 500 },
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd: root,
          agentDir: root,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          systemPrompt: "Disposable service lead.",
          settingsManager,
        });
        await resourceLoader.reload();
        const { session } = await createAgentSession({
          cwd: root,
          modelRuntime: runtime,
          model: runtime.getModel("local", "local")!,
          sessionManager,
          settingsManager,
          resourceLoader,
          noTools: "builtin",
          thinkingLevel: "off",
        });
        await session.bindExtensions({ mode: "print" });
        session.subscribe((event) => {
          if (event.type === "compaction_start") compactionStarted = true;
        });
        return { session, capture: { shell: false } } as LaneSession;
      },
    });
    const ran: string[] = [];
    const store = new ConversationStore(join(root, "conversations"), async (id, prompt, publish, context) => {
      await store.runWithConversationDriver(
        id,
        () => undefined,
        async (run) => {
          const lane = await durable(
            namespace === "discord" ? "discord:fixture" : `${namespace}:${id}`,
            laneKind,
            dir,
            false,
            root,
            false,
            run,
            false,
            namespace === "discord" ? id : undefined,
          );
          const unsubscribe = lane.session.subscribe((event) => run.observe(event));
          try {
            await run.wait("Pi execution", runDurableTurn(lane, prompt, [], { signal: run.signal }));
            ran.push(prompt);
            context.deliveryReceipt?.("responded");
            publish({
              type: "message",
              role: "captain",
              text: lane.session.getLastAssistantText() ?? "",
              streaming: false,
            });
          } finally {
            unsubscribe();
          }
        },
        context.signal,
      );
    });
    const agent = {
      paneId: "fixture:p1",
      terminalId: "fixture-worker",
      title: "Disposable worker",
      agent: "codex",
      status: "working",
      session: { source: "herdr:codex", kind: "id" as const, value: "disposable-worker" },
    };
    let finishWorker!: () => void;
    const workerFinished = new Promise<void>((resolve) => {
      finishWorker = resolve;
    });
    const watches = new HerdrWatchStore(join(root, "watches.json"), {
      available: () => true,
      runner: {
        get: async () => agent,
        resolveTerminal: async () => agent,
        wait: async () => {
          await workerFinished;
          return { ...agent, status: "idle" };
        },
      },
    });
    let watchAccepted = false;
    watches.start(async (id, prompt) => {
      store.submitInternal(id, prompt, "watch");
      watchAccepted = true;
    });
    const receipts = new InboundSeatReceipts(join(root, "receipts.json"), store);
    try {
      // Both durable lane namespaces use the same retained service conversation.
      const conversation = "global-default";
      // Publish the original owner request into the real durable conversation log.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const first = await store.serve({
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: conversation,
          surfaceClientId: "fixture",
          expectedRevision: 0,
          message: "Owner turn before stall",
        },
      });
      expect(first.op).toBe("send");
      await expect.poll(() => compactionStarted && requests.length >= 1).toBe(true);
      const watch = await watches.watch(conversation, agent.paneId, "Harvest disposable worker");
      expect(watch.outcome).toBe("watching");
      const delivery = { id: randomUUID(), binding: "a".repeat(64) };
      expect(
        receipts.accept(
          agent.paneId,
          delivery,
          "Worker report after compaction",
          "Worker report after compaction",
          conversation,
          undefined,
          undefined,
          { kind: "conversation", owner: { conversationId: conversation } },
        ),
      ).toMatchObject({ received: true });
      await store.serve({
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: conversation,
          surfaceClientId: "fixture",
          expectedRevision: store.conversation(conversation)!.revision,
          message: "Queued owner follow-up",
          delivery: "queue",
        },
      });
      finishWorker();
      await expect.poll(() => watchAccepted).toBe(true);
      await delay(20); // Let the local HTTP client receive the pending stream headers.
      // Run the real five-minute watchdog with a virtual clock; no paid model or live lane.
      await vi.advanceTimersByTimeAsync(CONVERSATION_RUN_STALL_MS + 1);
      vi.useRealTimers();
      await expect.poll(() => ran.length, { timeout: 5000 }).toBe(3);
      await store.close();
      expect(ran).toContain("Worker report after compaction");
      expect(ran).toContain("Queued owner follow-up");
      expect(store.inboundReports(conversation)).toMatchObject([{ reportDelivery: { state: "delivered" } }]);
      const recoveredRequests = requests.filter((body) =>
        body.includes("[Conversation context after a stalled compaction."),
      );
      expect(recoveredRequests.length).toBeGreaterThanOrEqual(3);
      expect(recoveredRequests.some((body) => body.includes("old context "))).toBe(false);
      expect(await readFile(join(root, "conversations", conversation, "events.jsonl"), "utf8")).toContain(
        "conversation_turn_stalled",
      );
      expect(
        requests.some((body) => {
          const messages = JSON.parse(body).messages;
          return messages
            .at(-1)
            ?.content?.some?.((part: { text?: string }) => part.text === "Owner turn before stall");
        }),
      ).toBe(false);
      expect(built[0]).toBe(oversized.getSessionId());
      expect(built[1]).not.toBe(built[0]);
      expect(receipts.status(agent.paneId, delivery.binding, delivery.id)?.deliveryStage).toBe("responded");
      expect(recoveredRequests.join("\n")).toContain("Owner turn before stall");
      expect(recoveredRequests.join("\n")).toContain("Queued owner follow-up");
      expect(await readFile(oversized.getSessionFile()!, "utf8")).toContain("clankie-compaction-stalled");
    } finally {
      vi.useRealTimers();
      finishWorker();
      watches.close();
      const events = (await readFile(join(root, "conversations", "global-default", "events.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const event of events)
        if (event.type === "turn" && event.phase === "accepted") store.cancel("global-default", event.runId);
      await store.close();
      for (const pending of sessions.values()) (await pending).session.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
