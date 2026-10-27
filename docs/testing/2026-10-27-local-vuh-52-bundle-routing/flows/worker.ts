import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "../../2026-10-27-local-vuh-46-peak-day/flows/fixture.ts";
import { trackerEvidence } from "../../../../apps/clankie/test/helpers/tracker-evidence.ts";
import { SettingsStore } from "../../../../packages/settings/src/index.ts";
import { FileCredentialStore } from "../../../../packages/credential-broker/src/index.ts";
import { writeConvention, TRACKER_LEAD } from "../../../../packages/work-items/src/index.ts";

const root = process.argv[2]!;
const f = await fixture(root, join(root, "tracker"), (backend) => backend);
const evidence = trackerEvidence(root);
const actor = { ...TRACKER_LEAD, onBehalfOf: [] };
const settings = new SettingsStore(join(root, "settings.json"));
try {
  // A hire in a Linear project must route solely from opaque ids in another cut-over project.
  const workspace = join(root, "cutover");
  await fs.promises.mkdir(workspace);
  await writeConvention(workspace, {
    schemaVersion: 1,
    backend: "builtin",
    decidedBy: "owner",
    decidedAt: new Date().toISOString(),
  });
  const project = await f.tracker.call("save_project", { name: "Cut-over", addTeams: [f.team] }, { actor });
  await settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: [
        ...current.projects.projects,
        {
          id: "cutover",
          name: "Cut-over",
          trackerProjectId: project.id,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
        },
      ],
    },
  }));
  await writeConvention(join(root, "x"), {
    schemaVersion: 1,
    backend: "linear",
    linear: { team: "LOCAL", project: "Project X" },
    decidedBy: "owner",
    decidedAt: new Date().toISOString(),
  });
  await new FileCredentialStore(join(root, "credentials.json")).set("linear", {
    type: "api",
    key: "fixture-only",
    account: {
      provider: "linear",
      actor: "app",
      connectionId: randomUUID(),
      userId: randomUUID(),
      workspaceId: randomUUID(),
      name: "Fixture",
      workspaceName: "Fixture",
      verifiedAt: new Date().toISOString(),
    },
  });
  assert.equal((await f.host.trackerStatus!()).backend, "linear");
  await f.hire("reviewer", "reviewer");
  await f.hire("worker", "builder");
  const issue = await f.tracker.call(
    "save_issue",
    { team: f.team, project: project.id, title: "Independent check" },
    { actor },
  );
  const reference = await evidence.record(issue.identifier as string);
  const publish = () =>
    f.tracker.call(
      "save_evidence_bundle",
      { issueId: issue.id, references: [reference], gaps: [] },
      { actor },
    );
  const bundle = await publish();
  await f.tracker.call("save_issue", { id: issue.id, cycle: "current" }, { actor });
  let sequence = 0;
  const sessions = new Map<string, string>();
  const rpc = (pane: string, method: string, params: unknown) =>
    f.app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-test-local-pane": pane,
        ...(sessions.has(pane) ? { "mcp-session-id": sessions.get(pane)! } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  const call = async (pane: string, name: string, args: Record<string, unknown>) => {
    if (!sessions.has(pane))
      sessions.set(
        pane,
        (
          await rpc(pane, "initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "bundle-routing-proof", version: "1" },
          })
        ).headers.get("mcp-session-id")!,
      );
    const response = await rpc(pane, "tools/call", {
      name: "clankie_call",
      arguments: { name: `linear_${name}`, arguments: args },
    });
    const body = await response.json();
    return JSON.parse(body.result.content[0].text);
  };
  const checkpoint = join(root, "tracker/tracker.json");
  const originalRead = fs.promises.readFile;
  let checkpointReads = 0;
  fs.promises.readFile = ((...args: Parameters<typeof originalRead>) => {
    if (String(args[0]) === checkpoint) checkpointReads++;
    return originalRead(...args);
  }) as typeof originalRead;
  syncBuiltinESMExports();
  const results: Record<string, unknown> = {};
  try {
    results.check = await call("reviewer", "post_bundle_check", {
      bundleId: bundle.id,
      body: "Independent worker MCP check",
      idempotencyKey: "first-check",
    });
    assert.equal((results.check as any).outcome, "ok", JSON.stringify(results.check));
    const checked = (await f.tracker.call("get_evidence_bundle", { issueId: issue.id }, { actor })) as any;
    assert.equal(checked.checked.actor.id, "fleet:default:pane:reviewer");
    const events = (await f.tracker.call("list_issue_events", { issueId: issue.id }, { actor })) as any;
    assert.ok(
      events.events.some(
        (event: any) =>
          event.type === "bundle_checked" &&
          event.actor.id === checked.checked.actor.id &&
          event.bundleId === bundle.id,
      ),
    );
    results.checked = checked;
    const cycles = (await f.tracker.call("list_cycles", { project: project.id })) as any;
    const cycle = cycles.cycles[0];
    assert.ok(cycle?.id);
    results.cycle = await call("reviewer", "get_cycle", { id: cycle.id });
    assert.equal((results.cycle as any).outcome, "ok", JSON.stringify(results.cycle));
    assert.equal(JSON.parse((results.cycle as any).content).id, cycle.id);

    results.unknown = await call("reviewer", "post_bundle_check", {
      bundleId: randomUUID(),
      idempotencyKey: "unknown-bundle",
    });
    assert.equal((results.unknown as any).outcome, "refused");
    assert.equal((results.unknown as any).possiblyDispatched, false);
    assert.match((results.unknown as any).detail, /matched no cut-over project's record/);
    const later = await publish();
    results.appended = await call("worker", "post_bundle_check", {
      bundleId: later.id,
      idempotencyKey: "appended",
    });
    assert.equal((results.appended as any).outcome, "ok", JSON.stringify(results.appended));
    const own = await call("worker", "save_evidence_bundle", {
      issueId: issue.id,
      references: [reference],
      gaps: [],
      idempotencyKey: "own-bundle",
    });
    assert.equal(own.outcome, "ok", JSON.stringify(own));
    const ownBundle = (await f.tracker.call("get_evidence_bundle", { issueId: issue.id }, { actor })) as any;
    results.selfCheck = await call("worker", "post_bundle_check", {
      bundleId: ownBundle.id,
      idempotencyKey: "self-check",
    });
    assert.equal((results.selfCheck as any).outcome, "refused");
    assert.match((results.selfCheck as any).detail, /independent|own|self/i);
    const run = await call("worker", "save_run", { issueId: issue.id, idempotencyKey: "start-run" });
    assert.equal(run.outcome, "ok", JSON.stringify(run));
    const runId = JSON.parse(run.content).id;
    results.runControl = await call("worker", "post_run_control", { runId, action: "pause" });
    assert.equal((results.runControl as any).reason, "role_not_allowed");
    results.leadRunControl = await f.host.call({
      lane: "operator",
      server: "linear",
      tool: "post_run_control",
      arguments: { runId, action: "steer", body: "Routed by run id", idempotencyKey: "lead-steer" },
    });
    assert.equal((results.leadRunControl as any).outcome, "ok", JSON.stringify(results.leadRunControl));
    results.finishRun = await call("worker", "save_run", {
      id: runId,
      status: "succeeded",
      idempotencyKey: "finish-run",
    });
    assert.equal((results.finishRun as any).outcome, "ok", JSON.stringify(results.finishRun));
    // The same real hire on its own cut-over project also checks; unknown ids
    // reach that built-in destination and refuse with its normal not-found error.
    await writeConvention(join(root, "x"), {
      schemaVersion: 1,
      backend: "builtin",
      decidedBy: "owner",
      decidedAt: new Date().toISOString(),
    });
    const localIssue = await f.tracker.call(
      "save_issue",
      { team: f.team, project: f.project.id, title: "Hired cut-over project" },
      { actor },
    );
    const localBundle = await f.tracker.call(
      "save_evidence_bundle",
      { issueId: localIssue.id, references: [reference], gaps: [] },
      { actor },
    );
    results.hiredProjectCheck = await call("reviewer", "post_bundle_check", {
      bundleId: localBundle.id,
      idempotencyKey: "hired-project-check",
    });
    assert.equal((results.hiredProjectCheck as any).outcome, "ok", JSON.stringify(results.hiredProjectCheck));
    results.hiredProjectUnknown = await call("reviewer", "post_bundle_check", {
      bundleId: randomUUID(),
      idempotencyKey: "hired-project-unknown",
    });
    assert.equal((results.hiredProjectUnknown as any).outcome, "refused");
    assert.match((results.hiredProjectUnknown as any).detail, /Bundle not found/);
    assert.equal(checkpointReads, 0, "same-process opaque-id routing must not reread the checkpoint");
    results.checkpointReads = checkpointReads;
  } finally {
    fs.promises.readFile = originalRead;
    syncBuiltinESMExports();
  }
  console.log(JSON.stringify(results));
} finally {
  await f.close();
  await f.host.close();
  evidence.store.close();
}
