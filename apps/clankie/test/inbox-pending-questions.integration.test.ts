import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createLocalTracker, writeConvention } from "@clankie/work-items";
import { ConversationStore } from "../src/captain/conversations.ts";
import { QuestionDraftSchema, type QuestionAuthority } from "../src/captain/conversation-questions.ts";
import {
  createWorkItemsService,
  INBOX_PENDING_QUESTIONS_TOOL,
  type WorkInboxContext,
} from "../src/work-items.ts";

// Real tracker store, real ConversationStore question and the real service coordinator. The route
// itself is not served here: `finalCheck` is called the way the route calls it after its last await.
it("lists linked pending asks from the live store and fails the final publication guard once stale", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "inbox-pending-questions-")));
  try {
    const path = join(root, "repo");
    await mkdir(path);
    await writeConvention(path, {
      schemaVersion: 1,
      backend: "builtin",
      decidedBy: "owner",
      decidedAt: "2026-10-12T00:00:00Z",
    });
    const directory = join(root, "tracker");
    const tracker = createLocalTracker({ directory, team: "VUH", project: "inbox" });
    const actor = { type: "agent-worker" as const, id: "clankie", onBehalfOf: [] };
    const projectId = ((await tracker.call("list_projects", {})) as { projects: { id: string }[] })
      .projects[0]!.id;
    const storeId = await tracker.storeId();
    const settings = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "inbox",
          name: "inbox",
          workerCap: 20,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          trackerProjectId: projectId,
        },
      ],
    });
    const serviceFor = () =>
      createWorkItemsService({
        stateDirectory: join(root, "service"),
        globalTrackerDirectory: directory,
        builtInTracker: () => createLocalTracker({ directory }),
        projects: async () => settings,
        projectsFence: async () => {
          const snapshot = JSON.stringify(settings);
          return {
            projects: settings,
            assertCurrent: () => {
              if (snapshot !== JSON.stringify(settings)) throw new Error("fixture saved settings changed");
            },
          };
        },
        localMachineId: "local",
      });

    let service = serviceFor();
    let conversations = new ConversationStore(join(root, "conversations"), async () => {});
    const made = await conversations.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "workspace", workspaceId: path },
      title: "Inbox",
    });
    if (made.op !== "create") throw new Error("wrong result");
    const admission = { current: () => true, authorize: async () => true };
    const asked = await conversations.requestSurfaceQuestion(
      made.conversation.conversationId,
      {
        ...QuestionDraftSchema.parse({
          kind: "choice",
          prompt: "Proceed?",
          options: [{ label: "Proceed" }, { label: "Revise" }],
          allowFreeform: true,
        }),
        purpose: "decision",
        waitingOn: "Owner decision",
        recommendation: "Proceed",
      },
      admission,
    );
    const question = asked.question!;
    const issue = (await tracker.call("save_issue", {
      team: "VUH",
      project: projectId,
      title: "Needs owner",
    })) as {
      id: string;
    };
    await tracker.call("post_issue_ask", { issueId: issue.id, purpose: "decision", body: "Proceed?" });
    const ask = (
      (await tracker.call("list_issue_events", { issueId: issue.id })) as {
        events: { id: string; type: string }[];
      }
    ).events.find((event) => event.type === "ask")!;
    await tracker.linkOwnerAsk(ask.id, question.requestId);

    const authority: QuestionAuthority = {
      principal: { kind: "operator", id: "owner" },
      authorize: async () => true,
      current: () => true,
    };
    const inboxFor = (): WorkInboxContext => ({
      authority,
      captain: { prepareInboxQuestions: (ids, who) => conversations.prepareInboxQuestions(ids, who) },
    });
    const inbox = inboxFor();
    const result = (await service.callTracker(
      INBOX_PENDING_QUESTIONS_TOOL,
      { project: projectId, storeId },
      { repo: path, local: true, actor, inbox },
    )) as {
      complete: boolean;
      rows: { eventId: string; issueId: string; purpose: string; target: { requestId: string } }[];
    };
    expect(result.complete).toBe(true);
    expect(result.rows).toEqual([
      expect.objectContaining({
        purpose: "decision",
        target: expect.objectContaining({
          eventId: ask.id,
          issueId: issue.id,
          requestId: question.requestId,
        }),
      }),
    ]);
    inbox.finalCheck!();

    const scope = { project: projectId, storeId };
    type Row = {
      target: Record<string, unknown>;
      expectedRevision: number;
      updatedAt: string | null;
      attention: string;
    };
    const row = result.rows[0]! as unknown as Row;
    const call = (name: string, args: Record<string, unknown>, who = actor) =>
      service.callTracker(
        name,
        { ...scope, ...args },
        { repo: path, local: true, actor: who, inbox: inboxFor() },
      );
    const file = join(directory, "tracker.json");
    const before = JSON.parse(await readFile(file, "utf8"));
    const change = {
      target: row.target,
      expectedRevision: row.expectedRevision,
      ifUpdatedAt: null,
      idempotencyKey: "snooze-round-trip-01",
      until: new Date(Date.now() + 60_000).toISOString(),
    };
    const snoozed = (await call("post_snooze_inbox_item", change)) as Row;
    expect(snoozed.attention).toBe("snoozed");
    expect(await call(INBOX_PENDING_QUESTIONS_TOOL, {})).toMatchObject({ rows: [], complete: true });
    expect(await call(INBOX_PENDING_QUESTIONS_TOOL, { attention: "snoozed" })).toMatchObject({
      rows: [expect.objectContaining({ attention: "snoozed" })],
    });
    const afterSnooze = await readFile(file, "utf8");
    expect(await call("post_snooze_inbox_item", change)).toEqual(snoozed); // original actor/key receipt
    expect(await readFile(file, "utf8")).toBe(afterSnooze);
    // Display name and on-behalf-of chains never select another actor's private state.
    expect(await call(INBOX_PENDING_QUESTIONS_TOOL, {}, { ...actor, id: "another-device" })).toMatchObject({
      rows: [expect.objectContaining({ attention: "active" })],
    });
    await expect(
      call("post_snooze_inbox_item", {
        ...change,
        ifUpdatedAt: snoozed.updatedAt,
        until: new Date(Date.now() + 31 * 86400000).toISOString(),
        idempotencyKey: "out-of-bound-01",
      }),
    ).rejects.toThrow(/30 days/);
    await expect(
      call("post_unsnooze_inbox_item", {
        target: row.target,
        expectedRevision: row.expectedRevision,
        ifUpdatedAt: null,
        idempotencyKey: "stale-state-01",
      }),
    ).rejects.toThrow(/precondition_failed/);
    await expect(call("get_inbox_item", { target: row.target, storeId: "replaced-store" })).rejects.toThrow(
      /store_replaced/,
    );
    const stored = JSON.parse(afterSnooze);
    for (const key of ["issues", "events", "ownerAsks", "runs", "bundles"])
      expect(stored[key]).toEqual(before[key]);
    // Both stores and the coordinator reopen from real durable files.
    service = serviceFor();
    conversations = new ConversationStore(join(root, "conversations"), async () => {});
    expect(await call("get_inbox_item", { target: row.target })).toMatchObject({
      attention: "snoozed",
      updatedAt: snoozed.updatedAt,
    });
    await call("post_unsnooze_inbox_item", {
      target: row.target,
      expectedRevision: row.expectedRevision,
      ifUpdatedAt: snoozed.updatedAt,
      idempotencyKey: "unsnooze-round-trip-01",
    });
    expect(await call(INBOX_PENDING_QUESTIONS_TOOL, {})).toMatchObject({
      rows: [expect.objectContaining({ attention: "active" })],
    });
    await call("post_snooze_inbox_item", {
      ...change,
      idempotencyKey: "short-expiry-01",
      until: new Date(Date.now() + 2000).toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 2050));
    expect(await call(INBOX_PENDING_QUESTIONS_TOOL, {})).toMatchObject({
      rows: [expect.objectContaining({ attention: "active" })],
    });
    const foreignActor = { ...actor, id: "another-device" };
    const foreignSnooze = (await call(
      "post_snooze_inbox_item",
      {
        ...change,
        idempotencyKey: "foreign-expired-state",
        until: new Date(Date.now() + 1000).toISOString(),
      },
      foreignActor,
    )) as Row;
    await new Promise((resolve) => setTimeout(resolve, 1050));
    const ownExpired = (await call("get_inbox_item", { target: row.target })) as Row;
    await call("post_unsnooze_inbox_item", {
      target: row.target,
      expectedRevision: row.expectedRevision,
      ifUpdatedAt: ownExpired.updatedAt,
      idempotencyKey: "own-expired-cleanup",
    });
    expect(await call("get_inbox_item", { target: row.target }, foreignActor)).toMatchObject({
      attention: "active",
      updatedAt: foreignSnooze.updatedAt,
    });
    // A tracker update after the read (during the HTTP route's final await) invalidates publication.
    const publication = inboxFor();
    await service.callTracker(INBOX_PENDING_QUESTIONS_TOOL, scope, {
      repo: path,
      local: true,
      actor,
      inbox: publication,
    });
    await tracker.call("save_issue", { id: issue.id, title: "Changed current data" });
    expect(() => publication.finalCheck!()).toThrow(/tracker store changed/);
    const fresh = inboxFor();
    await service.callTracker(INBOX_PENDING_QUESTIONS_TOOL, scope, {
      repo: path,
      local: true,
      actor,
      inbox: fresh,
    });
    // The ask resolves after the coordinator returned, e.g. during the route's last await.
    await conversations.cancelSurfaceQuestion(
      made.conversation.conversationId,
      {
        incarnationId: question.incarnationId,
        requestId: question.requestId,
        expectedRevision: asked.revision!,
      },
      admission,
    );
    expect(() => fresh.finalCheck!()).toThrow("inbox_fence_stale");
    const after = (await service.callTracker(
      INBOX_PENDING_QUESTIONS_TOOL,
      { project: projectId, storeId },
      { repo: path, local: true, actor, inbox: inboxFor() },
    )) as { rows: unknown[] };
    expect(after.rows).toEqual([]);
    // Gate and verification identities come from the same existing source events.
    const gated = (await tracker.call("save_issue", { team: "VUH", project: projectId, title: "Gate" })) as {
      id: string;
    };
    const run = (await tracker.call("save_run", { issueId: gated.id })) as { id: string };
    const gate = (await tracker.call("post_issue_ask", {
      issueId: gated.id,
      runId: run.id,
      purpose: "gate",
      gate: "merge",
      body: "Synthetic gate",
    })) as { id: string };
    const gateQuestion = await conversations.requestSurfaceQuestion(
      made.conversation.conversationId,
      {
        ...QuestionDraftSchema.parse({
          kind: "choice",
          prompt: "Gate?",
          options: [{ label: "Approve" }, { label: "Decline" }],
          purpose: "gate",
          gate: "merge",
          waitingOn: "Synthetic gate",
        }),
      },
      admission,
    );
    await tracker.linkOwnerAsk(gate.id, gateQuestion.question!.requestId);
    const verified = (await tracker.call("save_issue", {
      team: "VUH",
      project: projectId,
      title: "Verify",
    })) as { id: string; identifier: string; url: string };
    await tracker.call("post_issue_event", { issueId: verified.id, type: "ack" });
    await tracker.call("post_issue_event", { issueId: verified.id, type: "result", stage: "landed" });
    const verifyEvent = (
      (await tracker.call("list_issue_events", { issueId: verified.id })) as {
        events: { id: string; type: string; to?: string }[];
      }
    ).events.find((entry) => entry.type === "stage" && entry.to === "landed")!;
    const verifyQuestion = await conversations.requestSurfaceQuestion(
      made.conversation.conversationId,
      {
        ...QuestionDraftSchema.parse({
          kind: "choice",
          prompt: "Check?",
          options: [{ label: "It works" }, { label: "Send back" }],
          purpose: "verify",
          issue: { tracker: "clankie-work", key: verified.identifier, url: verified.url },
          waitingOn: "Synthetic check",
        }),
      },
      admission,
    );
    await tracker.linkOwnerAsk(verifyEvent.id, verifyQuestion.question!.requestId);
    const both = (await call(INBOX_PENDING_QUESTIONS_TOOL, { limit: 1 })) as {
      rows: Row[];
      cursor: string;
      hasNextPage: boolean;
    };
    expect(both.hasNextPage).toBe(true);
    const second = (await call(INBOX_PENDING_QUESTIONS_TOOL, { limit: 1, cursor: both.cursor })) as {
      rows: Row[];
      hasNextPage: boolean;
    };
    expect(second.hasNextPage).toBe(false);
    const canonicalBefore = JSON.parse(await readFile(file, "utf8"));
    for (const [index, target] of [...both.rows, ...second.rows].entries()) {
      await call("post_snooze_inbox_item", {
        target: target.target,
        expectedRevision: target.expectedRevision,
        ifUpdatedAt: null,
        idempotencyKey: `gate-verify-snooze-${index}`,
        until: new Date(Date.now() + 60000).toISOString(),
      });
    }
    const canonicalAfter = JSON.parse(await readFile(file, "utf8"));
    for (const key of ["issues", "events", "ownerAsks", "runs", "bundles"])
      expect(canonicalAfter[key]).toEqual(canonicalBefore[key]);
    expect(canonicalAfter.runs.find((entry: { id: string }) => entry.id === run.id).pendingGates).toContain(
      gate.id,
    );
    expect(await call(INBOX_PENDING_QUESTIONS_TOOL, {})).toMatchObject({ rows: [] });
    // A stopped attempt cannot regain gate attention even while its mailbox ask remains pending.
    await tracker.call("post_run_control", { runId: run.id, action: "stop" });
    const remaining = (await call(INBOX_PENDING_QUESTIONS_TOOL, { attention: "all" })) as { rows: Row[] };
    expect(remaining.rows.map((entry) => entry.target.requestId)).not.toContain(
      gateQuestion.question!.requestId,
    );
    expect(remaining.rows.map((entry) => entry.target.requestId)).toContain(
      verifyQuestion.question!.requestId,
    );
    // Scope changes and actual store replacement refuse before receipt replay.
    const current = inboxFor();
    await service.callTracker(
      INBOX_PENDING_QUESTIONS_TOOL,
      { ...scope, attention: "all" },
      { repo: path, local: true, actor, inbox: current },
    );
    delete settings.projects[0]!.trackerProjectId;
    expect(() => current.finalCheck!()).toThrow(/settings changed/);
    await expect(call(INBOX_PENDING_QUESTIONS_TOOL, {})).rejects.toThrow(/binding/);
    settings.projects[0]!.trackerProjectId = projectId;
    const replacement = createLocalTracker({ directory: join(root, "replacement") });
    await replacement.call("list_teams", {});
    await copyFile(join(root, "replacement", "tracker.json"), file);
    await expect(call("post_snooze_inbox_item", change)).rejects.toThrow(/store_replaced/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
