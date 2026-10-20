// LOCAL-VUH-24: run against a NEW scratch-stack.mjs --broker-operator preset.
// Start its source service under clankie heavy --server first. No model, mock,
// owner answer, imported credential or live-tracker mutation is used here.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseEnv } from "node:util";
import { resolveOperatorCredential } from "../../packages/credential-broker/src/index.ts";

const root = resolve(process.argv[2]);
const phase = process.argv[3];
assert(["run", "setup", "reopen"].includes(phase), "Expected SCRATCH_ROOT run|setup|reopen");
const source = resolve(import.meta.dirname, "../..");
const preset = parseEnv(await readFile(join(root, "stack.env"), "utf8"));
assert(preset.CLANKIE_SCRATCH === "1" && !preset.CLANKIE_OPERATOR_TOKEN);
if (phase === "run") {
  // Keep the actual service and every CLI child inside one governed server lifetime.
  // Run with clankie heavy --server; this never targets the installed runtime.
  const start = () => {
    const child = spawn(
      process.execPath,
      [join(source, "scripts/scratch-stack.mjs"), "run", root, "clankie"],
      { cwd: source, stdio: "inherit" },
    );
    const exited = new Promise((done) => child.once("exit", done));
    return { child, exited };
  };
  let service;
  const stop = async () => {
    if (service && service.child.exitCode === null) {
      service.child.kill("SIGINT");
      await service.exited;
    }
  };
  const ready = async () => {
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        if ((await fetch(preset.CLANKIE_CAPTAIN_URL + "/health", { signal: AbortSignal.timeout(1000) })).ok)
          return;
      } catch {
        /* starting */
      }
      if (service.child.exitCode !== null) throw new Error("Private service exited during startup");
      await new Promise((done) => setTimeout(done, 200));
    }
    throw new Error("Private service startup timed out");
  };
  const exercise = (part) =>
    new Promise((done, fail) => {
      const child = spawn(process.execPath, [import.meta.filename, root, part], {
        cwd: source,
        stdio: "inherit",
      });
      child.once("error", fail);
      child.once("exit", (code) =>
        code === 0 ? done() : fail(new Error(`Public proof ${part} exited ${code}`)),
      );
    });
  try {
    service = start();
    await ready();
    await exercise("setup");
    await stop();
    console.log(JSON.stringify({ step: "private service stopped before reopen", result: true }));
    service = start();
    await ready();
    await exercise("reopen");
  } finally {
    await stop();
  }
  console.log(JSON.stringify({ step: "public proof complete; private service stopped", result: true }));
  process.exit(0);
}
const credential = await resolveOperatorCredential({ env: preset });
assert(credential, "Start the sterile service so its normal broker can initialize");
const host = preset.CLANKIE_CAPTAIN_URL;
assert(!["4310", "4321"].includes(new URL(host).port));
const report = (step, result) => console.log(JSON.stringify({ step, result }));
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function cli(...args) {
  const output = await new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(source, "apps/tui/bin/clankie.ts"), ...args], {
      cwd: source,
      env: { PATH: process.env.PATH, LANG: process.env.LANG, ...preset },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0
        ? done(JSON.parse(stdout))
        : fail(new Error(`CLI ${args[0]} ${args[1]} exited ${code}: ${stderr} ${stdout}`)),
    );
  });
  report(`CLI ${args[0]} ${args[1] ?? ""}`, output);
  return output;
}
async function api(path, body, token = credential.token, expected = 200, quiet = false) {
  const response = await fetch(host + path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!quiet) report(`HTTP ${path}`, { status: response.status, body: result });
  assert.equal(response.status, expected, JSON.stringify(result));
  return result;
}
const tool = async (name, args) =>
  (await cli("work", "call", name, "--repo", root, "--json", JSON.stringify(args))).result;
const scopeArgs = (scope) => ["--repo", root, "--project", scope.project, "--store-id", scope.storeId];
const list = async (scope, ...extra) =>
  (await cli("work", "inbox", "list", ...scopeArgs(scope), ...extra)).result;
const change = async (verb, scope, row, until) =>
  (
    await cli(
      "work",
      "inbox",
      verb,
      ...scopeArgs(scope),
      "--target",
      JSON.stringify(row.target),
      "--revision",
      String(row.expectedRevision),
      "--if-updated-at",
      row.updatedAt ?? "null",
      "--idempotency-key",
      `proof-${verb}-${Date.now()}`,
      ...(until === undefined ? [] : ["--until", until]),
    )
  ).result;
const raw = async (name, arguments_, scope, token, status = 200, repo = root) =>
  api("/v1/tracker/call", { repo, name, arguments: { ...scope, ...arguments_ } }, token, status);

if (phase === "setup") {
  await cli("auto", "off");
  await cli("model", "status");
  const initial = await cli("project", "list");
  assert.equal(initial.settings.projects.length, 0);
  const devices = await fetch(host + "/v1/devices", {
    headers: { authorization: `Bearer ${credential.token}` },
  }).then((r) => r.json());
  report("initial isolated devices", devices);
  const boundary = await cli("work", "status", "--repo", root);
  assert.equal(boundary.repo.root, root, "Run git init in the private scratch root before the proof");
  await cli(
    "project",
    "create",
    "inbox-proof",
    "--settings-json",
    JSON.stringify({
      name: "Inbox proof",
      workspacePath: root,
      trackerSetup: { backend: "builtin" },
      trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
    }),
    "--revision",
    initial.revision,
  );
  const teams = await tool("list_teams", {});
  const project = await tool("save_project", { name: "Inbox proof", addTeams: [teams.teams[0].id] });
  const settings = await cli("project", "list");
  await cli(
    "project",
    "update",
    "inbox-proof",
    "--changes-json",
    JSON.stringify({ trackerProjectId: project.id }),
    "--revision",
    settings.revision,
  );
  const batch = await cli(
    "work",
    "sync",
    "--repo",
    root,
    "--json",
    JSON.stringify({
      action: "batch",
      projects: [project.id],
      models: [{ modelName: "project", modelId: project.id }],
    }),
  );
  const scope = { project: project.id, storeId: batch.storeId };
  assert(scope.storeId);
  const issue = await tool("save_issue", {
    team: teams.teams[0].id,
    project: project.id,
    title: "Synthetic inbox decision",
  });
  await cli("work", "ask", issue.id, "--repo", root, "--body", "Synthetic isolated decision: keep pending.");
  let current;
  for (let attempt = 0; attempt < 30; attempt++) {
    current = await list(scope);
    if (current.rows.length) break;
    await delay(100);
  }
  assert.equal(current.rows.length, 1);
  let row = current.rows[0];
  const before = await tool("get_issue", { id: issue.id });
  const snoozed = await change("snooze", scope, row, new Date(Date.now() + 3600_000).toISOString());
  assert.equal(snoozed.attention, "snoozed");
  assert.equal((await list(scope)).rows.length, 0);
  assert.equal((await list(scope, "--attention", "snoozed")).rows[0].target.requestId, row.target.requestId);
  const after = await tool("get_issue", { id: issue.id });
  assert.deepEqual(after, before, "Snooze cannot change the issue, events, gate, delivery or owner ask");
  report("underlying issue unchanged", {
    issueId: issue.id,
    requestId: row.target.requestId,
    unchanged: true,
  });
  await raw(
    "get_inbox_item",
    { target: row.target },
    { ...scope, storeId: "wrong-store" },
    credential.token,
    422,
  );
  await raw("get_inbox_item", { target: row.target, actor: "owner" }, scope, credential.token, 422);
  const foreign = await tool("save_project", { name: "Foreign proof", addTeams: [teams.teams[0].id] });
  await raw(
    "get_inbox_item",
    { target: row.target },
    { ...scope, project: foreign.id },
    credential.token,
    422,
  );
  // Ordinary pairing/completion mints a genuine signed device; no synthetic auth callback.
  const pairingRunId = `inbox-proof-${Date.now()}`;
  try {
    const offer = await api(
      "/v1/pairing/offer",
      { run: { runId: pairingRunId, purpose: "proof", ttlSeconds: 900 } },
      credential.token,
      200,
      true,
    );
    const redeemed = await api(
      "/v1/pairing/redeem",
      {
        code: offer.localCode ?? offer.code,
        device: { name: "Synthetic inbox proof device", platform: "ios" },
      },
      "",
      200,
      true,
    );
    const device = await api(
      "/v1/pairing/complete",
      { completionToken: redeemed.completionToken, acceptedGrants: redeemed.offeredGrants },
      "",
      200,
      true,
    );
    const deviceToken = device.deviceToken ?? device.token;
    assert(deviceToken, "Pairing did not return a device token");
    const inventory = await api("/v1/work", { action: "repos" });
    const matches = inventory.repos.filter((entry) => entry.trackerProjectId === scope.project);
    assert.equal(matches.length, 1);
    const deviceRepo = matches[0].id;
    const privateRead = await raw("inbox_pending_questions", {}, scope, deviceToken, 200, deviceRepo);
    assert.equal(privateRead.result.rows[0].attention, "active");
    const refusedState = await raw(
      "post_unsnooze_inbox_item",
      {
        target: row.target,
        expectedRevision: row.expectedRevision,
        ifUpdatedAt: snoozed.updatedAt,
        idempotencyKey: "other-actor-cannot-edit",
      },
      scope,
      deviceToken,
      422,
      deviceRepo,
    );
    assert.match(refusedState.detail, /precondition_failed/);
    await api(`/v1/devices/${redeemed.deviceId}/revoke`, {}, credential.token);
    await raw("inbox_pending_questions", {}, scope, deviceToken, 401, deviceRepo);
    report("actor privacy and revoked device", {
      pairedViaPublicAPI: true,
      privateReadWasActive: true,
      otherActorUpdateRefused: true,
      revokedReadRefused: true,
    });
  } finally {
    await api(`/v1/pairing/runs/${pairingRunId}/end`, {}, credential.token);
  }
  const unsupported = join(root, "markdown");
  await mkdir(unsupported);
  execFileSync("git", ["init", "--quiet", unsupported]);
  await cli("work", "init", "--repo", unsupported, "--backend", "markdown", "--directory", "tasks");
  await api(
    "/v1/tracker/call",
    { repo: unsupported, name: "inbox_pending_questions", arguments: scope },
    credential.token,
    422,
  );
  // Preserve a durable snooze for the separately restarted service's reopen phase.
  await writeFile(
    join(root, "proof-state.json"),
    JSON.stringify({ scope, row, snoozed, issueId: issue.id }),
    { mode: 0o600 },
  );
  report("setup passed", { requestId: row.target.requestId, reopenRequired: true });
} else {
  const { scope, row, snoozed, issueId } = JSON.parse(await readFile(join(root, "proof-state.json"), "utf8"));
  assert.equal((await list(scope)).rows.length, 0);
  const persisted = await list(scope, "--attention", "all");
  assert.equal(persisted.rows[0].updatedAt, snoozed.updatedAt);
  const restored = await change("unsnooze", scope, persisted.rows[0]);
  assert.equal(restored.attention, "active");
  assert.equal((await list(scope)).rows.length, 1);
  await change("snooze", scope, restored, new Date(Date.now() + 5000).toISOString());
  await delay(5100);
  const expired = (await list(scope)).rows[0];
  assert.equal(expired.attention, "active");
  // Change current issue data through the real CLI, then cancel ONLY this disposable
  // synthetic question using the ordinary mailbox lifecycle (never an owner answer).
  await tool("save_issue", { id: issueId, title: "Current data after expiry" });
  const again = await change("snooze", scope, expired, new Date(Date.now() + 5000).toISOString());
  await cli(
    "conversations",
    "cancel-question",
    row.target.conversationId,
    row.target.requestId,
    "--incarnation",
    row.target.incarnationId,
    "--revision",
    String(row.expectedRevision),
  );
  await delay(5100);
  assert.equal((await list(scope, "--attention", "all")).rows.length, 0);
  await raw("get_inbox_item", { target: row.target }, scope, credential.token, 422);
  report("reopen and terminal expiry passed", {
    realServiceRestart: true,
    snoozePersisted: true,
    unsnoozeRestored: true,
    realClockExpiryRestored: true,
    cancelledQuestionNotRevived: true,
    lastSnooze: again.updatedAt,
  });
}
