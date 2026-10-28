import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLocalTracker } from "../src/tracker-local.ts";
import { TRACKER_LEAD, TRACKER_OWNER, TRACKER_TOOLS, type TrackerActor } from "../src/tracker-tools.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Copy-on-write (LOCAL-VUH-42): every write tool runs against a draft over the frozen committed
// store. A missed `own` refuses its write naming the site, and under Vitest every commit also
// proves the incremental sync diff equals the full one. Guided reviews and the owner inbox
// need a Git source and the owner mailbox route; their own suites cover them.
const ELSEWHERE = new Set([
  "save_guided_review",
  "post_guided_finding",
  "post_retire_guided_review",
  "post_snooze_inbox_item",
  "post_unsnooze_inbox_item",
]);

it("runs every write tool, update and transaction through the frozen committed store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tracker-copy-on-write-"));
  roots.push(directory);
  const tracker = createLocalTracker({
    directory,
    // Evidence storage is out of scope here; references only need to be well formed.
    async validateEvidence() {},
  });
  const used = new Set<string>();
  const lead: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
  const owner: TrackerActor = { ...TRACKER_OWNER, onBehalfOf: [] };
  const worker: TrackerActor = { type: "agent-worker", id: "builder", onBehalfOf: [TRACKER_OWNER] };
  const call = async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
    actor: TrackerActor = lead,
    ownerApp?: { readonly deviceId: string },
  ) => {
    used.add(name);
    try {
      return (await tracker.call(name, args, { actor, ...(ownerApp ? { ownerApp } : {}) })) as T;
    } catch (error) {
      throw new Error(`${name} failed: ${(error as Error).message}`, { cause: error });
    }
  };

  const project = await call<{ id: string }>("save_project", {
    name: "Frozen",
    addTeams: ["LOCAL"],
    cycleDays: 7,
  });
  const other = await call<{ id: string }>("save_project", { name: "Elsewhere", addTeams: ["LOCAL"] });
  const storeId = await tracker.storeId();
  await call("save_project", {
    id: project.id,
    description: "Edited in place",
    links: [{ url: "https://example.com", title: "Spec" }],
  });
  const group = await call<{ id: string }>("create_issue_label", { name: "Area", isGroup: true });
  const label = await call<{ id: string; name: string }>("save_issue_label", {
    name: "Storage",
    parent: group.id,
  });
  const parent = await call<{ id: string; updatedAt: string }>("save_issue", {
    team: "LOCAL",
    project: project.id,
    title: "Parent",
  });
  const issue = await call<{ id: string; identifier: string; updatedAt: string }>("save_issue", {
    team: "LOCAL",
    project: project.id,
    title: "Child",
    labels: [label.name],
    parentId: parent.id,
    cycle: "current",
    links: [{ url: "https://example.com/a", title: "A" }],
  });
  const blocker = await call<{ id: string }>("save_issue", {
    team: "LOCAL",
    project: project.id,
    title: "Blocker",
  });
  // Edits that reach other records: relations, a label rename across issues, a status binding.
  await call("save_issue", {
    id: issue.id,
    blockedBy: [blocker.id],
    addLabels: [label.name],
    ifUpdatedAt: issue.updatedAt,
  });
  await call("save_issue_label", { id: label.id, name: "Persistence" });
  const status = await call<{ id: string }>("save_issue_status", { name: "Queued", type: "unstarted" });
  await call("save_issue_status", { id: status.id, name: "Waiting" });
  await call("save_issue_status", { id: status.id, stage: "delivered" });

  const comment = await call<{ id: string }>("create_comment", { issueId: issue.id, body: "First" });
  await call("save_comment", { id: comment.id, body: "First, edited" });
  const update = await call<{ id: string }>("save_status_update", {
    type: "project",
    project: project.id,
    body: "On track",
  });
  await call("save_status_update", { type: "project", id: update.id, health: "atRisk" });
  await call("save_comment", { statusUpdateId: update.id, body: "Noted" });

  await call("post_issue_event", { issueId: issue.id, type: "ack" });
  await call("post_issue_event", { issueId: issue.id, type: "blocked", body: "Waiting" });
  await call("save_lease", { issueId: issue.id, ttlMinutes: 30 });
  const run = await call<{ id: string }>("save_run", {
    issueId: issue.id,
    worktree: "/tmp/frozen",
    branch: "frozen",
  });
  await call("save_run", { id: run.id, tokens: 10, summary: "Halfway" });
  await call("post_issue_ask", {
    issueId: issue.id,
    runId: run.id,
    purpose: "gate",
    gate: "spend",
    body: "May I?",
  });
  await call("post_run_control", { runId: run.id, action: "steer", body: "Keep going" });
  await call("post_run_control", { runId: run.id, action: "stop" });
  await call("save_lease", { issueId: issue.id, release: true });
  await call("post_issue_event", { issueId: issue.id, type: "result", stage: "landed", body: "Merged" });
  const reference = {
    recordId: "record-1",
    sha256: "a".repeat(64),
    url: `clankie://evidence/sha256/${"a".repeat(64)}`,
    type: "log",
  };
  const bundle = await call<{ id: string }>(
    "save_evidence_bundle",
    { issueId: issue.id, references: [reference], gaps: [] },
    worker,
  );
  await call("post_bundle_check", { bundleId: bundle.id, body: "Checked" }, owner);
  // The owner's app sends it back (a comment and a stage move in one write), then it lands again.
  const app: TrackerActor = { type: "app", id: "device:phone", onBehalfOf: [TRACKER_OWNER] };
  await call(
    "post_owner_verdict",
    { issueId: issue.id, bundleId: bundle.id, verdict: "send_back", note: "Not yet" },
    app,
    { deviceId: "phone" },
  );
  await call("post_issue_event", { issueId: issue.id, type: "result", stage: "landed", body: "Fixed" });
  await call("post_issue_event", { issueId: issue.id, type: "result", stage: "owner-verified" }, owner);

  const view = await call<{ id: string; updatedAt: string }>("save_issue_view", {
    project: project.id,
    storeId,
    schemaVersion: 1,
    name: "Mine",
    filter: { priority: 1 },
  });
  await call("save_issue_view", {
    project: project.id,
    storeId,
    schemaVersion: 1,
    id: view.id,
    name: "Renamed",
    ifUpdatedAt: view.updatedAt,
  });
  await call("post_delete_issue_view", { project: project.id, storeId, id: view.id });

  // A move carries its comments, events, runs, bundles and lease into the other project's group.
  await call("save_issue", { id: issue.id, project: other.id });
  // One keyed transaction with several operations and a refused one that rolls back.
  const applied = await tracker.sync(
    {
      action: "transaction",
      idempotencyKey: "copy-on-write-transaction",
      operations: [
        { name: "save_issue", arguments: { id: parent.id, title: "Parent, renamed" } },
        { name: "create_comment", arguments: { issueId: parent.id, body: "In a transaction" } },
        { name: "save_issue", arguments: { id: parent.id, priority: 1 } },
      ],
    },
    { actor: lead },
  );
  expect(applied).toMatchObject({ outcome: "applied" });
  await expect(
    tracker.sync(
      {
        action: "transaction",
        idempotencyKey: "copy-on-write-refused",
        operations: [
          { name: "save_issue", arguments: { id: parent.id, title: "Never committed" } },
          { name: "save_issue", arguments: { id: "missing-issue", title: "Refuses the batch" } },
        ],
      },
      { actor: lead },
    ),
  ).rejects.toThrow(/not found/u);

  const writes = TRACKER_TOOLS.map((tool) => tool.name).filter((name) =>
    /^(?:save|create|post)_/u.test(name),
  );
  expect(writes.filter((name) => !used.has(name) && !ELSEWHERE.has(name))).toEqual([]);

  // A fresh process reads back exactly what the reused in-memory snapshot served.
  const reopened = createLocalTracker({ directory });
  for (const id of [issue.id, parent.id])
    expect(await reopened.call("get_issue", { id })).toEqual(await tracker.call("get_issue", { id }));
  const persisted = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8")) as {
    issues: { id: string; title: string }[];
    audit: { tool: string; outcome: string; detail?: string }[];
  };
  expect(persisted.issues.find((entry) => entry.id === parent.id)?.title).toBe("Parent, renamed");
  expect(persisted.audit.filter((entry) => entry.detail?.includes("changed in place"))).toEqual([]);
});
