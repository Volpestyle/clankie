import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createGuidedReviewSourceAuthorizer } from "../src/guided-review-source.ts";
import { SettingsStore } from "@clankie/settings";
import {
  createLocalTracker,
  readReviewPatch,
  TRACKER_OWNER,
  type GuidedReviewMutationReceipt,
} from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { linearMcp } from "../src/linear-mcp.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

import type { GuidedReviewRecord } from "../../../packages/work-items/src/tracker-local.ts";
import { createWorkItemsService } from "../src/work-items.ts";

it("attributes guided review edits to the authenticated worker and preserves owner verification authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-runs-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const now = "2026-10-05T09:00:00.000Z";
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace });
  const authorizeGuidedReviewSource = createGuidedReviewSourceAuthorizer({
    projects: async () => (await settings.load()).projects,
    localMachineId: "local",
  });
  const tracker = createLocalTracker({
    authorizeGuidedReviewSource,
    directory: join(root, "tracker"),
    clock: () => new Date(now),
  });
  let workItems!: ReturnType<typeof createWorkItemsService>;
  const host = createMcpHost({
    trackerMcp: linearMcp,
    credentials,
    settings,
    localTracker: tracker,
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        args: [],
        lane: "everywhere",
        initialTools: [],
        enabled: true,
      },
    ],
    trackerForRepo: ({ name, args, repo, local, ...publication }) =>
      workItems.callTracker(name, args, { repo, local, ...publication }),
    trackerRepoForCall: (name, args) => workItems.resolveTrackerRepo(name, args),
    logger: { info() {}, warn() {} },
  });
  workItems = createWorkItemsService({
    stateDirectory: join(root, "work"),
    globalTrackerDirectory: join(root, "tracker"),
    workspace: () => workspace,
    mcpHost: host,
    projects: async () => (await settings.load()).projects,
  });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const app = await createClankieApp({
    captain: createStubCaptain({}),
    workerMcp: worker,
    workItems,
    builtInTracker: tracker,
    fleetLinks: {
      identity: () => undefined,
      authenticate: (token) => (token === "local-fleet-test" ? "test-fleet" : undefined),
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer tracker-owner" ? { operatorId: "owner" } : undefined,
  });
  let sequence = 0;
  let session: string | undefined;
  const rpc = (method: string, params: unknown) =>
    app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  session = (
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "tracker-runs-integration", version: "1" },
    })
  ).headers.get("mcp-session-id")!;
  const raw = async (name: string, args: Record<string, unknown>) => {
    const response = await rpc("tools/call", { name: "clankie_call", arguments: { name, arguments: args } });
    const result = (await response.json()).result as { content: { text: string }[] };
    return JSON.parse(result.content[0]!.text) as { outcome: string; content?: string; detail?: string };
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await raw(name, args);
    expect(reply, JSON.stringify(reply)).toMatchObject({ outcome: "ok" });
    return JSON.parse(reply.content!);
  };
  const owner = async (name: string, args: Record<string, unknown>) => {
    const response = await app.app.request("/v1/tracker/owner/call", {
      method: "POST",
      headers: { authorization: "Bearer tracker-owner", "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.result;
  };

  try {
    const project = await owner("save_project", { name: "Clankie Work", addTeams: ["LOCAL"] });
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "worker-review",
            name: "Clankie Work",
            trackerProjectId: project.id,
            workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
          },
        ],
      }),
    }));
    const issue = await owner("save_issue", { team: "LOCAL", project: project.id, title: "Worker review" });
    const runResult = await call("linear_save_run", { issueId: issue.id });
    // Native writes return concise receipts; re-read through the same authenticated route.
    const run = (await call("linear_list_runs", { issueId: issue.id })).runs.find(
      (entry: { id: string }) => entry.id === runResult.id,
    );
    expect(run).toMatchObject({ actor: { type: "agent-worker" } });
    expect(run.actor.id).not.toBe("owner");
    const path = join(workspace, "change.patch");
    await writeFile(
      path,
      "diff --git a/example.txt b/example.txt\nindex df967b9..3e75765 100644\n--- a/example.txt\n+++ b/example.txt\n@@ -1 +1 @@\n-before\n+after\n",
    );
    const patch = await readReviewPatch({ path });
    const expectedSource = { kind: "patch", sha256: patch.patch.sha256 };
    const input = {
      issueId: issue.id,
      runId: run.id,
      source: { kind: "patch", path },
      expectedSource,
      walkthrough: [{ title: "Replacement", body: "Review changed content", fileIndex: 0 }],
      findings: [
        { body: "Clarify replacement", severity: "warning", anchor: { fileIndex: 0, side: "new", line: 1 } },
      ],
      idempotencyKey: "worker-review",
    };
    const receipt = (await call("linear_save_guided_review", input)) as GuidedReviewMutationReceipt;
    expect(receipt).toMatchObject({
      reviewId: expect.any(String),
      actor: run.actor,
      identity: expectedSource,
      operation: "save",
    });
    expect(await call("linear_save_guided_review", input)).toEqual(receipt);
    const savedWrite = await call("linear_get_write_receipt", { idempotencyKey: input.idempotencyKey });
    expect(savedWrite).toMatchObject({ state: "applied", tool: "save_guided_review" });
    expect(savedWrite.result).toEqual(receipt);
    const saved = (await call("linear_get_guided_review", {
      issueId: issue.id,
      id: receipt.reviewId,
    })) as GuidedReviewRecord;
    expect(saved.runId).toBe(run.id);
    expect(saved.createdByActor).toEqual(run.actor);
    expect(receipt).toEqual({
      schemaVersion: 1,
      reviewId: saved.id,
      storeId: saved.storeId,
      issueId: issue.id,
      projectId: project.id,
      identity: expectedSource,
      snapshotSha256: saved.snapshotSha256,
      operation: "save",
      eventId: null,
      updatedAt: saved.updatedAt,
      actor: run.actor,
    });
    let current = saved;
    for (const [index, edit] of [
      { action: "reply", body: "Worker explanation" },
      { action: "resolve", resolved: true },
    ].entries()) {
      const editReceipt = await call("linear_post_guided_finding", {
        issueId: issue.id,
        id: saved.id,
        findingId: saved.findings[0]!.id,
        expectedSource,
        edit,
        ifUpdatedAt: current.updatedAt,
        idempotencyKey: `worker-edit-${index}`,
      });
      const editWrite = await call("linear_get_write_receipt", { idempotencyKey: `worker-edit-${index}` });
      expect(editWrite).toMatchObject({ state: "applied", tool: "post_guided_finding" });
      expect(editWrite.result).toEqual(editReceipt);
      current = (await call("linear_get_guided_review", {
        issueId: issue.id,
        id: saved.id,
      })) as GuidedReviewRecord;
      expect(editReceipt).toEqual({
        schemaVersion: 1,
        reviewId: saved.id,
        storeId: saved.storeId,
        issueId: issue.id,
        projectId: project.id,
        identity: expectedSource,
        snapshotSha256: saved.snapshotSha256,
        operation: edit.action,
        eventId: current.findings[0]!.history.at(-1)!.id,
        updatedAt: current.updatedAt,
        actor: run.actor,
      });
    }
    expect(current.findings[0]!.resolved).toBe(true);
    expect(current.findings[0]!.history).toHaveLength(2);
    for (const event of current.findings[0]!.history) {
      expect(event.actor).toEqual(run.actor);
      expect(event.actor.type).toBe("agent-worker");
      expect(event.actor.id).not.toBe("owner");
    }
    expect(current.findings[0]!.replies[0]!.actor).toEqual(run.actor);
    const persisted = JSON.parse(await readFile(join(root, "tracker/tracker.json"), "utf8"));
    expect(persisted.runs.find((entry: { id: string }) => entry.id === run.id).actor).toEqual(run.actor);
    const before = await readFile(join(root, "tracker/tracker.json"));
    const unauthenticated = await app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 999,
        method: "tools/call",
        params: {
          name: "clankie_call",
          arguments: { name: "linear_post_guided_finding", arguments: { issueId: issue.id, id: saved.id } },
        },
      }),
    });
    expect(unauthenticated.status).toBe(401);
    const verifying = await raw("linear_post_issue_event", {
      issueId: issue.id,
      type: "result",
      stage: "owner-verified",
    });
    // Only the owner verifies: a worker's host profile refuses it before the tracker (LOCAL-VUH-45).
    expect(verifying).toMatchObject({ outcome: "refused", reason: "role_not_allowed", role: "worker" });
    for (const options of [
      undefined,
      { actor: { type: "external" as const, id: "untrusted", onBehalfOf: [] } },
    ]) {
      await expect(
        tracker.call(
          "post_guided_finding",
          {
            issueId: issue.id,
            id: saved.id,
            findingId: saved.findings[0]!.id,
            expectedSource,
            edit: { action: "resolve", resolved: false },
            ifUpdatedAt: current.updatedAt,
            idempotencyKey: "untrusted-edit",
          },
          options,
        ),
      ).rejects.toThrow("authenticated host actor");
    }
    const domain = (bytes: Buffer) => {
      const store = JSON.parse(bytes.toString());
      return { guidedReviews: store.guidedReviews, issues: store.issues, runs: store.runs };
    };
    expect(domain(await readFile(join(root, "tracker/tracker.json")))).toEqual(domain(before));
    const ownerRun = (await tracker.call(
      "save_run",
      { issueId: issue.id },
      { actor: { ...TRACKER_OWNER, onBehalfOf: [] } },
    )) as { id: string };
    const beforeWrongRun = await readFile(join(root, "tracker/tracker.json"));
    const wrongRun = await raw("linear_save_guided_review", {
      ...input,
      runId: ownerRun.id,
      idempotencyKey: "wrong-run",
    });
    expect(wrongRun.outcome).not.toBe("ok");
    expect(wrongRun.detail).toContain("caller");
    expect(domain(await readFile(join(root, "tracker/tracker.json")))).toEqual(domain(beforeWrongRun));
    expect(await call("linear_get_guided_review", { issueId: issue.id, id: saved.id })).toEqual(current);
    const evidenceDirectory = process.env.GUIDED_REVIEW_EVIDENCE_DIRECTORY;
    if (evidenceDirectory) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(
        join(evidenceDirectory, "worker-journey.json"),
        JSON.stringify(
          {
            publicPath: "authenticated /v1/fleet/mcp -> WorkerMcp -> McpHost -> production tracker store",
            run,
            review: current,
            ownerVerificationRefusal: verifying,
            wrongRunRefusal: wrongRun,
            persisted: JSON.parse(await readFile(join(root, "tracker/tracker.json"), "utf8")),
            assertions: [
              "authenticated worker saved and edited",
              "actor remains agent-worker with owner/lead attribution chain",
              "worker owner-verification refused",
              "unauthenticated native route 401",
              "missing/external actors refused",
              "another runner refused",
              "review issue run domains unchanged by refusals",
            ],
          },
          null,
          2,
        ),
      );
    }
  } finally {
    await app.close();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
