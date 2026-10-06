import { execFileSync } from "node:child_process";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { addProjectWorktreeRoot, projectsRevision, observeLocalProjectWorktreeRoot } from "@clankie/settings";
import { z } from "zod";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  ConversationStore,
  type ConversationRunner,
  type ConversationTurnContext,
} from "../src/captain/conversations.ts";
import {
  QuestionDraftSchema,
  questionWorkspaceContext,
  type QuestionAuthority,
} from "../src/captain/conversation-questions.ts";
import type { ConversationQuestionResult, ConversationQuestionTarget } from "@clankie/protocol";
import { questionTools } from "../src/captain/question-tools.ts";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const owner: QuestionAuthority = {
  principal: { kind: "operator", id: "owner" },
  authorize: async () => true,
  current: () => true,
};
const draft = QuestionDraftSchema.parse({
  kind: "choice",
  prompt: "Which style?",
  options: [{ label: "Small" }, { label: "Large" }],
  allowFreeform: true,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(hold = false) {
  const root = fs.mkdtempSync(join(tmpdir(), "clankie-questions-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  fs.mkdirSync(workspace);
  const calls: Array<{ message: string; context: ConversationTurnContext }> = [];
  let question!: ConversationQuestionResult;
  const asked = deferred(),
    finish = deferred();
  const store = new ConversationStore(join(root, "conversations"), async (id, message, publish, context) => {
    calls.push({ message, context });
    if (context.inputAnswer) return;
    if (message === "ask") {
      // Actual registered tool -> host callback -> store, no provider or model.
      const tool = questionTools({ requestQuestion: (d) => store.requestQuestion(id, d, context) }).find(
        (t) => t.name === "request_user_input",
      )!;
      await tool.execute("tool-call", draft, undefined, undefined, {} as never);
      const result = await store.serve({ op: "input_get", schemaVersion: 1, conversationId: id }, owner);
      if (result.op !== "input_get") throw new Error("wrong result");
      question = result.result;
      publish({ type: "activity", phase: "thinking" });
      asked.resolve();
      if (hold) await finish.promise;
    }
  });
  const made = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: workspace },
    title: "Questions",
  });
  if (made.op !== "create") throw new Error("wrong result");
  const id = made.conversation.conversationId;
  const sent = await store.serve(
    {
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: id,
        surfaceClientId: "fixture",
        expectedRevision: 0,
        message: "ask",
      },
    },
    owner,
  );
  if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("send failed");
  await asked.promise;
  if (!hold) await store.awaitRun(sent.result.runId);
  const q = question.question!;
  const target: ConversationQuestionTarget = {
    conversationId: id,
    requestId: q.requestId,
    incarnationId: q.incarnationId,
    expectedRevision: question.revision!,
  };
  const answer = { kind: "choice" as const, optionId: q.options[0]!.optionId };
  const respond = (patch = {}, authority = owner) =>
    store.serve({ op: "input_answer", schemaVersion: 1, ...target, answer, ...patch }, authority);
  const read = async (requestId = target.requestId) => {
    const r = await store.serve({ op: "input_get", schemaVersion: 1, conversationId: id, requestId }, owner);
    if (r.op !== "input_get") throw new Error("wrong result");
    return r.result;
  };
  return {
    root,
    workspace,
    store,
    id,
    target,
    answer,
    respond,
    read,
    calls,
    finish,
    originRunId: sent.result.runId,
  };
}
it("returns pending immediately, survives activity, and commits one attributed queued continuation across duplicate answers", async () => {
  const f = await fixture(true);
  expect((await f.read()).question?.status).toBe("pending");
  const responder: QuestionAuthority = { ...owner, principal: { kind: "device", id: "other-owner-device" } };
  const first = await f.respond({}, responder);
  if (first.op !== "input_answer") throw new Error("wrong result");
  expect(first.result.question?.status).toBe("submitted");
  const runId = first.result.question!.continuation!.runId;
  const duplicate = await f.respond({}, responder);
  expect(duplicate).toEqual(first); // old revision reconciles original acceptance
  expect(f.calls).toHaveLength(1);
  f.finish.resolve();
  await f.store.awaitRun(runId);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]!.context.inputAnswer).toEqual({ requestId: f.target.requestId, answer: f.answer });
  expect(f.calls[1]!.context.ownerAuthority?.principal).toEqual(responder.principal);
  expect(f.calls[1]!.message).toContain("not approval");
  expect((await f.read()).question?.continuation?.state).toBe("completed");
  const events = fs.readFileSync(join(f.root, "conversations", f.id, "events.jsonl"), "utf8");
  expect(events.match(/"type":"input_resolved"/g)).toHaveLength(1);
  await f.store.close();
});
it.each(["option", "incarnation", "revision", "request", "conversation", "conflicting"])(
  "fails closed for %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "conflicting") await f.respond();
    const patch =
      kind === "option"
        ? { answer: { kind: "choice", optionId: randomUUID() } }
        : kind === "incarnation"
          ? { incarnationId: randomUUID() }
          : kind === "revision"
            ? { expectedRevision: 99 }
            : kind === "request"
              ? { requestId: randomUUID() }
              : kind === "conversation"
                ? { conversationId: "wrong" }
                : { answer: { kind: "text", text: "different" } };
    const result = await f.respond(patch);
    if (result.op !== "input_answer") throw new Error("wrong result");
    expect(["refused", "revision_conflict"]).toContain(result.result.status);
    await f.store.close();
    expect(f.calls).toHaveLength(kind === "conflicting" ? 2 : 1);
  },
);
it("serializes racing answer/cancel and never resumes cancelled IDs", async () => {
  const f = await fixture();
  const cancel = { op: "input_cancel", schemaVersion: 1, ...f.target } as const;
  const results = await Promise.all([f.store.serve(cancel, owner), f.respond()]);
  expect(results[0]).toMatchObject({ result: { question: { status: "cancelled" } } });
  expect(results[1]).toMatchObject({ result: { question: { status: "cancelled" } } });
  expect(await f.respond()).toMatchObject({ result: { question: { status: "cancelled" } } });
  await f.store.close();
  expect(f.calls).toHaveLength(1);
});
it("rechecks the answering exact principal when queued work enters the runner", async () => {
  const f = await fixture(true);
  let allowed = true;
  const device: QuestionAuthority = {
    principal: { kind: "device", id: "phone" },
    authorize: async () => allowed,
    current: () => allowed,
  };
  const answer = await f.respond({}, device);
  if (answer.op !== "input_answer") throw new Error("wrong result");
  allowed = false;
  f.finish.resolve();
  await f.store.awaitRun(answer.result.question!.continuation!.runId);
  expect((await f.read()).question?.continuation?.state).toBe("failed");
  expect(f.calls).toHaveLength(1);
  await f.store.close();
});
it.each(["workspace", "native", "run_cancel", "issuer_revoked"])(
  "cancels pending on %s context loss",
  async (kind) => {
    const f = await fixture(true);
    if (kind === "workspace") {
      fs.renameSync(f.workspace, f.workspace + "-old");
      fs.mkdirSync(f.workspace);
    }
    if (kind === "native") f.store.questionEligible = () => false;
    if (kind === "run_cancel") f.store.cancel(f.id, f.originRunId);
    if (kind === "issuer_revoked") f.store.cancelPendingQuestion(f.id, "owner_context_lost");
    expect(await f.respond()).toMatchObject({ result: { question: { status: "cancelled" } } });
    f.finish.resolve();
    await f.store.close();
    expect(f.calls).toHaveLength(1);
  },
);
it("rotates reset incarnation and never revives archived request IDs", async () => {
  const f = await fixture();
  await f.store.serve({
    op: "reset",
    schemaVersion: 1,
    conversationId: f.id,
    expectedRevision: f.target.expectedRevision,
  });
  expect(await f.respond()).toMatchObject({ result: { status: "refused", reason: "stale_request" } });
  await f.store.close();
});
it("restart cancels pending without replay and retains terminal receipts even with an empty journal", async () => {
  const f = await fixture();
  await f.store.close();
  const runner = vi.fn(async () => {});
  let restarted = new ConversationStore(join(f.root, "conversations"), runner);
  const get = {
    op: "input_get",
    schemaVersion: 1,
    conversationId: f.id,
    requestId: f.target.requestId,
  } as const;
  expect(await restarted.serve(get, owner)).toMatchObject({
    result: { question: { status: "cancelled", reason: "service_restarted" } },
  });
  await restarted.close();
  // Simulate a committed submitted receipt whose accepted projection never reached the journal.
  const path = join(f.root, "conversations", f.id, "meta.json"),
    meta = JSON.parse(fs.readFileSync(path, "utf8"));
  const record = meta.questions.records[0];
  record.question.status = "submitted";
  record.question.answer = f.answer;
  record.question.continuation = { runId: "run-crash", state: "accepted" };
  record.responder = owner.principal;
  record.message = "retained preference";
  meta.sessionState = "active";
  fs.writeFileSync(path, JSON.stringify(meta));
  fs.writeFileSync(join(f.root, "conversations", f.id, "events.jsonl"), "");
  restarted = new ConversationStore(join(f.root, "conversations"), runner);
  expect(await restarted.serve(get, owner)).toMatchObject({
    result: {
      question: {
        status: "submitted",
        continuation: { runId: "run-crash", state: "failed", reasonCode: "service_restarted" },
      },
    },
  });
  const before = fs.readFileSync(join(f.root, "conversations", f.id, "events.jsonl"), "utf8");
  await restarted.serve(get, owner);
  await restarted.serve(get, owner);
  expect(fs.readFileSync(join(f.root, "conversations", f.id, "events.jsonl"), "utf8")).toBe(before);
  expect(runner).not.toHaveBeenCalled();
  await restarted.close();
});
it("rolls back pre-rename acceptance and reconciles post-rename append failure without another run", async () => {
  const f = await fixture();
  const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
    throw new Error("disk failure");
  });
  await expect(f.respond()).rejects.toThrow();
  rename.mockRestore();
  expect(await f.read()).toMatchObject({
    revision: f.target.expectedRevision,
    question: { status: "pending" },
  });
  const append = vi.spyOn(fs, "appendFileSync").mockImplementationOnce(() => {
    throw new Error("journal failure");
  });
  const accepted = await f.respond();
  append.mockRestore();
  expect(accepted).toMatchObject({
    result: {
      question: {
        status: "submitted",
        continuation: { state: "failed", reasonCode: "acceptance_interrupted" },
      },
    },
  });
  expect(await f.respond()).toMatchObject({
    result: { question: { status: "submitted", continuation: { state: "failed" } } },
  });
  expect(f.calls).toHaveLength(1);
  await f.store.close();
});
it("corrupt actionable state never becomes an empty registry that can accept again", async () => {
  const f = await fixture();
  await f.store.close();
  const path = join(f.root, "conversations", f.id, "meta.json"),
    meta = JSON.parse(fs.readFileSync(path, "utf8"));
  meta.questions.records[0].question.incarnationId = "corrupt";
  fs.writeFileSync(path, JSON.stringify(meta));
  const restarted = new ConversationStore(join(f.root, "conversations"), async () => {
    throw new Error("must not run");
  });
  await expect(
    restarted.serve({ op: "input_get", schemaVersion: 1, conversationId: f.id }, owner),
  ).rejects.toThrow("question_state_unavailable");
  await restarted.close();
});
it("refuses unbound tool and approval-kind input", async () => {
  const tool = questionTools({}).find((t) => t.name === "request_user_input")!;
  await expect(tool.execute("id", draft, undefined, undefined, {} as never)).rejects.toThrow(
    "current owner workspace",
  );
  expect(QuestionDraftSchema.safeParse({ ...draft, kind: "approval" }).success).toBe(false);
});

it("new events pass the frozen d499 strict legacy parser; snapshot recovers IDs and terminal state after trimming", async () => {
  const f = await fixture();
  const answered = await f.respond();
  if (answered.op !== "input_answer") throw new Error("wrong result");
  await f.store.awaitRun(answered.result.question!.continuation!.runId);
  const path = join(f.root, "conversations", f.id, "events.jsonl");
  const events = fs
    .readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const inputs = events.filter((e) => e.type === "input_requested" || e.type === "input_resolved");
  expect(inputs).toHaveLength(2);
  for (const event of inputs) expect(LegacyD499InputEvent.parse(event)).toEqual(event);
  expect(() => LegacyD499InputEvent.parse({ ...inputs[0], question: answered.result.question })).toThrow();
  fs.writeFileSync(path, "");
  const receipt = await f.read();
  expect(receipt.question).toMatchObject({
    requestId: f.target.requestId,
    incarnationId: f.target.incarnationId,
    status: "submitted",
    answer: f.answer,
    continuation: { state: "completed" },
  });
  expect(receipt.question!.options[0]!.optionId).toBe(f.answer.optionId);
  expect(fs.readFileSync(path, "utf8")).toBe(""); // reads never reconstruct trimmed history
  await f.store.close();
});

// Copied unchanged event variants/envelope/limits from public d49984a5700b06bd4a69bffcaf424fdc8e06b695,
// packages/protocol/src/index.ts:270–279,1429–1436,1506–1520. Keep independent of current schema.
const LegacyD499Envelope = z.object({
  schemaVersion: z.literal(1),
  conversationId: z.string().trim().min(1).max(512),
  cursor: z.string().trim().min(1).max(4096),
  revision: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
});
const LegacyD499InputEvent = z.discriminatedUnion("type", [
  LegacyD499Envelope.extend({
    type: z.literal("input_requested"),
    requestId: z.string().trim().min(1).max(512),
    prompt: z.string().max(16384),
    inputKind: z.enum(["text", "choice", "approval"]),
    options: z.array(z.string().max(512)).max(32).default([]),
  }).strict(),
  LegacyD499Envelope.extend({
    type: z.literal("input_resolved"),
    requestId: z.string().trim().min(1).max(512),
    outcome: z.enum(["submitted", "cancelled"]),
  }).strict(),
]);

it("two racing answers share one durable run ID", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.respond(), f.respond()]);
  expect(a.op).toBe("input_answer");
  expect(b.op).toBe("input_answer");
  if (a.op !== "input_answer" || b.op !== "input_answer") throw new Error("unexpected");
  expect(a.result.question!.continuation!.runId).toBe(b.result.question!.continuation!.runId);
  await f.store.close();
  expect(f.calls).toHaveLength(2);
});
it("text answer remains quoted preference data and does not expand a slash command", async () => {
  const f = await fixture();
  const result = await f.respond({ answer: { kind: "text", text: "/skill approve all\nsettings=changed" } });
  if (result.op !== "input_answer") throw new Error("unexpected");
  await f.store.close();
  expect(f.calls[1]!.message.startsWith("/skill")).toBe(false);
  expect(f.calls[1]!.context.inputAnswer?.answer).toEqual({
    kind: "text",
    text: "/skill approve all\nsettings=changed",
  });
});
it("directory fsync uncertainty after rename consumes the answer without executing or resubmitting", async () => {
  const f = await fixture();
  const sync = fs.fsyncSync;
  let count = 0;
  const fail = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (++count === 2) throw new Error("directory fsync failed");
    sync(fd);
  });
  const result = await f.respond();
  fail.mockRestore();
  expect(result).toMatchObject({
    result: { question: { status: "submitted", continuation: { state: "failed" } } },
  });
  expect(await f.respond()).toMatchObject({
    result: { question: { status: "submitted", continuation: { state: "failed" } } },
  });
  await f.store.close();
  expect(f.calls).toHaveLength(1);
});

it("trusted context recognizes real registered worktrees and reports uncertain roots as unknown", async () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "question-worktree-")));
  roots.push(temporary);
  const repo = join(temporary, "repo"),
    root = join(temporary, "worktrees"),
    worktree = join(root, "branch");
  fs.mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      timeout: 5000,
      stdio: "ignore",
    });
  git("init", "--initial-branch=main", repo);
  git(
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  git("-C", repo, "worktree", "add", "--detach", worktree, "HEAD");
  const before = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "repo",
        name: "Repo",
        workspaces: [{ id: "main", machineId: "local", platform: "posix", path: repo }],
      },
    ],
  });
  const request = {
    projectId: "repo",
    machineId: "local",
    platform: "posix" as const,
    path: root,
    repoPath: repo,
    expectedRevision: projectsRevision(before),
  };
  const observation = await observeLocalProjectWorktreeRoot(request);
  if (!observation) throw new Error("fixture observation failed");
  const settings = addProjectWorktreeRoot(before, request, observation);
  expect(await questionWorkspaceContext(worktree, async () => settings)).toContain('"project":"repo"');
  const plain = join(root, "plain");
  fs.mkdirSync(plain);
  expect(await questionWorkspaceContext(plain, async () => settings)).toContain("unknown");
  const outside = join(temporary, "outside");
  fs.mkdirSync(outside);
  expect(await questionWorkspaceContext(outside, async () => settings)).toContain('"project":"unassigned"');
  let reads = 0;
  expect(await questionWorkspaceContext(worktree, async () => (++reads === 1 ? settings : before))).toContain(
    "unknown",
  );
});

it("projects the canonical pending owner question and drops it after resolution", async () => {
  const { store, id, read, target } = await fixture();
  const question = await read();
  expect(store.pendingPresenceOwnerItem()).toEqual({
    conversationId: id,
    questionId: question.question!.requestId,
    title: question.question!.prompt,
    since: question.question!.createdAt,
  });
  await store.serve(
    {
      op: "input_cancel",
      schemaVersion: 1,
      ...target,
      expectedRevision: question.revision!,
    },
    owner,
  );
  expect(store.pendingPresenceOwnerItem()).toBeUndefined();
});

it.each(["before question", "while pending"])(
  "refuses a service question continuation when offline native ownership persists %s",
  async (when) => {
    const root = fs.mkdtempSync(join(tmpdir(), "clankie-native-question-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    fs.mkdirSync(workspace);
    const stores: ConversationStore[] = [];
    const serve = ConversationStore.prototype.serve;
    vi.spyOn(ConversationStore.prototype, "serve").mockImplementation(function (
      this: ConversationStore,
      ...args
    ) {
      stores.push(this);
      return serve.apply(this, args);
    });
    const captain = createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
    });
    const asked = deferred(),
      finish = deferred();
    let continuationStarts = 0;
    try {
      const created = await captain.serveOperatorConversation({
        op: "create",
        schemaVersion: 1,
        scope: { kind: "workspace", workspaceId: workspace },
        title: "Native question",
      });
      if (created.op !== "create") throw new Error("create failed");
      const id = created.conversation.conversationId;
      const store = stores.at(-1)!;
      // Keep the actual captain's eligibility and continuation runner. Only the
      // original question tool invocation replaces a provider turn in this fixture.
      const actualRunner = (store as unknown as { runner: ConversationRunner }).runner;
      Object.defineProperty(store, "runner", {
        value: async (...args: Parameters<ConversationRunner>) => {
          const [conversationId, message, , context] = args;
          if (message !== "ask") {
            continuationStarts++;
            return actualRunner(...args);
          }
          const tool = questionTools({
            requestQuestion: (d) => store.requestQuestion(conversationId, d, context),
          }).find((t) => t.name === "request_user_input")!;
          await tool.execute("question", draft, undefined, undefined, {} as never);
          asked.resolve();
          await finish.promise;
        },
      });
      const native = () => {
        expect(captain.syncSeatTranscript(id, { sessionId: "offline-native", entries: [] })).toBe(true);
        expect(store.hasNativeSeat(id)).toBe(true);
        expect(store.nativeSource(id)).toBeUndefined();
        expect(store.questionEligible(id)).toBe(false);
      };
      if (when === "before question") native();
      const sent = await store.serve(
        {
          op: "send",
          schemaVersion: 1,
          turn: {
            schemaVersion: 1,
            kind: "message",
            conversationId: id,
            surfaceClientId: "fixture",
            expectedRevision: store.conversation(id)!.revision,
            message: "ask",
          },
        },
        owner,
      );
      if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("send failed");
      if (when === "while pending") {
        await asked.promise;
        const read = await store.serve({ op: "input_get", schemaVersion: 1, conversationId: id }, owner);
        if (read.op !== "input_get" || !read.result.question) throw new Error("question missing");
        expect(read.result.question.status).toBe("pending");
        const q = read.result.question;
        native();
        const answer = await store.serve(
          {
            op: "input_answer",
            schemaVersion: 1,
            conversationId: id,
            requestId: q.requestId,
            incarnationId: q.incarnationId,
            expectedRevision: read.result.revision!,
            answer: { kind: "choice", optionId: q.options[0]!.optionId },
          },
          owner,
        );
        expect(answer).toMatchObject({
          result: { question: { status: "cancelled", reason: "owner_context_lost" } },
        });
        expect(answer).not.toHaveProperty("result.question.continuation");
      } else {
        expect(await store.awaitRunResult(sent.result.runId)).toBe(false);
        const read = await store.serve({ op: "input_get", schemaVersion: 1, conversationId: id }, owner);
        expect(read).not.toHaveProperty("result.question");
        expect(fs.readFileSync(join(root, "conversations", id, "events.jsonl"), "utf8")).not.toContain(
          '"type":"input_requested"',
        );
      }
      expect(store.questionEligible(id)).toBe(false);
      expect(continuationStarts).toBe(0);
    } finally {
      finish.resolve();
      await captain.close();
    }
  },
);
