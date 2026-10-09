import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DONE,
  issuePayload,
  linearMirrorFixture,
  OPERATOR,
  OWNER_ID,
} from "../test/helpers/linear-mirror.ts";

// Manual scratch proof (VUH-1965): a disposable service over real HTTP, configured with
// the real `clankie work mirror` CLI, fed signed webhooks. Never the live service or Linear.
const run = promisify(execFile);
const repo = fileURLToPath(new URL("../../..", import.meta.url));
const f = await linearMirrorFixture();
const cli = async (action: string) => {
  const { stdout } = await run(
    `${repo}apps/tui/node_modules/.bin/tsx`,
    ["bin/clankie.ts", "work", "mirror", "linear", "--scratch", "work", "--project", f.projectId, action],
    {
      cwd: `${repo}apps/tui`,
      env: { ...process.env, CLANKIE_CONTROL_PLANE_URL: f.endpoint, CLANKIE_OPERATOR_TOKEN: OPERATOR },
    },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
};
try {
  const enabled = await cli("enable");
  assert.equal(enabled.enabled, true);
  const boot = await f.scratch.sync({ action: "bootstrap", type: "full", projects: ["*"], lazy: false });
  if (boot.outcome !== "bootstrap") throw new Error("Expected bootstrap");
  const meta = JSON.parse(boot.ndjson.trim().split("\n").at(-1)!);
  const issue = f.source.issues.find((entry) => entry.identifier === "VUH-1905")!;
  const waiting = f.scratch.sync({
    action: "subscribe",
    projects: [f.projectId],
    storeId: meta.storeId,
    lastSyncId: meta.lastSyncId,
    waitMs: 10_000,
    limit: 100,
  });
  const started = Date.now();
  const comment = f.envelope("Comment", "create", {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    body: "Scratch round trip comment from Linear.",
    issueId: issue.id,
    userId: OWNER_ID,
    user: { id: OWNER_ID, name: "James Volpe" },
    issue: { id: issue.id, identifier: issue.identifier, title: issue.title },
  });
  assert.deepEqual(await (await f.post(comment, "Comment")).json(), { schemaVersion: 1, ingested: true });
  const live = await waiting;
  if (live.outcome !== "deltas") throw new Error("Expected pushed deltas");
  const latencyMs = Date.now() - started;
  const state = f.envelope("Issue", "update", issuePayload(issue, { stateId: DONE.id, state: DONE }), {
    updatedFrom: { stateId: (issue.state as { id: string }).id },
  });
  await f.post(state, "Issue");
  await f.mirrors.idle();
  const settled = await f.store();
  await f.post(comment, "Comment");
  await f.post(state, "Issue");
  await f.mirrors.idle();
  assert.equal(await f.store(), settled);
  const refused = await f.scratch
    .call("save_comment", { issueId: issue.id, body: "Local write" })
    .then(() => "applied")
    .catch((error: Error) => error.message);
  assert.match(refused, /mirror_read_only/u);
  const status = await cli("status");
  const events = (JSON.parse(settled).events as { type: string; via?: string; actor: unknown }[]).filter(
    (event) => event.via === "linear_mirror",
  );
  console.log(
    JSON.stringify(
      {
        outcome: "passed",
        method: "disposable service over HTTP, real CLI, signed webhook fixtures, captured import",
        cliEnable: enabled,
        pushedCommit: live.commits.at(-1)?.tool,
        pushLatencyMs: latencyMs,
        mirroredItemEvents: events.map(({ type, actor }) => ({ type, actor })),
        replayByteIdentical: true,
        builtInWrite: refused,
        cliStatus: status,
      },
      null,
      2,
    ),
  );
} finally {
  await f.close();
}
