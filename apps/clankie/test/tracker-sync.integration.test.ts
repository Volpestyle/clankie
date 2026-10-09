import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SUPERVISE_GRANTS, type TrackerSyncCommand } from "@clankie/protocol";
import { createLocalTracker } from "@clankie/work-items";
import { trackerEvidence } from "./helpers/tracker-evidence.ts";
import { syncFixture } from "./helpers/tracker-sync.ts";

it("bootstraps two paired clients, pushes their keyed writes in order and resumes through the authenticated relay", async () => {
  const f = await syncFixture();
  const streams: Awaited<ReturnType<typeof f.stream>>[] = [];
  try {
    const project = (await f.tracker.call("save_project", { name: "Sync", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const other = (await f.tracker.call("save_project", { name: "Private", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    await f.tracker.call("save_issue", { title: "outside", team: "LOCAL", project: other.id });
    const [a, b] = await Promise.all([f.pair("Client A"), f.pair("Client B")]);
    const bootstrap = await f.sync(a.deviceToken, {
      action: "bootstrap",
      type: "full",
      projects: [project.id],
      lazy: true,
    });
    const lines = bootstrap.ndjson
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    const meta = lines.pop();
    expect(meta.modelCount).toBe(lines.length);
    expect(lines.some((line: any) => line.data.title === "outside")).toBe(false);
    const subscribe = {
      action: "subscribe" as const,
      projects: [project.id],
      storeId: meta.storeId,
      lastSyncId: meta.lastSyncId,
      waitMs: 0,
      limit: 100,
    };
    const liveA = await f.stream(a.deviceToken, subscribe);
    streams.push(liveA);
    const liveB = await f.stream(b.deviceToken, subscribe);
    streams.push(liveB);
    const transaction = {
      action: "transaction" as const,
      idempotencyKey: "client-a-create",
      operations: [
        { name: "save_issue", arguments: { team: "LOCAL", title: "created by A", project: project.id } },
      ],
    };
    const applied = await f.sync(a.deviceToken, transaction);
    expect(applied.outcome).toBe("applied");
    const issue = applied.result.results[0];
    const [pageA, pageB] = await Promise.all([liveA.next(), liveB.next()]);
    expect(pageA).toEqual(pageB);
    expect(pageA.commits[0]).toMatchObject({
      idempotencyKey: transaction.idempotencyKey,
      actor: { type: "app", id: `device:${a.deviceId}` },
      deltas: expect.arrayContaining([
        expect.objectContaining({
          modelName: "issue",
          action: "insert",
          data: expect.objectContaining({ title: "created by A" }),
        }),
      ]),
    });
    const journalBeforeReplay = await readFile(join(f.root, "tracker.json"), "utf8");
    expect((await f.sync(a.deviceToken, transaction)).result).toEqual(applied.result);
    expect(await readFile(join(f.root, "tracker.json"), "utf8")).toBe(journalBeforeReplay);
    liveB.close();
    const updated = await f.sync(b.deviceToken, {
      action: "transaction",
      idempotencyKey: "client-b-edit",
      operations: [
        {
          name: "save_issue",
          arguments: { id: issue.id, title: "edited by B", ifUpdatedAt: issue.updatedAt },
        },
        { name: "create_comment", arguments: { issueId: issue.id, body: "heavy comment" } },
      ],
    });
    expect(updated.outcome).toBe("applied");
    const nextA = await liveA.next();
    expect(nextA.lastSyncId).toBeGreaterThan(pageA.lastSyncId);
    const resumed = await f.sync(b.deviceToken, { ...subscribe, lastSyncId: pageB.lastSyncId });
    expect(resumed.commits).toEqual(nextA.commits);
    expect(resumed.commits[0].deltas.find((delta: any) => delta.modelName === "issue").data.title).toBe(
      "edited by B",
    );
    const partial = await f.sync(b.deviceToken, {
      action: "bootstrap",
      type: "partial",
      projects: [project.id],
      lazy: true,
    });
    const partialLines = partial.ndjson
      .trim()
      .split("\n")
      .map((line: string) => JSON.parse(line));
    const comment = partialLines.find((line: any) => line.modelName === "comment");
    expect(comment.data.body).toBeUndefined();
    expect(
      partialLines.find((line: any) => line.modelName === "event" && line.data.commentId === comment.modelId)
        .data.body,
    ).toBeUndefined();
    const hydrated = await f.sync(b.deviceToken, {
      action: "batch",
      projects: [project.id],
      models: [{ modelName: "comment", modelId: comment.modelId }],
    });
    expect(hydrated.models[0].data.body).toBe("heavy comment");
    expect(await f.sync(b.deviceToken, { ...subscribe, lastSyncId: resumed.lastSyncId + 100 })).toMatchObject(
      { outcome: "rebootstrap", reason: "cursor_gap" },
    );
    const stale = await f.sync(a.deviceToken, {
      action: "transaction",
      idempotencyKey: "stale",
      operations: [
        { name: "save_issue", arguments: { id: issue.id, title: "stale", ifUpdatedAt: issue.updatedAt } },
      ],
    });
    expect(stale).toMatchObject({ outcome: "refused", reason: "precondition_failed" });
    const changedKey = await f.sync(a.deviceToken, {
      ...transaction,
      operations: [{ name: "save_issue", arguments: { team: "LOCAL", title: "different" } }],
    });
    expect(changedKey).toMatchObject({ outcome: "refused", reason: "idempotency_conflict" });
    const viewer = await f.pair("Viewer", SUPERVISE_GRANTS);
    expect((await f.sync(viewer.deviceToken, transaction)).status).toBe(403);
    const refusalCheckpoint = await liveA.next();
    expect(refusalCheckpoint.commits.flatMap((commit: any) => commit.deltas)).toHaveLength(0);
    expect((await f.revoke(a.deviceId)).status).toBe(200);
    await f.sync(b.deviceToken, {
      action: "transaction",
      idempotencyKey: "after-revoke",
      operations: [{ name: "save_issue", arguments: { id: issue.id, title: "must not reach revoked A" } }],
    });
    await expect(liveA.next()).rejects.toThrow();
  } finally {
    for (const stream of streams) stream.close();
    await f.close();
  }
}, 30_000);

it("refuses a multi-write transaction atomically and replays its refusal after reopening the journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-atomic-"));
  try {
    const tracker = createLocalTracker({ directory: root });
    const command: TrackerSyncCommand = {
      action: "transaction",
      idempotencyKey: "atomic-refusal",
      operations: [
        { name: "save_issue", arguments: { team: "LOCAL", title: "must not survive" } },
        { name: "save_issue", arguments: { id: "missing", title: "refuse" } },
      ],
    };
    await expect(tracker.sync(command)).rejects.toThrow("not found");
    const reopened = createLocalTracker({ directory: root });
    await expect(reopened.sync(command)).rejects.toThrow("not found");
    const listed = (await reopened.call("list_issues", {})) as { issues: unknown[] };
    expect(listed.issues).toHaveLength(0);
    expect(
      await reopened.call("get_write_receipt", { idempotencyKey: command.idempotencyKey }),
    ).toMatchObject({ state: "refused" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("carries complete arriving models on project moves and replays from a durable cursor after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-groups-"));
  try {
    const tracker = createLocalTracker({ directory: root });
    const a = (await tracker.call("save_project", { name: "A", addTeams: ["LOCAL"] })) as { id: string };
    const b = (await tracker.call("save_project", { name: "B", addTeams: ["LOCAL"] })) as { id: string };
    const issue = (await tracker.call("save_issue", {
      team: "LOCAL",
      title: "Moving item",
      project: a.id,
    })) as { id: string };
    const comment = (await tracker.call("create_comment", {
      issueId: issue.id,
      body: "Moves with its item",
    })) as { id: string };
    const boot = await tracker.sync({ action: "bootstrap", type: "full", projects: [b.id], lazy: false });
    if (boot.outcome !== "bootstrap") throw new Error("Bootstrap required");
    const meta = JSON.parse(boot.ndjson.trim().split("\n").at(-1)!);
    const reopened = createLocalTracker({ directory: root });
    // Another backend instance in the same host publishes to the same live journal channel.
    const subscription = reopened.sync({
      action: "subscribe",
      storeId: meta.storeId,
      lastSyncId: meta.lastSyncId,
      projects: [b.id],
      waitMs: 20_000,
      limit: 100,
    });
    await tracker.call("save_issue", { id: issue.id, project: b.id });
    const received = await subscription;
    expect(received).toMatchObject({
      outcome: "deltas",
      commits: [
        expect.objectContaining({
          deltas: expect.arrayContaining([
            expect.objectContaining({
              modelName: "issue",
              previousProjectIds: [a.id],
              projectIds: [b.id],
              data: expect.objectContaining({ title: "Moving item" }),
            }),
            expect.objectContaining({
              modelName: "comment",
              modelId: comment.id,
              projectIds: [b.id],
              data: expect.objectContaining({ body: "Moves with its item" }),
            }),
          ]),
        }),
      ],
    });
    const departed = await reopened.sync({
      action: "subscribe",
      storeId: meta.storeId,
      lastSyncId: meta.lastSyncId,
      projects: [a.id],
      waitMs: 0,
      limit: 100,
    });
    expect(departed).toMatchObject({
      outcome: "deltas",
      commits: [
        expect.objectContaining({
          deltas: expect.arrayContaining([
            expect.objectContaining({ modelId: issue.id, projectIds: [b.id], previousProjectIds: [a.id] }),
          ]),
        }),
      ],
    });
    const reset = await reopened.sync({
      action: "subscribe",
      storeId: "wrong-store",
      lastSyncId: 0,
      projects: [b.id],
      waitMs: 0,
      limit: 100,
    });
    expect(reset).toMatchObject({ outcome: "rebootstrap", reason: "store_changed" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("keeps stage and completion gates on every operation inside an atomic transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-gates-"));
  try {
    const tracker = createLocalTracker({ directory: root });
    const created = await tracker.sync({
      action: "transaction",
      idempotencyKey: "create-with-ack",
      operations: [{ name: "save_issue", arguments: { team: "LOCAL", title: "Accepted" } }],
    });
    if (created.outcome !== "applied") throw new Error("Creation required");
    const issue = (created.result as { results: { id: string }[] }).results[0]!;
    await tracker.sync({
      action: "transaction",
      idempotencyKey: "ack",
      operations: [{ name: "post_issue_event", arguments: { issueId: issue.id, type: "ack" } }],
    });
    expect(await tracker.call("get_issue", { id: issue.id })).toMatchObject({ stage: "accepted" });
    // A later operation cannot hide an invalid intermediate completed creation.
    await expect(
      tracker.sync({
        action: "transaction",
        idempotencyKey: "hidden-invalid",
        operations: [
          {
            name: "save_issue",
            arguments: { team: "LOCAL", title: "Invalid completed creation", state: "Done" },
          },
          { name: "save_issue", arguments: { team: "LOCAL", title: "Unrelated valid creation" } },
        ],
      }),
    ).rejects.toThrow("evidence_bundle_required");
    const items = (await tracker.call("list_issues", {})) as { issues: { id: string }[] };
    expect(items.issues.map((entry) => entry.id)).toEqual([issue.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("cannot combine doing the work and independently checking its bundle in one transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "sync-bundle-fence-"));
  const evidence = trackerEvidence(root);
  try {
    const tracker = createLocalTracker({ directory: root, validateEvidence: evidence.validateEvidence });
    const issue = (await tracker.call("save_issue", { title: "Independent check", team: "LOCAL" })) as {
      id: string;
      identifier: string;
    };
    const reference = await evidence.record(issue.identifier);
    const bundle = (await tracker.call(
      "save_evidence_bundle",
      { issueId: issue.id, references: [reference], gaps: [] },
      { actor: { type: "agent-worker", id: "publisher", onBehalfOf: [] } },
    )) as { id: string };
    await expect(
      tracker.sync(
        {
          action: "transaction",
          idempotencyKey: "self-check-in-transaction",
          operations: [
            {
              name: "post_issue_event",
              arguments: { issueId: issue.id, type: "action", body: "Did the work" },
            },
            { name: "post_bundle_check", arguments: { bundleId: bundle.id } },
          ],
        },
        { actor: { type: "agent-worker", id: "checker", onBehalfOf: [] } },
      ),
    ).rejects.toThrow("bundle_self_check");
    expect(await tracker.call("get_evidence_bundle", { issueId: issue.id })).not.toHaveProperty("checked");
    const stream = (await tracker.call("list_issue_events", { issueId: issue.id })) as {
      events: { type: string }[];
    };
    expect(stream.events.some((event) => event.type === "action")).toBe(false);
  } finally {
    evidence.store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("expands wildcard groups and discovers a new project through workspace before bootstrapping its UUID", async () => {
  const f = await syncFixture();
  try {
    const first = (await f.tracker.call("save_project", { name: "First", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const canceled = (await f.tracker.call("save_project", {
      name: "Canceled project",
      addTeams: ["LOCAL"],
    })) as { id: string };
    await f.tracker.call("save_project", { id: canceled.id, state: "Canceled" });
    await f.tracker.call("save_issue", { title: "Unprojected", team: "LOCAL" });
    const client = await f.pair("Discovery");
    const parse = (ndjson: string) =>
      ndjson
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    const full = parse(
      (
        await f.sync(client.deviceToken, {
          action: "bootstrap",
          type: "full",
          projects: ["*"],
          lazy: false,
        })
      ).ndjson,
    );
    const meta = full.pop();
    expect(meta.syncGroups).toEqual([first.id, canceled.id, "unprojected", "workspace"]);
    expect(meta.modelCount).toBe(full.length);
    expect(full.filter((model) => model.modelName === "project").map((model) => model.modelId)).toEqual([
      first.id,
      canceled.id,
    ]);
    expect(full.some((model) => model.data.title === "Unprojected")).toBe(true);
    const created = (await f.tracker.call("save_project", { name: "New", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    await f.tracker.call("save_issue", {
      title: "New project item",
      team: "LOCAL",
      project: created.id,
      cycle: "current",
    });
    const subscription = {
      action: "subscribe" as const,
      projects: ["workspace"],
      storeId: meta.storeId,
      lastSyncId: meta.lastSyncId,
      waitMs: 0,
      limit: 100,
    };
    const discovered = await f.sync(client.deviceToken, subscription);
    const deltas = discovered.commits.flatMap((commit: any) => commit.deltas);
    expect(deltas).toContainEqual(
      expect.objectContaining({
        modelName: "project",
        modelId: created.id,
        action: "insert",
        projectIds: [created.id, "workspace"],
        data: expect.objectContaining({ name: "New" }),
      }),
    );
    expect(deltas.some((delta: any) => delta.modelName === "issue")).toBe(false);
    expect(deltas).toContainEqual(
      expect.objectContaining({
        modelName: "cycle",
        projectIds: [created.id, "workspace"],
      }),
    );
    // Even a client naming only its old project remains subscribed to discovery.
    expect((await f.sync(client.deviceToken, { ...subscription, projects: [first.id] })).commits).toEqual(
      discovered.commits,
    );
    const partial = parse(
      (
        await f.sync(client.deviceToken, {
          action: "bootstrap",
          type: "partial",
          projects: [created.id],
          lazy: false,
        })
      ).ndjson,
    );
    const partialMeta = partial.pop();
    expect(partialMeta.syncGroups).toEqual([created.id]);
    expect(partial.filter((model) => model.modelName === "project").map((model) => model.modelId)).toEqual([
      created.id,
    ]);
    expect(partial.filter((model) => model.modelName === "issue").map((model) => model.data.title)).toEqual([
      "New project item",
    ]);
    const newIssue = partial.find((model) => model.modelName === "issue");
    await f.tracker.call("save_issue", { id: newIssue.modelId, title: "Subscribed new project" });
    const expanded = await f.sync(client.deviceToken, {
      ...subscription,
      projects: [first.id, created.id, "workspace"],
      lastSyncId: partialMeta.lastSyncId,
    });
    expect(expanded.commits.flatMap((commit: any) => commit.deltas)).toContainEqual(
      expect.objectContaining({
        modelName: "issue",
        modelId: newIssue.modelId,
        data: expect.objectContaining({ title: "Subscribed new project" }),
      }),
    );
    await f.tracker.call("save_project", { id: created.id, name: "Renamed", state: "Canceled" });
    const renamed = await f.sync(client.deviceToken, { ...subscription, lastSyncId: partialMeta.lastSyncId });
    expect(renamed.commits.flatMap((commit: any) => commit.deltas)).toContainEqual(
      expect.objectContaining({
        modelName: "project",
        modelId: created.id,
        data: expect.objectContaining({ name: "Renamed", statusId: expect.any(String) }),
      }),
    );
    await expect(
      f.tracker.sync({ action: "bootstrap", type: "partial", projects: ["Renamed"], lazy: false }),
    ).rejects.toThrow("Sync project UUID not found");
  } finally {
    await f.close();
  }
}, 30_000);
