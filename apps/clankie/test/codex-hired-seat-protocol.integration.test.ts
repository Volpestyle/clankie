import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OperatorFleetSeatSchema } from "@clankie/protocol";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import { HerdrWatchStore, parseHerdrAgentResult } from "../src/captain/herdr-watch.ts";
import { readFleet } from "../src/captain/herdr-census.ts";
import { PersonaStore } from "../src/captain/personas.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { codex0160Protocol } from "./fixtures/codex-0160-protocol.ts";

async function hiredFixture(options: Parameters<typeof codex0160Protocol>[1] = {}, fleetProjection = false) {
  const directory = await mkdtemp(join(tmpdir(), "codex-hire-protocol-"));
  const native = await codex0160Protocol(directory, options);
  const pane = {
    pane_id: fleetProjection ? "pc/w1:p1" : "w1:p1",
    terminal_id: fleetProjection ? "pc/term_protocol" : "term_protocol",
    name: "protocol-ab12",
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
  let nextWake: { entered: () => void; release: Promise<void> } | undefined;
  const watchPath = join(directory, "watches.json");
  const storeOptions = {
    seatAdapters: [adapter],
    remoteSeatAdapters: () => [adapter],
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
      startAgent: async ({ args, name }) => {
        pane.name = name;
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
  } satisfies NonNullable<ConstructorParameters<typeof HerdrWatchStore>[1]>;
  const store = new HerdrWatchStore(watchPath, storeOptions);
  const wake: Parameters<HerdrWatchStore["start"]>[0] = async (conversationId, text, _discord, guard) => {
    if (nextWake) {
      const held = nextWake;
      nextWake = undefined;
      held.entered();
      await held.release;
    }
    await guard?.();
    wakes.push({ conversationId, text });
  };
  store.start(wake);
  const census = () =>
    readFleet({
      summaries: {},
      ...(fleetProjection
        ? {
            localAvailable: false,
            fleets: [
              {
                id: "pc",
                session: "default",
                host: "protocol-host",
                run: async (args: readonly string[]) => {
                  const agents = [
                    {
                      ...structuredClone(pane),
                      pane_id: pane.pane_id.slice(3),
                      terminal_id: pane.terminal_id.slice(3),
                    },
                  ];
                  if (args.join(" ") === "agent list") return JSON.stringify({ result: { agents } });
                  if (args.join(" ") === "api snapshot")
                    return JSON.stringify({ result: { snapshot: { agents } } });
                  throw new Error(`Unexpected remote census command: ${args.join(" ")}`);
                },
              },
            ],
          }
        : {}),
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
    const hire = await store.spawnSeat(
      { schemaVersion: 1, harness: "codex", title: "Protocol hire", workingDirectory: directory },
      undefined,
      "Initial brief",
      undefined,
      owner,
    );
    expect(hire).toMatchObject({ outcome: "spawned", control: { mode: "adapter" } });
    if (hire.outcome !== "spawned") throw new Error("Native protocol hire did not start");
    const control = await adapter.attach({
      harness: "codex",
      paneId: pane.pane_id,
      sessionId: native.threadId,
    });
    expect(control).toBeDefined();
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(reports.some((args) => args.includes(native.threadId))).toBe(true);
    const holdNextWake = () => {
      let entered!: () => void;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      nextWake = {
        entered,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return { pending, release };
    };
    return {
      native,
      pane,
      adapter,
      control: control!,
      store,
      owner,
      wakes,
      fallback,
      census,
      close,
      directory,
      hire,
      watchPath,
      storeOptions,
      wake,
      holdNextWake,
    };
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

it("reports a concurrent owner answer at native dispatch even when the lead's reply also persists", async () => {
  const { native, pane, store, owner, wakes, fallback, close } = await hiredFixture();
  try {
    await native.ask("call-racing-owner");
    await vi.waitFor(() =>
      expect(wakes.filter(({ text }) => text.includes("call-racing-owner"))).toHaveLength(1),
    );
    const questionId = JSON.stringify(["request_user_input_async", "call-racing-owner", 0]);
    const ownerClientId = native.ownerAnswerOnNextDispatch({
      questionItemId: questionId,
      question: "Which worktree should I use?",
      answer: "Owner-selected worktree",
    });
    const answer = {
      requestId: "call-racing-owner",
      answers: { [questionId]: { answers: ["Lead-selected worktree"] } },
    };
    expect(await store.answerSeatQuestion(pane.terminal_id, answer, owner)).toMatchObject({
      outcome: "unconfirmed",
      detail: "answered_concurrently_by_owner",
    });
    const answerRpc = native.requests.filter(({ method }) => method === "turn/steer").at(-1)!;
    expect(answerRpc.params).toMatchObject({
      expectedTurnId: "turn-1",
      clientUserMessageId: expect.any(String),
    });
    expect(answerRpc.params.clientUserMessageId).not.toBe(ownerClientId);
    const replies = native.turns.at(-1)!.items.filter((item) => item.type === "userMessage");
    expect(replies).toHaveLength(2);
    expect(replies.map((item) => item.clientId)).toEqual([
      ownerClientId,
      answerRpc.params.clientUserMessageId,
    ]);
    expect(JSON.stringify(replies)).toContain("Owner-selected worktree");
    expect(JSON.stringify(replies)).toContain("Lead-selected worktree");
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

it("cold native hydration skips an older completed question while keeping the latest completed question answerable", async () => {
  const { native, pane, control, store, owner, wakes, fallback, close } = await hiredFixture({
    historicalQuestion: { callId: "call-old-completed", title: "Old question is historical context" },
    initialQuestion: { callId: "call-latest-completed", title: "Latest question needs an answer" },
  });
  try {
    await vi.waitFor(() =>
      expect(wakes.filter(({ text }) => text.includes("call-latest-completed"))).toHaveLength(1),
    );
    expect(wakes.some(({ text }) => text.includes("call-old-completed"))).toBe(false);
    expect(native.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
    expect(await control.statusReason?.()).toBe("Waiting on a question (call-latest-completed)");
    const oldId = JSON.stringify(["request_user_input_async", "call-old-completed", 0]);
    expect(
      await store.answerSeatQuestion(
        pane.terminal_id,
        {
          requestId: "call-old-completed",
          answers: { [oldId]: { answers: ["Stale answer must not dispatch"] } },
        },
        owner,
      ),
    ).toMatchObject({ outcome: "undelivered" });
    expect(
      native.requests.filter(({ method }) => method === "turn/start" || method === "turn/steer"),
    ).toHaveLength(1);
    const latestId = JSON.stringify(["request_user_input_async", "call-latest-completed", 0]);
    expect(
      await store.answerSeatQuestion(
        pane.terminal_id,
        {
          requestId: "call-latest-completed",
          answers: { [latestId]: { answers: ["Task worktree"] } },
        },
        owner,
      ),
    ).toMatchObject({ outcome: "delivered", deliveryStage: "responded" });
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(2);
    expect(native.requests.some(({ method }) => method === "turn/steer" || method === "turn/interrupt")).toBe(
      false,
    );
    expect(wakes.some(({ text }) => text.includes("call-old-completed"))).toBe(false);
    expect(fallback).not.toHaveBeenCalled();
    expect(native.errors).toEqual([]);
  } finally {
    await close();
  }
});

it("automatically harvests the accepted follow-up turn once, retaining its claim across receipt reconciliation and restart", async () => {
  const fixture = await hiredFixture();
  const { native, pane, control, store, wakes, watchPath, storeOptions, wake, close } = fixture;
  let restarted: HerdrWatchStore | undefined;
  try {
    native.finish("completed", "Initial brief complete");
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    const options = { stableReceiptKey: "host-original-follow-up", delivery: "steer" as const };
    expect(await store.deliverToSeat(pane.terminal_id, "Native follow-up", undefined, options)).toMatchObject(
      {
        outcome: "delivered",
        state: "started",
        messageId: "turn-2",
      },
    );
    // A completion from turn-1 cannot stand in for the newly accepted turn.
    expect(await control.status()).toBe("working");
    expect(wakes).toHaveLength(1);
    native.finish("completed", "Native follow-up complete");
    await vi.waitFor(() => expect(wakes).toHaveLength(2));
    expect(wakes[1]?.text).toContain("Native follow-up complete");
    expect(wakes.every(({ conversationId }) => conversationId === fixture.owner.owner.conversationId)).toBe(
      true,
    );
    await vi.waitFor(async () => expect(JSON.parse(await readFile(watchPath, "utf8")).watches).toEqual([]));
    store.close();
    restarted = new HerdrWatchStore(watchPath, storeOptions);
    restarted.start(wake);
    expect(
      await restarted.deliverToSeat(pane.terminal_id, "Native follow-up", undefined, options),
    ).toMatchObject({
      outcome: "delivered",
      messageId: "turn-2",
    });
    expect(JSON.parse(await readFile(watchPath, "utf8")).watches).toEqual([]);
    expect(wakes).toHaveLength(2);
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(2);
    expect(native.requests.filter(({ method }) => method === "turn/steer")).toHaveLength(0);
    expect(fixture.fallback).not.toHaveBeenCalled();
    expect(native.errors).toEqual([]);
  } finally {
    restarted?.close();
    await close();
  }
});

it("fences a generic hire wake that began before the same-turn steer acknowledgment and exact harvest", async () => {
  const { native, pane, store, wakes, watchPath, holdNextWake, close } = await hiredFixture();
  try {
    const heldWake = holdNextWake();
    const ack = native.holdNextMutationReply();
    const send = store.deliverToSeat(pane.terminal_id, "Steer original turn");
    await ack.pending;
    native.finish("completed", "Original turn including steer complete");
    await heldWake.pending;
    ack.release();
    expect(await send).toMatchObject({ outcome: "delivered", state: "steered", messageId: "turn-1" });
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    heldWake.release();
    await vi.waitFor(async () => expect(JSON.parse(await readFile(watchPath, "utf8")).watches).toEqual([]));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.text).toContain("Original turn including steer complete");
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(native.requests.filter(({ method }) => method === "turn/steer")).toHaveLength(1);
    expect(native.errors).toEqual([]);
  } finally {
    await close();
  }
});

it("restores an exact follow-up watch without claiming completion from an unavailable controller or old reply", async () => {
  const { native, pane, store, wakes, watchPath, storeOptions, wake, fallback, close } = await hiredFixture();
  let restored: HerdrWatchStore | undefined;
  const lastReply = vi.fn(async () => "Earlier completed answer");
  try {
    native.finish("completed", "Initial brief complete");
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    expect(await store.deliverToSeat(pane.terminal_id, "Still-running follow-up")).toMatchObject({
      outcome: "delivered",
      messageId: "turn-2",
    });
    store.close();
    restored = new HerdrWatchStore(watchPath, {
      ...storeOptions,
      seatAdapters: [],
      remoteSeatAdapters: () => [],
      lastReply,
    });
    restored.start(wake);
    await vi.waitFor(() => expect(wakes).toHaveLength(2));
    expect(wakes[1]?.text).toContain("completion of this message is unverified");
    expect(wakes[1]?.text).not.toContain("Earlier completed answer");
    expect(lastReply).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(native.requests.filter(({ method }) => method === "turn/start")).toHaveLength(2);
  } finally {
    restored?.close();
    await close();
  }
});

it("creates no owner completion wake for peer output and refuses a changed occupant at final wake acceptance", async () => {
  const { native, pane, control, store, wakes, watchPath, holdNextWake, close } = await hiredFixture();
  try {
    native.finish("completed", "Initial brief complete");
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    expect(
      await store.deliverToSeat(pane.terminal_id, "Untrusted peer context", undefined, {
        fence: async () => true,
      }),
    ).toMatchObject({ outcome: "delivered", state: "started" });
    native.finish("completed", "Peer context complete");
    await vi.waitFor(async () => expect(await control.status()).toBe("idle"));
    expect(JSON.parse(await readFile(watchPath, "utf8")).watches).toEqual([]);
    expect(wakes).toHaveLength(1);
    const held = holdNextWake();
    expect(await store.deliverToSeat(pane.terminal_id, "Original-occupant follow-up")).toMatchObject({
      outcome: "delivered",
      state: "started",
    });
    native.finish("completed", "Original occupant answer");
    await held.pending;
    pane.agent_session = { ...pane.agent_session, value: "replacement-native-session" };
    held.release();
    await vi.waitFor(async () => {
      expect(wakes).toHaveLength(1);
      expect(JSON.parse(await readFile(watchPath, "utf8")).harvestedTurns).toHaveLength(1);
      expect(JSON.parse(await readFile(watchPath, "utf8")).watches).toEqual([]);
    });
  } finally {
    await close();
  }
});

it("keeps a fleet-qualified hire's persona through raw fleet census and child-conversation delivery over native RPC", async () => {
  // The host allocation is preallocated by the protocol fixture. This tests
  // hire/census/persona/conversation boundaries, not SSH or live PC admission.
  const { native, pane, store, directory, hire, census, wakes, close } = await hiredFixture({}, true);
  const personas = new PersonaStore(join(directory, "personas"));
  let roster = personas.reconcile([]);
  const conversations = new ConversationStore(
    join(directory, "conversations"),
    async () => {},
    undefined,
    (seatId, text) => store.deliverToSeat(seatId, text),
    undefined,
    undefined,
    undefined,
    (personaId) => roster.find((seat) => seat.personaId === personaId)?.seatId,
  );
  try {
    const adopted = personas.adoptSpawn(hire.seat, "Protocol worker");
    expect(hire.seat.subject).toBe(`pc-${pane.name}`);
    const created = await conversations.serve({
      schemaVersion: 1,
      op: "create",
      scope: { kind: "persona", personaId: adopted.personaId },
      title: "Protocol worker",
    });
    if (created.op !== "create") throw new Error("Expected child conversation");
    roster = personas.reconcile((await census()).seats);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ personaId: adopted.personaId, seatId: pane.terminal_id });
    const sent = await conversations.serve({
      schemaVersion: 1,
      op: "send",
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: created.conversation.conversationId,
        surfaceClientId: "protocol-owner",
        expectedRevision: 0,
        message: "Child conversation follow-up",
      },
    });
    expect(sent.op === "send" ? sent.result : undefined).toMatchObject({ status: "accepted", revision: 1 });
    expect(native.requests.filter(({ method }) => method === "turn/steer")).toHaveLength(1);
    native.finish("completed", "Child follow-up complete");
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    expect(wakes[0]?.text).toContain("Child follow-up complete");
    expect(native.errors).toEqual([]);
  } finally {
    await conversations.close();
    await close();
  }
});
