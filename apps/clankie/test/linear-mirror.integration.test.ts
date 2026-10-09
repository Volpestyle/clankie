import { randomUUID } from "node:crypto";
import { TRACKER_LEAD, TRACKER_OWNER, type TrackerItemEvent } from "@clankie/work-items";
import { afterEach, expect, it } from "vitest";
import { captured, DONE, issuePayload, linearMirrorFixture, NOW, OWNER_ID } from "./helpers/linear-mirror.ts";

// VUH-1965 proof: signed webhooks shaped like Linear's data-change events, over real
// HTTP, into a scratch store imported from the captured Clankie Work project.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(options: { withhold?: string } = {}) {
  const f = await linearMirrorFixture(options);
  cleanups.push(f.close);
  return f;
}

it("applies signed comment, state and new-issue webhooks once, attributed and pushed, while wakes are unchanged", async () => {
  const f = await fixture();
  const issue = f.source.issues.find((entry) => entry.identifier === "VUH-1905")!;
  const comment = f.envelope("Comment", "create", {
    id: randomUUID(),
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    body: "Mirror proof: this comment was made in Linear.",
    issueId: issue.id,
    parentId: null,
    userId: OWNER_ID,
    user: { id: OWNER_ID, name: "James Volpe", email: "owner@example.test" },
    issue: { id: issue.id, title: issue.title, identifier: issue.identifier, teamId: f.source.team.id },
  });

  // Never mirrors by default: an accepted webhook leaves an unconfigured scratch store alone.
  const untouched = await f.store();
  expect(await (await f.post(comment, "Comment")).json()).toEqual({ schemaVersion: 1, ingested: true });
  await f.mirrors.idle();
  expect(await f.store()).toBe(untouched);
  expect((await f.mirror("status")).body).toMatchObject({ enabled: false });

  expect(await f.mirror("enable")).toMatchObject({ status: 200, body: { enabled: true, scratch: "work" } });
  const pushed: TrackerItemEvent[] = [];
  const seq = (JSON.parse(await f.store()).events ?? []).length;
  const unsubscribe = await f.mirrors.tracker("work").subscribe((event) => pushed.push(event), seq);
  const boot = await f.scratch.sync({ action: "bootstrap", type: "full", projects: ["*"], lazy: false });
  if (boot.outcome !== "bootstrap") throw new Error("Expected bootstrap");
  const meta = JSON.parse(boot.ndjson.trim().split("\n").at(-1)!);
  const waiting = f.scratch.sync({
    action: "subscribe",
    projects: [f.projectId],
    storeId: meta.storeId,
    lastSyncId: meta.lastSyncId,
    waitMs: 10_000,
    limit: 100,
  });

  // The same signed bytes again, now that the owner enabled the mirror: wakes behave as before.
  const wakesBefore = f.wakes.length;
  expect(await (await f.post(comment, "Comment")).json()).toEqual({ schemaVersion: 1, ingested: true });
  const live = await waiting;
  if (live.outcome !== "deltas") throw new Error("Expected pushed deltas");
  expect(live.commits.at(-1)).toMatchObject({ tool: "mirror_linear", actor: { type: "human", id: "owner" } });
  await f.mirrors.idle();
  expect(f.wakes.length).toBe(wakesBefore + 1);
  const comments = (await f.scratch.call("list_comments", { issueId: issue.id, limit: 250 })) as {
    comments: { id: string; body: string }[];
  };
  expect(comments.comments.map((c) => c.body)).toContain("Mirror proof: this comment was made in Linear.");
  expect(pushed).toEqual([
    expect.objectContaining({
      type: "comment",
      identifier: "VUH-1905",
      via: "linear_mirror",
      actor: expect.objectContaining({ type: "human", id: "owner" }),
      selfEcho: false,
    }),
  ]);

  const state = f.envelope("Issue", "update", issuePayload(issue, { stateId: DONE.id, state: DONE }), {
    updatedFrom: { updatedAt: issue.updatedAt, stateId: (issue.state as { id: string }).id },
  });
  await f.post(state, "Issue");
  await f.mirrors.idle();
  expect(await f.scratch.call("get_issue", { id: "VUH-1905" })).toMatchObject({ status: "Done" });
  expect(pushed.at(-1)).toMatchObject({
    type: "state",
    from: "In Progress",
    to: "Done",
    via: "linear_mirror",
    actor: { type: "human", id: "owner" },
  });

  const created = { id: randomUUID(), identifier: "VUH-1999" };
  const fresh = f.envelope(
    "Issue",
    "create",
    issuePayload(issue, {
      ...created,
      number: 1999,
      title: "Appeared in Linear after the import",
      description: "Made in Linear while the mirror runs.",
      createdAt: NOW.toISOString(),
      creatorId: OWNER_ID,
      stateId: DONE.id,
      state: DONE,
    }),
  );
  await f.post(fresh, "Issue");
  await f.mirrors.idle();
  expect(await f.scratch.call("get_issue", { id: "VUH-1999" })).toMatchObject({
    id: created.id,
    title: "Appeared in Linear after the import",
    projectId: f.projectId,
    createdByActor: { type: "human", id: "owner" },
  });
  expect(pushed.at(-1)).toMatchObject({ type: "created", identifier: "VUH-1999", via: "linear_mirror" });

  // Every replay is a byte-for-byte no-op.
  const settled = await f.store();
  for (const raw of [comment, state, fresh]) await f.post(raw, "Issue");
  await f.mirrors.idle();
  expect(await f.store()).toBe(settled);
  expect((await f.mirror("status")).body).toMatchObject({
    enabled: true,
    counters: { applied: 3, duplicate: 3, drift: 0, failed: 0 },
    appliedEvents: 3,
  });
  expect(f.linear.queries).toEqual([]);
  unsubscribe();

  // Built-in writes to the mirrored copy are refused until cutover.
  await expect(
    f.scratch.call(
      "save_comment",
      { issueId: issue.id, body: "Local write" },
      { actor: { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] } },
    ),
  ).rejects.toThrow(/mirror_read_only/u);
  expect(JSON.parse(await f.store()).comments.length).toBe(JSON.parse(settled).comments.length);

  expect(await f.mirror("disable")).toMatchObject({ body: { enabled: false } });
  const late = f.envelope("Comment", "create", { ...JSON.parse(comment).data, id: randomUUID() });
  await f.post(late, "Comment");
  await f.mirrors.idle();
  expect(JSON.parse(await f.store()).comments.length).toBe(JSON.parse(settled).comments.length);
});

it("repairs drift by re-reading only the unknown issue through the connected account, and reports it", async () => {
  const missing = (await captured()).issues.find((issue) => issue.identifier === "VUH-1933")!;
  const f = await fixture({ withhold: missing.id });
  await expect(f.scratch.call("get_issue", { id: "VUH-1933" })).rejects.toThrow();
  expect((await f.mirror("enable")).status).toBe(200);
  const update = f.envelope("Issue", "update", issuePayload(missing, { title: missing.title }), {
    updatedFrom: { updatedAt: missing.updatedAt, title: "Earlier title" },
  });
  expect(await (await f.post(update, "Issue")).json()).toEqual({ schemaVersion: 1, ingested: true });
  await f.mirrors.idle();
  expect(await f.scratch.call("get_issue", { id: "VUH-1933" })).toMatchObject({
    id: missing.id,
    title: missing.title,
  });
  const comments = (await f.scratch.call("list_comments", { issueId: missing.id, limit: 250 })) as {
    comments: { id: string }[];
  };
  expect(comments.comments.map((c) => c.id).sort()).toEqual(
    f.source.comments
      .filter((c) => c.issueId === missing.id)
      .map((c) => c.id)
      .sort(),
  );
  // Scoped: the project root, its attachments and one issue graph, not a full project read.
  expect(f.linear.queries.some((query) => query.includes("project(id:$id) { issues("))).toBe(false);
  expect(f.linear.queries.filter((query) => query.includes("issue(id:$id) { id identifier"))).toHaveLength(1);
  const status = (await f.mirror("status")).body as { drift: Record<string, unknown>[] };
  expect(status).toMatchObject({ counters: { drift: 1, failed: 0 } });
  expect(status.drift).toEqual([
    expect.objectContaining({
      eventId: expect.any(String),
      type: "Issue",
      outcome: "repaired",
      references: [{ type: "Issue", id: missing.id }],
      requests: f.linear.queries.length,
    }),
  ]);
  // The drifted event itself is applied once; replaying it reads nothing more.
  const reads = f.linear.queries.length;
  await f.post(update, "Issue");
  await f.mirrors.idle();
  expect(f.linear.queries.length).toBe(reads);
  expect((await f.mirror("status")).body).toMatchObject({ counters: { duplicate: 1 } });
});
