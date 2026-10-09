import assert from "node:assert/strict";
import { syncFixture } from "../test/helpers/tracker-sync.ts";

// Manual scratch proof: disposable real host/relay, two independently paired HTTP clients.
const f = await syncFixture();
const streams: Awaited<ReturnType<typeof f.stream>>[] = [];
try {
  const project = (await f.tracker.call("save_project", { name: "Scratch Sync", addTeams: ["LOCAL"] })) as {
    id: string;
  };
  const [a, b] = await Promise.all([f.pair("Scratch A"), f.pair("Scratch B")]);
  const boot = await f.sync(a.deviceToken, {
    action: "bootstrap",
    type: "full",
    projects: [project.id],
    lazy: true,
  });
  const metadata = JSON.parse(boot.ndjson.trim().split("\n").at(-1)!);
  const command = {
    action: "subscribe" as const,
    projects: [project.id],
    storeId: metadata.storeId,
    lastSyncId: metadata.lastSyncId,
    waitMs: 0,
    limit: 100,
  };
  const liveA = await f.stream(a.deviceToken, command);
  streams.push(liveA);
  const liveB = await f.stream(b.deviceToken, command);
  streams.push(liveB);
  const first = {
    action: "transaction" as const,
    idempotencyKey: "scratch-a-create",
    operations: [
      { name: "save_issue", arguments: { team: "LOCAL", project: project.id, title: "Scratch A writes" } },
    ],
  };
  const applied = await f.sync(a.deviceToken, first);
  assert.equal(applied.outcome, "applied");
  const issue = applied.result.results[0];
  const [pageA, pageB] = await Promise.all([liveA.next(), liveB.next()]);
  assert.deepEqual(pageA, pageB);
  const replay = await f.sync(a.deviceToken, first);
  assert.deepEqual(replay.result, applied.result);
  liveB.close();
  const second = await f.sync(b.deviceToken, {
    action: "transaction",
    idempotencyKey: "scratch-b-edit",
    operations: [
      {
        name: "save_issue",
        arguments: { id: issue.id, title: "Scratch B writes", ifUpdatedAt: issue.updatedAt },
      },
    ],
  });
  assert.equal(second.outcome, "applied");
  const nextA = await liveA.next();
  const resumedB = await f.sync(b.deviceToken, { ...command, lastSyncId: pageB.lastSyncId });
  assert.deepEqual(resumedB.commits, nextA.commits);
  assert.ok(nextA.lastSyncId > pageA.lastSyncId);
  console.log(
    JSON.stringify(
      {
        outcome: "passed",
        method: "two paired HTTP clients over real local host and relay",
        storeId: metadata.storeId,
        bootstrap: metadata,
        first: pageA,
        second: nextA,
        replayReturnedOriginal: true,
        disconnectedClientResumed: true,
      },
      null,
      2,
    ),
  );
} finally {
  for (const stream of streams) stream.close();
  await f.close();
}
