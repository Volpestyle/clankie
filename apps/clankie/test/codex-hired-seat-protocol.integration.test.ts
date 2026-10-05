import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OperatorFleetSeatSchema } from "@clankie/protocol";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import { HerdrWatchStore, parseHerdrAgentResult } from "../src/captain/herdr-watch.ts";
import { readFleet } from "../src/captain/herdr-census.ts";
import { codex0160Protocol } from "./fixtures/codex-0160-protocol.ts";

async function hiredFixture(options: Parameters<typeof codex0160Protocol>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "codex-hire-protocol-"));
  const native = await codex0160Protocol(directory, options);
  const pane = {
    pane_id: "w1:p1",
    terminal_id: "term_protocol",
    agent: "codex",
    agent_status: "idle",
    terminal_title: "Protocol hire",
    cwd: directory,
    agent_session: { source: "herdr:codex", kind: "path", value: native.rolloutPath },
  };
  const snapshot = () => parseHerdrAgentResult(JSON.stringify({ result: { agent: pane } }));
  const reports: string[][] = [];
  const adapter = createCodexSeatAdapter({
    server: native.launch,
    trackerOverrides: async () => [],
    herdr: async (args) => {
      reports.push([...args]);
      if (args[1] === "report-agent") pane.agent_status = args[args.indexOf("--state") + 1]!;
    },
  });
  const fallback = vi.fn(async () => {
    throw new Error("No terminal or native queue fallback is permitted");
  });
  const owner: ConversationAuthority = {
    owner: { conversationId: "exact-hiring-lead" },
    current: () => true,
    authorize: async () => true,
  };
  const wakes: { conversationId: string; text: string }[] = [];
  const store = new HerdrWatchStore(join(directory, "watches.json"), {
    seatAdapters: [adapter],
    summariesPath: join(directory, "summaries.json"),
    // Host-provided fixture preallocation skips account subprocess probes;
    // it neither signs in nor replaces the actual adapter/client transport.
    nativeLaunchPolicy: {
      admit: async () => {},
      prepare: async () => ({
        account: { label: "protocol-fixture", home: directory },
        args: [],
        env: { CODEX_HOME: directory },
      }),
    },
    runner: {
      createTab: async () => pane.pane_id,
      startAgent: async ({ args }) => {
        expect(args).toContain(native.endpoint);
        native.startView();
      },
      get: async () => snapshot(),
      resolveTerminal: async () => snapshot(),
      wait: fallback,
      runInPane: fallback,
      codexQueue: fallback,
      closePane: async () => {},
    },
  });
  store.start(async (conversationId, text, _discord, guard) => {
    await guard?.();
    wakes.push({ conversationId, text });
  });
  const census = () =>
    readFleet({
      summaries: {},
      runCommand: async (_command, args) => ({
        stdout:
          args[0] === "agent"
            ? JSON.stringify({ result: { agents: [pane] } })
            : JSON.stringify({ result: { snapshot: {} } }),
        stderr: "",
      }),
    });
  const close = async () => {
    store.close();
    await (
      await adapter.attach({ harness: "codex", paneId: pane.pane_id, sessionId: native.threadId })
    )?.close();
    await native.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    expect(
      await store.spawnSeat(
        { schemaVersion: 1, harness: "codex", title: "Protocol hire", workingDirectory: directory },
        undefined,
        "Initial brief",
        undefined,
        owner,
      ),
    ).toMatchObject({ outcome: "spawned", control: { mode: "adapter" } });
    const control = await adapter.attach({
      harness: "codex",
      paneId: pane.pane_id,
      sessionId: native.threadId,
    });
    expect(control).toBeDefined();
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(reports.some((args) => args.includes(native.threadId))).toBe(true);
    return { native, pane, adapter, control: control!, store, owner, wakes, fallback, census, close };
  } catch (error) {
    await close();
    throw error;
  }
}

it("routes path-bound Codex 0.160 async questions to the hiring lead and waits for proven native idle after owner abort", async () => {
  const { native, pane, control, store, owner, wakes, fallback, census, close } = await hiredFixture();
  try {
    await native.ask("call-foreign", "Foreign question must not reach this lead", "another-thread");
    await native.ask("call-native");
    await vi.waitFor(() => expect(wakes.filter(({ text }) => text.includes("call-native"))).toHaveLength(1));
    const questionWake = wakes.find(({ text }) => text.includes("call-native"))!;
    expect(questionWake.conversationId).toBe(owner.owner.conversationId);
    expect(questionWake.text).toContain("questionAnswer");
    expect(questionWake.text).toContain("Which worktree should I use?");
    expect(questionWake.text).toContain('"isBlocking": false');
    expect(wakes.some(({ text }) => text.includes("call-foreign"))).toBe(false);
    const observed = await census();
    expect(observed.seats[0]?.session).toEqual(pane.agent_session);
    const roster = observed.seats.map((seat) =>
      OperatorFleetSeatSchema.parse({
        seatId: seat.seatId,
        occupantId: seat.occupantId,
        personaId: seat.subject,
        harness: seat.harness,
        status: seat.status,
        title: seat.title,
      }),
    );
    expect(await store.withNativeStatus(roster, observed.seats)).toMatchObject([
      { summary: "Waiting on a question (call-native)" },
    ]);
    const turnsBeforeAnswer = native.requests.filter(({ method }) => method === "turn/start").length;
    expect(await store.deliverToSeat(pane.terminal_id, "Ordinary message while async pending")).toMatchObject(
      {
        outcome: "delivered",
        state: "steered",
      },
    );
    const questionId = JSON.stringify(["request_user_input_async", "call-native", 0]);
    const answer = { requestId: "call-native", answers: { [questionId]: { answers: ["Task worktree"] } } };
    expect(await store.answerSeatQuestion(pane.terminal_id, answer, owner)).toMatchObject({
      outcome: "delivered",
      deliveryStage: "responded",
    });
    const answerRpc = native.requests.filter(({ method }) => method === "turn/steer").at(-1)!;
    expect(answerRpc.params).toMatchObject({
      threadId: native.threadId,
      expectedTurnId: "turn-1",
      clientUserMessageId: expect.any(String),
    });
    expect(answerRpc.params.input).toEqual([
      {
        type: "text",
        text: `<send_user_message_question_reply>\n${JSON.stringify([{ answer: "Task worktree", question: "Which worktree should I use?", questionItemId: questionId }])}\n</send_user_message_question_reply>`,
        text_elements: [],
      },
    ]);
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(turnsBeforeAnswer);
    expect(native.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    expect(await store.answerSeatQuestion(pane.terminal_id, answer, owner)).toMatchObject({
      outcome: "undelivered",
    });
    expect(native.requests.filter(({ method }) => method === "turn/steer")).toHaveLength(2);
    native.notify("turn/completed", {
      threadId: native.threadId,
      turn: { id: "stale-turn", status: "completed", items: [] },
    });
    await vi.waitFor(async () => expect(await control!.status()).toBe("working"));
    // Owner Esc is observed, never issued by Clankie. A missed terminal event
    // is reconciled from the exact thread's terminal turn on native idle.
    const idleSnapshot = native.holdNextRead();
    native.finish("interrupted", "Owner interrupted this turn", false);
    await idleSnapshot.pending;
    const startsBeforeIdle = native.requests.filter(({ method }) => method === "turn/start").length;
    let dispatched = false;
    const pendingFollowup = store
      .deliverToSeat(pane.terminal_id, "Follow-up after owner abort")
      .then((result) => {
        dispatched = true;
        return result;
      });
    // Let the real socket/control dispatch advance while its native snapshot
    // is held. No new mutation may pass this missing terminal-turn proof.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched).toBe(false);
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(startsBeforeIdle);
    idleSnapshot.release();
    expect(await pendingFollowup).toMatchObject({ outcome: "delivered", state: "started" });
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(
      startsBeforeIdle + 1,
    );
    await vi.waitFor(() => expect(wakes.some(({ text }) => text.includes("interrupted"))).toBe(true));
    await store.watch(owner.owner.conversationId, pane.pane_id, "Harvest this follow-up");
    const slowIdleSnapshot = native.holdNextRead();
    native.finish("completed", "Finished first follow-up", false);
    await slowIdleSnapshot.pending;
    const nextFollowup = store.deliverToSeat(pane.terminal_id, "Next follow-up");
    // Exact terminal notification releases pending delivery immediately, even
    // if the earlier idle snapshot never replies. Its late reply must not
    // clear the newly started turn.
    native.notify("turn/completed", { threadId: native.threadId, turn: native.turns.at(-1)! });
    expect(await nextFollowup).toMatchObject({ outcome: "delivered", state: "started" });
    slowIdleSnapshot.release();
    await vi.waitFor(async () => expect(await control!.status()).toBe("working"));
    await store.watch(owner.owner.conversationId, pane.pane_id, "Harvest this follow-up");
    native.finish("completed", "Finished Next follow-up");
    await vi.waitFor(async () => expect(await control!.status()).toBe("idle"));
    await vi.waitFor(() =>
      expect(wakes.some((wake) => wake.text.includes("Finished Next follow-up"))).toBe(true),
    );
    expect(
      native.requests.filter(({ method }) => method === "turn/start").map(({ params }) => params.input),
    ).toEqual([
      [{ type: "text", text: "Initial brief", text_elements: [] }],
      [{ type: "text", text: "Follow-up after owner abort", text_elements: [] }],
      [{ type: "text", text: "Next follow-up", text_elements: [] }],
    ]);
    expect(wakes.every(({ conversationId }) => conversationId === owner.owner.conversationId)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(native.errors).toEqual([]);
  } finally {
    await close();
  }
});

it("hydrates an async question completed before subscription, then answers once through a native idle turn", async () => {
  const title = "é\n".repeat(250);
  const { native, pane, control, store, owner, wakes, fallback, census, close } = await hiredFixture({
    initialQuestion: { callId: "call-fast", title },
  });
  try {
    await vi.waitFor(() => expect(wakes.filter(({ text }) => text.includes("call-fast"))).toHaveLength(1));
    expect(await control.status()).toBe("idle");
    expect(await control.statusReason?.()).toBe("Waiting on a question (call-fast)");
    const observed = await census();
    const roster = observed.seats.map((seat) =>
      OperatorFleetSeatSchema.parse({
        seatId: seat.seatId,
        occupantId: seat.occupantId,
        personaId: seat.subject,
        harness: seat.harness,
        status: seat.status,
        title: seat.title,
      }),
    );
    expect(await store.withNativeStatus(roster, observed.seats)).toMatchObject([
      { status: "idle", summary: "Waiting on a question (call-fast)" },
    ]);
    const questionId = JSON.stringify(["request_user_input_async", "call-fast", 0]);
    const answer = { requestId: "call-fast", answers: { [questionId]: { answers: ["Task worktree"] } } };
    expect(await store.answerSeatQuestion(pane.terminal_id, answer, owner)).toMatchObject({
      outcome: "delivered",
      deliveryStage: "responded",
    });
    const starts = native.requests.filter(({ method }) => method === "turn/start");
    expect(starts).toHaveLength(2);
    expect(starts[1]!.params).toMatchObject({
      threadId: native.threadId,
      clientUserMessageId: expect.any(String),
    });
    expect(starts[1]!.params.input).toEqual([
      {
        type: "text",
        text: `<send_user_message_question_reply>\n${JSON.stringify([{ answer: "Task worktree", question: "é ".repeat(170) + "é", questionItemId: questionId }])}\n</send_user_message_question_reply>`,
        text_elements: [],
      },
    ]);
    expect(await store.answerSeatQuestion(pane.terminal_id, answer, owner)).toMatchObject({
      outcome: "undelivered",
    });
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(2);
    expect(native.requests.some(({ method }) => method === "turn/steer" || method === "turn/interrupt")).toBe(
      false,
    );
    expect(wakes.every(({ conversationId }) => conversationId === owner.owner.conversationId)).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(native.errors).toEqual([]);
  } finally {
    await close();
  }
});

it("keeps an async answer unconfirmed without its correlated user-message receipt and refuses duplicate dispatch", async () => {
  const { native, pane, store, owner, wakes, fallback, close } = await hiredFixture();
  try {
    await native.ask("call-accepted-only");
    await vi.waitFor(() =>
      expect(wakes.filter(({ text }) => text.includes("call-accepted-only"))).toHaveLength(1),
    );
    native.omitAnswerReceipt();
    const questionId = JSON.stringify(["request_user_input_async", "call-accepted-only", 0]);
    const answer = {
      requestId: "call-accepted-only",
      answers: { [questionId]: { answers: ["Task worktree"] } },
    };
    // The original tool's accepted:true is already present in this native
    // rollout. Only a matching userMessage.clientId+content can confirm an answer.
    expect(await store.answerSeatQuestion(pane.terminal_id, answer, owner)).toMatchObject({
      outcome: "unconfirmed",
    });
    const mutations = native.requests.filter(
      ({ method }) => method === "turn/start" || method === "turn/steer",
    );
    expect(mutations.map(({ method }) => method)).toEqual(["turn/start", "turn/steer"]);
    expect(await store.answerSeatQuestion(pane.terminal_id, answer, owner)).toMatchObject({
      outcome: "undelivered",
    });
    expect(
      native.requests.filter(({ method }) => method === "turn/start" || method === "turn/steer"),
    ).toHaveLength(2);
    expect(native.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
    expect(native.errors).toEqual([]);
  } finally {
    await close();
  }
});
