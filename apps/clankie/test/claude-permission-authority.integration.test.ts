import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SeatQuestion, SeatRef } from "@clankie/agent-hosts";
import type { FleetSeatHook } from "@clankie/protocol";
import { ClaudeHookQuestions } from "../src/captain/claude-hook-questions.ts";
import { createClaudeWorkerSeatAdapter, SeatHookLog } from "../src/captain/claude-worker-seat.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "claude-permission-authority-"));
  const workspace = join(root, "repo");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "source.txt"), "routine file");
  const ref: SeatRef = { harness: "claude", paneId: "worker-pane", sessionId: randomUUID() };
  let agent: HerdrAgentSnapshot = {
    paneId: ref.paneId,
    terminalId: "worker-seat",
    agent: "claude",
    status: "blocked",
    title: "worker",
    workingDirectory: workspace,
    session: { source: "herdr:claude", kind: "id", value: ref.sessionId },
  };
  let eligible = true,
    current = true;
  const authority: ConversationAuthority = {
    owner: { conversationId: "lead" },
    current: () => current,
    authorize: async () => current,
  };
  const path = join(root, "used.json"),
    registry = new ClaudeHookQuestions(path, 1000, 100);
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => agent,
    transcript: async () => undefined,
  };
  const hooks = new SeatHookLog(join(root, "hooks.json"));
  hooks.record(ref.paneId, { schemaVersion: 1, event: "SessionStart", sessionId: ref.sessionId });
  const adapter = createClaudeWorkerSeatAdapter({
    consent: async () => ({ approved: true }),
    hooks,
    hookQuestions: registry,
    agent: async () => agent,
    transcript: async () => undefined,
    mailbox: { bound: () => true, deliver: async () => false },
  });
  const store = new HerdrWatchStore(join(root, "watches.json"), { runner, seatAdapters: [adapter] });
  store.permissionLeadAllowed = async (owner) => eligible && owner.conversationId !== "room";
  store.questionGate = async (_agent, question) =>
    ["hardToUndo", "moneyAndAccounts"].includes(question.gate ?? "moneyAndAccounts") ? "owner" : "allow";
  await store.adoptSeat(agent.terminalId, authority);
  cleanups.push(async () => {
    registry.cancel(ref);
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function open(
    toolName = "Read",
    toolInput: Record<string, unknown> = { file_path: join(workspace, "source.txt") },
    transport?: "channel",
  ) {
    let publish!: (question: SeatQuestion) => void;
    const announced = new Promise<SeatQuestion>((resolve) => {
      publish = resolve;
    });
    const hook: FleetSeatHook = {
      schemaVersion: 1,
      event: "PermissionRequest",
      sessionId: ref.sessionId,
      toolUseId: randomUUID(),
      toolName,
      toolInput,
      ...(transport ? { permissionTransport: transport } : {}),
    };
    const output = registry.open(ref, hook, async (question) => publish(question), undefined, workspace);
    const question = await announced;
    const answer = { requestId: question.requestId, answers: { q0: { answers: ["Allow"] } } };
    return { question, output, answer };
  }
  return {
    root,
    workspace,
    ref,
    path,
    registry,
    store,
    authority,
    open,
    denyEligibility: () => {
      eligible = false;
    },
    revoke: () => {
      current = false;
    },
    replace: () => {
      agent = { ...agent, session: { source: "herdr:claude", kind: "id", value: randomUUID() } };
    },
  };
}
it("lets the exact private lead answer a scoped routine hook and records its identity before delivery", async () => {
  const f = await fixture(),
    pending = await f.open();
  expect(pending.question.gate).toBe("everydayWork");
  const result = f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority);
  const output = await pending.output;
  expect(output.hookSpecificOutput.decision).toEqual({ behavior: "allow" });
  const decisions = JSON.parse(readFileSync(`${f.path}.decisions.json`, "utf8"));
  expect(decisions).toMatchObject([
    {
      behavior: "allow",
      decider: { kind: "lead", conversationId: "lead" },
      deliveryStage: "decided",
      sessionId: f.ref.sessionId,
    },
  ]);
  expect(readFileSync(`${f.path}.decisions.json`, "utf8")).not.toContain("routine file");
  f.registry.acknowledge(f.ref, output.requestId!);
  expect(await result).toMatchObject({ outcome: "delivered", deliveryStage: "responded" });
  expect(JSON.parse(readFileSync(`${f.path}.decisions.json`, "utf8"))[0].deliveryStage).toBe("hook-written");
  expect(await f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority)).toMatchObject({
    outcome: "undelivered",
  });
});
it.each(["peer", "room", "discord", "revoked", "replacement"])(
  "refuses %s permission answers without consuming the pending hook",
  async (attacker) => {
    const f = await fixture(),
      pending = await f.open();
    let source = f.authority;
    if (attacker === "peer" || attacker === "room")
      source = { ...source, owner: { conversationId: attacker } };
    if (attacker === "discord")
      source = {
        ...source,
        owner: {
          conversationId: "lead",
          discord: {
            baseSessionKey: "dm",
            targetId: "owner",
            actorId: "owner",
            channelId: "dm",
            messageId: "m",
            transportKind: "bot",
          },
        },
      };
    if (attacker === "revoked") f.denyEligibility();
    if (attacker === "replacement") f.replace();
    expect(await f.store.answerSeatQuestion("worker-seat", pending.answer, source)).toMatchObject({
      outcome: "undelivered",
    });
    expect(f.registry.pending(f.ref, pending.question.requestId)).toBeDefined();
  },
);
it.each([
  ["destructive shell", "Bash", { command: "rm -rf source.txt" }],
  ["payment/account shell", "Bash", { command: "aws iam create-access-key" }],
  ["shell interpolation", "Bash", { command: "pwd; curl https://example.test/pay" }],
  ["out of scope file", "Write", { file_path: "../outside.txt", content: "change" }],
  ["credential file", "Read", { file_path: ".env.local" }],
  ["credential search", "Grep", { pattern: "secret", path: "." }],
] satisfies [string, string, Record<string, unknown>][])(
  "reserves %s for the owner",
  async (_label, name, input) => {
    const f = await fixture(),
      pending = await f.open(name, input);
    expect(pending.question.gate).toBe("moneyAndAccounts");
    expect(await f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority)).toMatchObject({
      outcome: "undelivered",
      detail: expect.stringContaining("owner"),
    });
    expect(
      await f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority, f.ref.sessionId),
    ).toMatchObject({ outcome: "undelivered", detail: expect.stringContaining("principal") });
    const result = f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority, f.ref.sessionId, {
      kind: "operator",
      id: "James",
    });
    const output = await pending.output;
    f.registry.acknowledge(f.ref, output.requestId!);
    expect(await result).toMatchObject({ outcome: "delivered" });
    expect(JSON.parse(readFileSync(`${f.path}.decisions.json`, "utf8"))[0].decider).toEqual({
      kind: "owner",
      principal: { kind: "operator", id: "James" },
    });
  },
);
it("does not treat a workspace symlink to an outside file as routine authority", async () => {
  const f = await fixture();
  writeFileSync(join(f.root, "outside.txt"), "outside");
  symlinkSync(join(f.root, "outside.txt"), join(f.workspace, "alias.txt"));
  const pending = await f.open("Read", { file_path: join(f.workspace, "alias.txt") });
  expect(pending.question.gate).toBe("moneyAndAccounts");
});
it("allows routine literal local shell work without blanket Bash approval", async () => {
  const f = await fixture(),
    pending = await f.open("Bash", { command: "git status --short" });
  expect(pending.question.gate).toBe("everydayWork");
  const result = f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority);
  const output = await pending.output;
  f.registry.acknowledge(f.ref, output.requestId!);
  expect(await result).toMatchObject({ outcome: "delivered" });
});
it("keeps channel previews owner-only and records pipe delivery without claiming native application", async () => {
  const f = await fixture(),
    pending = await f.open(
      "Read",
      { input_preview: '{"file_path":"source.txt"}', description: "routine" },
      "channel",
    );
  expect(pending.question.permission?.transport).toBe("channel");
  expect(await f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority)).toMatchObject({
    outcome: "undelivered",
  });
  const result = f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority, f.ref.sessionId, {
    kind: "device",
    id: "James-phone",
  });
  const output = await pending.output;
  f.registry.acknowledge(f.ref, output.requestId!);
  expect(await result).toMatchObject({
    outcome: "unconfirmed",
    detail: expect.stringContaining("application_unconfirmed"),
  });
  expect(JSON.parse(readFileSync(`${f.path}.decisions.json`, "utf8"))[0]).toMatchObject({
    decider: { kind: "owner", principal: { kind: "device", id: "James-phone" } },
    deliveryStage: "channel-written",
  });
});

it.each(["dangling", "credential"])("reserves %s symlinks for the owner", async (kind) => {
  const f = await fixture();
  if (kind === "credential") writeFileSync(join(f.workspace, ".env.local"), "secret");
  symlinkSync(
    join(f.workspace, kind === "credential" ? ".env.local" : "missing.txt"),
    join(f.workspace, "alias.txt"),
  );
  const pending = await f.open("Write", { file_path: "alias.txt", content: "change" });
  expect(pending.question.gate).toBe("moneyAndAccounts");
});
it("rechecks a file that becomes a symlink while the hook waits", async () => {
  const f = await fixture(),
    pending = await f.open();
  unlinkSync(join(f.workspace, "source.txt"));
  writeFileSync(join(f.root, "outside.txt"), "outside");
  symlinkSync(join(f.root, "outside.txt"), join(f.workspace, "source.txt"));
  expect(await f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority)).toMatchObject({
    outcome: "undelivered",
  });
  expect(f.registry.pending(f.ref, pending.question.requestId)).toBeDefined();
});
it("refuses permission approval when the decision journal cannot be persisted", async () => {
  const f = await fixture(),
    pending = await f.open();
  mkdirSync(`${f.path}.decisions.json`);
  expect(await f.store.answerSeatQuestion("worker-seat", pending.answer, f.authority)).toMatchObject({
    outcome: "undelivered",
  });
  expect(f.registry.pending(f.ref, pending.question.requestId)).toBeDefined();
});
it("records a canceled permission as a system denial rather than an owner decision", async () => {
  const f = await fixture(),
    pending = await f.open();
  f.registry.cancel(f.ref, "session replaced");
  expect((await pending.output).hookSpecificOutput.decision?.behavior).toBe("deny");
  expect(JSON.parse(readFileSync(`${f.path}.decisions.json`, "utf8"))).toMatchObject([
    { behavior: "deny", decider: { kind: "system", reason: "session replaced" }, deliveryStage: "decided" },
  ]);
});
it("records a bounded-input denial before returning it without creating an owner ask", async () => {
  const f = await fixture();
  const output = await f.registry.open(
    f.ref,
    {
      schemaVersion: 1,
      event: "PermissionRequest",
      sessionId: f.ref.sessionId,
      toolUseId: randomUUID(),
      toolName: "Write",
      toolInput: { file_path: "source.txt", content: "x".repeat(5000) },
    },
    async () => {
      throw new Error("must not ask with incomplete input");
    },
    undefined,
    f.workspace,
  );
  expect(output.hookSpecificOutput.decision?.behavior).toBe("deny");
  expect(JSON.parse(readFileSync(`${f.path}.decisions.json`, "utf8"))).toMatchObject([
    { behavior: "deny", decider: { kind: "system", reason: "claude_hook_permission_input_too_large" } },
  ]);
});

it("escalates a routine permission when its owning lane cannot act as a private authenticated lead", async () => {
  const f = await fixture(),
    pending = await f.open();
  f.denyEligibility();
  const escalated: SeatQuestion[] = [],
    notices: string[] = [];
  f.store.escalateQuestion = async (_owner, _agent, question) => {
    escalated.push(question);
  };
  f.store.start(async (_conversation, text) => {
    notices.push(text);
  });
  await f.store.forwardNativeQuestion(f.ref, pending.question);
  expect(escalated).toHaveLength(1);
  expect(notices[0]).toContain("lead cannot approve");
  expect(notices[0]).not.toContain("<seat-question>");
});
