import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import type { CodexSeatEvent } from "../src/captain/codex-app-server.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import type { SeatQuestionAnswer } from "@clankie/agent-hosts";

const authority = (conversationId = "lead-a"): ConversationAuthority => ({
  owner: { conversationId },
  current: () => true,
  authorize: async () => true,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(owner?: ConversationAuthority) {
  const root = await mkdtemp(join(tmpdir(), "codex-hire-test-"));
  // The controller is a fixture; never depend on or probe the developer's sign-in.
  await writeFile(join(root, "auth.json"), "fixture presence only");
  let event: (event: CodexSeatEvent) => void = () => undefined;
  const emit = (method: string, turn: Record<string, unknown>) =>
    event({ method, params: { threadId: "thread", turn } });
  const question = (requestId: string | number = "question-1") =>
    event({
      method: "item/tool/requestUserInput",
      requestId,
      params: {
        threadId: "thread",
        turnId: "turn",
        itemId: "call1",
        isBlocking: true,
        questions: [
          { id: "scope", header: "Scope", question: "Which package should I change?", options: null },
        ],
      },
    });
  const answerQuestion = vi.fn(async (answer: SeatQuestionAnswer, guard?: () => Promise<void>) => {
    try {
      await guard?.();
    } catch (error) {
      return { outcome: "refused" as const, detail: String(error) };
    }
    event({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: answer.requestId } });
    return { outcome: "answered" as const, deliveryStage: "responded" as const };
  });
  const close = vi.fn(async () => undefined);
  const send = vi.fn(async () => {
    emit("turn/started", { id: "turn" });
    return { turnId: "turn", state: "started" as const };
  });
  const adapter = createCodexSeatAdapter({
    trackerOverrides: async () => [],
    start: async (options) => {
      event = options.onEvent!;
      await options.startView(["--remote", "unix:///owned"]);
      return {
        threadId: "thread",
        viewArgs: ["--remote", "unix:///owned", "resume", "thread"],
        send,
        close,
        answerQuestion,
        interrupt: async () => true,
      };
    },
    herdr: async () => undefined,
  });
  // The native TUI can still look idle while the app-server is working.
  let agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_test",
    agent: "codex",
    status: "idle",
    title: "Test",
    session: { source: "herdr:codex", kind: "id", value: "thread" },
  };
  const promptAgent = vi.fn(async () => undefined);
  const terminalInput = { promptAgent };
  const runInPane = vi.fn(async () => undefined);
  const startAgent = vi.fn(async () => undefined);
  const wake = vi.fn(async () => undefined);
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    seatAdapters: [adapter],
    codexAccounts: async () => [{ label: "fixture", home: root }],
    runner: {
      createTab: async () => agent.paneId,
      startAgent,
      get: async () => agent,
      resolveTerminal: async () => agent,
      wait: async () => agent,
      runInPane,
      ...terminalInput,
      closePane: async () => undefined,
    },
    summariesPath: join(root, "summaries.json"),
  });
  store.start(wake);
  cleanups.push(async () => {
    store.close();
    await (await adapter.attach({ harness: "codex", sessionId: "thread", paneId: agent.paneId }))?.close();
    await rm(root, { recursive: true, force: true });
  });
  const hired = await store.spawnSeat(
    { schemaVersion: 1, harness: "codex", title: "Test", workingDirectory: root },
    undefined,
    "first brief",
    undefined,
    owner,
  );
  expect(hired).toMatchObject({ outcome: "spawned" });
  return {
    store,
    get agent() {
      return agent;
    },
    replaceOccupant() {
      agent = { ...agent, session: { source: "herdr:codex", kind: "id", value: "replacement" } };
    },
    emit,
    close,
    send,
    promptAgent,
    runInPane,
    startAgent,
    wake,
    question,
    answerQuestion,
  };
}

it("forwards question text and exact answer address to the hiring conversation, then answers through control", async () => {
  const owner = authority();
  const f = await fixture(owner);
  f.question();
  await vi.waitFor(() => expect(f.wake).toHaveBeenCalled());
  expect(f.wake).toHaveBeenCalledWith(
    "lead-a",
    expect.stringContaining("Which package should I change?"),
    undefined,
    expect.any(Function),
  );
  const text = f.wake.mock.calls.flat().join(" ");
  expect(text).toContain("term_test");
  expect(text).toContain("question-1");
  expect(text).toContain("questionAnswer");
  const answer = { requestId: "question-1", answers: { scope: { answers: ["clankie"] } } };
  expect(await f.store.answerSeatQuestion("term_test", answer, owner)).toMatchObject({
    outcome: "delivered",
    deliveryStage: "responded",
  });
  expect(f.answerQuestion).toHaveBeenCalledWith(answer, expect.any(Function));
  expect(f.send).toHaveBeenCalledOnce();
  expect(f.promptAgent).not.toHaveBeenCalled();
  f.emit("turn/completed", {
    id: "turn",
    status: "completed",
    items: [{ type: "agentMessage", text: "finished after answer" }],
  });
  await vi.waitFor(() => expect(f.wake.mock.calls.flat().join(" ")).toContain("finished after answer"));
});

it.each(["owner", "occupant", "grant"])(
  "refuses an answer when the %s changes before native dispatch",
  async (changed) => {
    let allowed = true;
    const owner = { ...authority(), authorize: async () => allowed };
    const f = await fixture(owner);
    f.question();
    await vi.waitFor(() => expect(f.wake).toHaveBeenCalled());
    if (changed === "owner") await f.store.adoptSeat("term_test", authority("lead-b"));
    if (changed === "occupant") f.replaceOccupant();
    if (changed === "grant") allowed = false;
    const promise = f.store.answerSeatQuestion(
      "term_test",
      { requestId: "question-1", answers: { scope: { answers: ["clankie"] } } },
      owner,
    );
    if (changed === "grant") await expect(promise).rejects.toThrow();
    else expect(await promise).toMatchObject({ outcome: "undelivered" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.promptAgent).not.toHaveBeenCalled();
  },
);

it("hires, messages, and waits for Codex protocol completion even while the native view looks idle", async () => {
  const f = await fixture();
  expect(f.send).toHaveBeenCalledWith("first brief", expect.any(Function));
  expect(f.startAgent).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "codex",
      paneId: "w1:p1",
      args: ["--remote", "unix:///owned"],
    }),
  );
  expect(f.runInPane).not.toHaveBeenCalled();
  expect(await f.store.sendToSeat(f.agent.terminalId, "follow-up")).toBe(true);
  expect(f.send).toHaveBeenLastCalledWith("follow-up");
  expect(f.promptAgent).not.toHaveBeenCalled();
  await f.store.watch("global-default", f.agent.paneId, "harvest protocol completion");
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.wake).not.toHaveBeenCalled();
  f.emit("turn/completed", {
    id: "turn",
    status: "completed",
    items: [{ type: "agentMessage", text: "protocol final" }],
  });
  await vi.waitFor(() => expect(f.wake).toHaveBeenCalled());
  expect(f.wake.mock.calls.flat().join(" ")).toContain("protocol final");
});

it("closing a hired pane also closes its protocol controller", async () => {
  const f = await fixture();
  expect(await f.store.closeSeat(f.agent.terminalId)).toBe(true);
  expect(f.close).toHaveBeenCalledTimes(1);
});

vi.mock("../../../packages/settings/src/codex-rate-limits.ts", () => ({
  readCodexHookTrust: vi.fn(async () => "unknown"),
  readCodexRateLimits: vi.fn(async () => null),
}));
