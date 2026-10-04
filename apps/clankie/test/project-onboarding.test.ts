import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore, projectsRevision } from "@clankie/settings";
import {
  ProjectProposalDraftSchema,
  type ProjectProposalDraft,
  type ProjectProposalTarget,
} from "@clankie/protocol/projects";
import type { ConversationQuestionResult } from "@clankie/protocol";
import { ConversationStore, type ConversationTurnContext } from "../src/captain/conversations.ts";
import { projectOnboarding, proposalHash } from "../src/captain/project-onboarding.ts";
import { type QuestionAuthority } from "../src/captain/conversation-questions.ts";
import { questionTools } from "../src/captain/question-tools.ts";
vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of cleanup.splice(0).reverse()) await f();
});
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(patch: Partial<ProjectProposalDraft> = {}, setup?: (workspace: string) => void) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "project-onboarding-")));
  const workspace = join(root, "workspace");
  fs.mkdirSync(workspace);
  setup?.(workspace);
  const settings = new SettingsStore(join(root, "settings.json"));
  let valid = true;
  const owner: QuestionAuthority = {
    principal: { kind: "device", id: "original" },
    authorize: async () => valid,
    current: () => true,
  };
  let question!: ConversationQuestionResult, context!: ConversationTurnContext;
  const draft = ProjectProposalDraftSchema.parse({
    projectId: "new-project",
    name: "New project",
    prompt: "Review this configuration",
    ...patch,
  });
  let lastIssued: unknown;
  const turns = vi.fn();
  const store = new ConversationStore(join(root, "conversations"), async (id, message, _publish, ctx) => {
    turns(message);
    context = ctx;
    if (ctx.inputAnswer) return;
    const tool = questionTools({ proposeProjectCreate: (d) => store.proposeProjectCreate(id, d, ctx) }).find(
      (t) => t.name === "propose_project_create",
    )!;
    lastIssued = await tool.execute("proposal", draft, undefined, undefined, {} as never);
    const r = await store.serve({ op: "input_get", schemaVersion: 1, conversationId: id }, owner);
    if (r.op !== "input_get") throw Error("wrong result");
    question = r.result;
  });
  const update = vi.fn(settings.update.bind(settings));
  store.projectOnboarding = projectOnboarding({ load: () => settings.load(), update });
  const made = await store.serve({
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: workspace },
    title: "Onboarding",
  });
  if (made.op !== "create") throw Error("wrong result");
  const id = made.conversation.conversationId;
  cleanup.push(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const send = await store.serve(
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
  if (send.op !== "send" || send.result.status !== "accepted") throw Error("send failed");
  await store.awaitRun(send.result.runId);
  const q = question?.question;
  if (!q) throw Error(`No proposal: ${JSON.stringify(lastIssued)}`);
  const locator = { conversationId: id, incarnationId: q.incarnationId, requestId: q.requestId };
  const read = async (auth = owner) => {
    const r = await store.serve({ op: "project_proposal_get", schemaVersion: 1, ...locator }, auth);
    if (r.op !== "project_proposal_get") throw Error("wrong");
    return r.result;
  };
  const initial = await read();
  const target = initial.proposal!.target;
  const confirm = async (patch: Partial<ProjectProposalTarget> = {}, auth = owner) => {
    const r = await store.serve(
      { op: "project_proposal_confirm", schemaVersion: 1, ...target, ...patch },
      auth,
    );
    if (r.op !== "project_proposal_confirm") throw Error("wrong");
    return r.result;
  };
  return {
    root,
    workspace,
    settings,
    store,
    owner,
    id,
    locator,
    target,
    read,
    confirm,
    initial,
    update,
    turns,
    context: () => context,
    revoke: () => {
      valid = false;
    },
    draft,
  };
}
it("proposal tool persists one immutable artifact; explicit create preserves caps/preferences and consumed receipt survives issuer loss", async () => {
  const f = await fixture({
    workerCap: 0,
    roles: [{ role: "Builder", concurrencyCap: null, model: "gpt-6-astra", effort: "high" }],
    fleet: { size: "large", models: "efficient" },
  });
  expect(f.update).not.toHaveBeenCalled();
  expect(f.initial.status).toBe("pending");
  expect(f.initial.proposal!.project.workerCap).toBe(0);
  expect(f.initial.proposal!.project.roles[0]!.concurrencyCap).toBeUndefined();
  const result = await f.confirm();
  expect(result.status).toBe("created");
  expect(f.update).toHaveBeenCalledTimes(1);
  f.revoke();
  const fresh = { ...f.owner, authorize: async () => true };
  expect(await f.read(fresh)).toEqual(result);
  expect(await f.confirm({}, fresh)).toEqual(result);
  expect(f.update).toHaveBeenCalledTimes(1);
  expect((await f.settings.load()).projects.projects[0]!.fleet).toEqual({
    size: "large",
    models: "efficient",
  });
});
it("generic yes is context only and consumes eligibility without writing settings", async () => {
  const f = await fixture();
  const r = await f.store.serve(
    { op: "input_answer", schemaVersion: 1, ...f.target, answer: { kind: "text", text: "yes, Create" } },
    f.owner,
  );
  expect(r.op).toBe("input_answer");
  expect(f.update).not.toHaveBeenCalled();
  expect((await f.confirm()).status).toBe("refused");
});
it.each(["artifactSha256", "proposalId", "expectedRevision", "expectedProjectsRevision"] as const)(
  "refuses swapped %s",
  async (field) => {
    const f = await fixture();
    const value = field === "expectedRevision" ? 100 : field === "proposalId" ? randomUUID() : "a".repeat(64);
    expect((await f.confirm({ [field]: value })).status).toBe("refused");
    expect(f.update).not.toHaveBeenCalled();
  },
);
it("fresh same principal does not renew an expired original issuer closure; another principal cannot inspect or confirm", async () => {
  const f = await fixture();
  const other = { ...f.owner, principal: { kind: "device" as const, id: "other" } };
  await expect(f.read(other)).rejects.toThrow("question_owner_unavailable");
  await expect(f.confirm({}, other)).rejects.toThrow("question_owner_unavailable");
  f.revoke();
  expect((await f.confirm({}, { ...f.owner, authorize: async () => true })).status).toBe("refused");
  expect(f.update).not.toHaveBeenCalled();
});
it("claim fences concurrent confirms and generic answer/cancel while settings waits", async () => {
  const f = await fixture();
  const held = latch(),
    entered = latch();
  f.update.mockImplementation((mutate, guard) =>
    f.settings.update(mutate, async () => {
      entered.resolve();
      await held.promise;
      await guard?.();
    }),
  );
  const first = f.confirm();
  await entered.promise;
  try {
    expect((await f.confirm()).status).toBe("committing");
    for (const op of ["input_cancel", "input_answer"] as const) {
      const r = await f.store.serve(
        op === "input_cancel"
          ? { op, schemaVersion: 1, ...f.target }
          : { op, schemaVersion: 1, ...f.target, answer: { kind: "text", text: "yes" } },
        f.owner,
      );
      if (r.op !== op) throw Error("wrong");
      expect(r.result.reason).toBe("project_confirmation_consumed");
    }
  } finally {
    held.resolve();
    await first;
  }
  expect((await first).status).toBe("created");
  expect(f.update).toHaveBeenCalledTimes(1);
  expect(f.turns).toHaveBeenCalledTimes(1);
});
it.each(["input_answer", "input_cancel"] as const)(
  "%s already awaiting auth cannot overwrite a later claim",
  async (op) => {
    const f = await fixture();
    const entered = latch(),
      held = latch();
    let calls = 0;
    const waiter = {
      ...f.owner,
      authorize: async () => {
        if (++calls === 1) {
          entered.resolve();
          await held.promise;
        }
        return true;
      },
    };
    const answer = f.store.serve(
      op === "input_cancel"
        ? { op, schemaVersion: 1, ...f.target }
        : { op, schemaVersion: 1, ...f.target, answer: { kind: "text", text: "yes" } },
      waiter,
    );
    await entered.promise;
    expect((await f.confirm()).status).toBe("created");
    held.resolve();
    const r = await answer;
    if (r.op !== op) throw Error("wrong");
    expect(r.result.reason).toBe("project_confirmation_consumed");
  },
);
it.each(["workspace", "settings", "revocation", "reset"])(
  "fresh commit guard refuses %s replacement after claim",
  async (kind) => {
    const f = await fixture();
    const before = await f.settings.load();
    f.update.mockImplementation((mutate, guard) =>
      f.settings.update(mutate, async () => {
        if (kind === "workspace") {
          fs.renameSync(f.workspace, f.workspace + "-old");
          fs.mkdirSync(f.workspace);
        }
        if (kind === "settings") {
          const current = await f.settings.load();
          fs.writeFileSync(
            join(f.root, "settings.json"),
            JSON.stringify({
              ...current,
              projects: {
                ...current.projects,
                projects: [{ id: "foreign", name: "Foreign", workspaces: [], roles: [] }],
              },
            }),
          );
        }
        if (kind === "revocation") {
          f.revoke();
          f.store.invalidateQuestionPrincipal("original");
        }
        if (kind === "reset")
          await f.store.serve({
            op: "reset",
            schemaVersion: 1,
            conversationId: f.id,
            expectedRevision: f.store.conversation(f.id)!.revision,
          });
        await guard?.();
      }),
    );
    expect((await f.confirm()).status).toBe("uncertain");
    expect((await f.settings.load()).projects.projects.some((p) => p.id === "new-project")).toBe(false);
    if (kind !== "settings")
      expect((await f.settings.load()).projects.projects).toEqual(before.projects.projects);
    if (kind !== "reset")
      expect(["committing", "uncertain", "refused"]).toContain(
        (await f.read({ ...f.owner, authorize: async () => true })).status,
      );
  },
);
it("post-rename settings failure never replays or promotes matching settings across a cold store", async () => {
  const f = await fixture();
  f.update.mockImplementation(async (m, g) => {
    await f.settings.update(m, g);
    throw Error("directory sync after rename");
  });
  const r = await f.confirm();
  expect(r.status).toBe("uncertain");
  expect((await f.settings.load()).projects.projects).toHaveLength(1);
  const cold = new ConversationStore(join(f.root, "conversations"), async () => {
    throw Error("no turn");
  });
  const apply = vi.fn();
  cold.projectOnboarding = { ...f.store.projectOnboarding!, apply };
  const result = await cold.serve({ op: "project_proposal_confirm", schemaVersion: 1, ...f.target }, f.owner);
  expect(result.op === "project_proposal_confirm" && result.result.status).toBe("uncertain");
  expect(apply).not.toHaveBeenCalled();
  await cold.close();
});
it.each([false, true])(
  "claim persistence failure at renamed=%s never attempts settings",
  async (afterRename) => {
    const f = await fixture();
    const original = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      if (String(b).endsWith("meta.json")) {
        if (afterRename) original(a, b);
        throw Error("metadata interrupted");
      }
      return original(a, b);
    });
    const r = await f.confirm();
    // Neither writer failure proves that rename had no OS effect: both consume uncertainty.
    expect(r.status).toBe("uncertain");
    expect(f.update).not.toHaveBeenCalled();
  },
);
it("immutable hash changes for config and not receipt state", async () => {
  const f = await fixture();
  const meta = JSON.parse(fs.readFileSync(join(f.root, "conversations", f.id, "meta.json"), "utf8"));
  const a = meta.questions.records[0].projectCreation;
  expect(proposalHash(a.immutable)).toBe(a.artifactSha256);
  a.status = "committing";
  expect(proposalHash(a.immutable)).toBe(a.artifactSha256);
  a.immutable.command.name = "Other";
  expect(proposalHash(a.immutable)).not.toBe(a.artifactSha256);
  expect(projectsRevision((await f.settings.load()).projects)).toBe(f.target.expectedProjectsRevision);
});
it("unbound/model-only callback and strict draft cannot supply enrollment or authority", async () => {
  const tool = questionTools({}).find((t) => t.name === "propose_project_create")!;
  await expect(
    tool.execute(
      "x",
      ProjectProposalDraftSchema.parse({ projectId: "x", name: "X", prompt: "review" }),
      undefined,
      undefined,
      {} as never,
    ),
  ).rejects.toThrow("current owner");
  for (const extra of [
    { workspacePath: "/elsewhere" },
    { machineId: "kh2" },
    { grants: [] },
    { expectedRevision: "a".repeat(64) },
  ])
    expect(
      ProjectProposalDraftSchema.safeParse({ projectId: "x", name: "X", prompt: "review", ...extra }).success,
    ).toBe(false);
});
it("receipt persistence loss reports uncertain on read and never republishes an in-memory success", async () => {
  const f = await fixture();
  const original = fs.renameSync;
  let writes = 0;
  vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
    if (String(b).endsWith("meta.json") && ++writes === 2) throw Error("receipt write lost");
    return original(a, b);
  });
  expect((await f.confirm()).status).toBe("uncertain");
  expect((await f.read()).status).toBe("uncertain");
  expect((await f.confirm()).status).toBe("uncertain");
  expect(f.update).toHaveBeenCalledTimes(1);
});
it("late successful mutation cannot overwrite a replacement incarnation", async () => {
  const f = await fixture();
  const apply = f.store.projectOnboarding!.apply;
  f.store.projectOnboarding!.apply = async (a, g) => {
    const result = await apply(a, g);
    await f.store.serve({
      op: "reset",
      schemaVersion: 1,
      conversationId: f.id,
      expectedRevision: f.store.conversation(f.id)!.revision,
    });
    return result;
  };
  expect((await f.confirm()).status).toBe("uncertain");
  expect((await f.settings.load()).projects.projects).toHaveLength(1);
  const meta = JSON.parse(fs.readFileSync(join(f.root, "conversations", f.id, "meta.json"), "utf8"));
  expect(meta.questions.incarnationId).not.toBe(f.target.incarnationId);
  expect(meta.questions.records).toHaveLength(0);
  expect((await f.confirm()).status).toBe("refused");
  expect(f.update).toHaveBeenCalledTimes(1);
});
it("pending restart has no write closure; consumed receipts do not read or compare settings", async () => {
  const f = await fixture();
  const cold = new ConversationStore(join(f.root, "conversations"), async () => {});
  const apply = vi.fn(),
    load = vi.fn(async () => {
      throw Error("receipt must not inspect settings");
    });
  cold.projectOnboarding = { ...f.store.projectOnboarding!, apply, load };
  const r = await cold.serve({ op: "project_proposal_confirm", schemaVersion: 1, ...f.target }, f.owner);
  expect(r.op === "project_proposal_confirm" && r.result.status).toBe("refused");
  expect(apply).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
  await cold.close();
});
it("canonical directory replacement after proposal refuses even with unchanged settings revision", async () => {
  const f = await fixture();
  fs.renameSync(f.workspace, f.workspace + "-old");
  fs.mkdirSync(f.workspace);
  expect((await f.confirm()).status).toBe("refused");
  expect(f.update).not.toHaveBeenCalled();
});
it("changed proposal bytes cannot be loaded as a new source of authority", async () => {
  const f = await fixture();
  const file = join(f.root, "conversations", f.id, "meta.json");
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  meta.questions.records[0].projectCreation.immutable.command.name = "Changed";
  fs.writeFileSync(file, JSON.stringify(meta));
  const cold = new ConversationStore(join(f.root, "conversations"), async () => {});
  const apply = vi.fn();
  cold.projectOnboarding = { ...f.store.projectOnboarding!, apply };
  await expect(
    cold.serve({ op: "project_proposal_confirm", schemaVersion: 1, ...f.target }, f.owner),
  ).rejects.toThrow("question_state_unavailable");
  expect(apply).not.toHaveBeenCalled();
  await cold.close();
});

it("missing tracker is explicitly unavailable, and changed tracker bytes cannot confirm an old artifact", async () => {
  const trackerRef = { workspaceId: "primary" as const, path: ".clankie/tracking.json" as const };
  await expect(fixture({ trackerRef })).rejects.toThrow("project_tracker_unavailable");
  const f = await fixture({ trackerRef }, (workspace) => {
    fs.mkdirSync(join(workspace, ".clankie"));
    fs.writeFileSync(
      join(workspace, ".clankie", "tracking.json"),
      JSON.stringify({
        schemaVersion: 1,
        backend: "github",
        github: { repo: "fixture/first" },
        decidedBy: "owner",
        decidedAt: "2026-10-04T00:00:00Z",
      }),
    );
  });
  const path = join(f.workspace, ".clankie", "tracking.json");
  const current = JSON.parse(fs.readFileSync(path, "utf8"));
  fs.writeFileSync(path, JSON.stringify({ ...current, github: { repo: "fixture/second" } }));
  expect((await f.confirm()).status).toBe("uncertain");
  expect(f.update).not.toHaveBeenCalled();
});

it("a newer original-owner turn cannot replace a committing artifact and invalidates its final revision guard", async () => {
  const f = await fixture();
  const held = latch(),
    entered = latch();
  f.update.mockImplementation((mutate, guard) =>
    f.settings.update(mutate, async () => {
      entered.resolve();
      await held.promise;
      await guard?.();
    }),
  );
  const first = f.confirm();
  await entered.promise;
  try {
    const sent = await f.store.serve(
      {
        op: "send",
        schemaVersion: 1,
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: f.id,
          surfaceClientId: "fixture",
          expectedRevision: f.store.conversation(f.id)!.revision,
          message: "another proposal",
        },
      },
      f.owner,
    );
    if (sent.op !== "send" || sent.result.status !== "accepted") throw Error("not accepted");
    await f.store.awaitRun(sent.result.runId);
    const meta = JSON.parse(fs.readFileSync(join(f.root, "conversations", f.id, "meta.json"), "utf8"));
    expect(meta.questions.records).toHaveLength(1);
    expect(meta.questions.records[0].question.requestId).toBe(f.target.requestId);
    expect(meta.questions.records[0].projectCreation.status).toBe("committing");
  } finally {
    held.resolve();
  }
  expect((await first).status).toBe("uncertain");
  expect((await f.settings.load()).projects.projects).toHaveLength(0);
});
it("uncertain initial artifact persistence does not restore an empty question slot", async () => {
  let workspace = "",
    attemptedRequest = "";
  const original = fs.renameSync;
  await expect(
    fixture({}, (path) => {
      workspace = path;
      vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
        if (String(b).endsWith("meta.json") && !attemptedRequest) {
          const meta = JSON.parse(fs.readFileSync(a, "utf8"));
          const record = meta.questions?.records.find(
            (r: { projectCreation?: unknown }) => r.projectCreation,
          );
          if (record) {
            attemptedRequest = record.question.requestId;
            original(a, b);
            throw Error("initial artifact rename outcome unknown");
          }
        }
        return original(a, b);
      });
    }),
  ).rejects.toThrow("No proposal");
  expect(attemptedRequest).not.toBe("");
  const conversations = join(workspace, "..", "conversations");
  const id = fs
    .readdirSync(conversations)
    .find((name) => fs.existsSync(join(conversations, name, "meta.json")))!;
  const meta = JSON.parse(fs.readFileSync(join(conversations, id, "meta.json"), "utf8"));
  expect(meta.questions.records).toHaveLength(1);
  expect(meta.questions.records[0].question.requestId).toBe(attemptedRequest);
});
