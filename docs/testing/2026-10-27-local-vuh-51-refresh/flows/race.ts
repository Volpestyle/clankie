import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLocalTracker } from "../../../../packages/work-items/src/index.ts";
import { trackerEvidence } from "../../../../apps/clankie/test/helpers/tracker-evidence.ts";

const root = process.argv[2]!;
assert.ok(process.env.HOME?.startsWith(root));
const directory = join(root, "tracker");
const evidence = trackerEvidence(root);
let enterValidation!: () => void, releaseValidation!: () => void;
const validating = new Promise<void>((resolve) => {
  enterValidation = resolve;
});
const validation = new Promise<void>((resolve) => {
  releaseValidation = resolve;
});
const writer = createLocalTracker({
  directory,
  validateEvidence: async (issue, refs) => {
    await evidence.validateEvidence(issue, refs);
    enterValidation();
    await validation;
  },
});
try {
  const project: any = await writer.call("save_project", { name: "Initial", addTeams: ["LOCAL"] });
  let issue: any;
  for (let n = 0; !fs.existsSync(join(directory, "tracker.journal")); n++)
    issue = await writer.call("save_issue", {
      team: "LOCAL",
      project: project.id,
      title: "journal " + n,
      description: "x".repeat(300 * 1024),
    });
  await writer.checkpoint();
  const reference = await evidence.record(issue.identifier);
  const reader = createLocalTracker({ directory });
  await reader.referenceProjects([project.id]);
  const source = new URL("../../../../packages/work-items/src/index.ts", import.meta.url).href;
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {createLocalTracker}=await import(${JSON.stringify(source)}); await createLocalTracker({directory:${JSON.stringify(directory)}}).call('save_project',${JSON.stringify({ id: project.id, name: "External" })});`,
    ],
    { env: process.env },
  );

  const checkpoint = join(directory, "tracker.json");
  const live = join(
    directory,
    "tracker.journal",
    fs
      .readdirSync(join(directory, "tracker.journal"))
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .at(-1)!,
  );
  const originalRead = fs.promises.readFile;
  let checkpointReads = 0,
    held = false;
  let entered!: () => void, release!: () => void;
  const captured = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise<void>((resolve) => {
    release = resolve;
  });
  fs.promises.readFile = (async (...args: Parameters<typeof originalRead>) => {
    if (String(args[0]) === checkpoint) checkpointReads++;
    const bytes = await originalRead(...args);
    if (String(args[0]) === live && !held) {
      held = true;
      entered();
      await proceed; // Hold actual external journal bytes, not a fabricated snapshot.
    }
    return bytes;
  }) as typeof originalRead;
  syncBuiltinESMExports();
  try {
    const refreshing = reader.referenceProjects(["Local"]);
    await captured;
    await writer.call("save_project", { id: project.id, name: "Local" });
    const saving = writer
      .call("save_evidence_bundle", { issueId: issue.id, references: [reference], gaps: [] })
      .then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error: String(error) }),
      );
    await validating; // Its draft includes the local commit; it has not reached appendCommit.
    const readsBeforeRelease = checkpointReads;
    release();
    const owners = await refreshing;
    releaseValidation();
    const saved = await saving;
    await reader.referenceProjects(["Local"]);
    const rereads = checkpointReads - readsBeforeRelease;
    const result = {
      externalValidated: readsBeforeRelease === 2,
      localSnapshotRetained: owners.get("local")?.has(project.id) === true,
      spuriousRefusal: saved.error ?? null,
      rereads,
    };
    console.log(JSON.stringify(result));
    assert.equal(saved.error, undefined, "a delayed refresh must not cause a spurious journal refusal");
    assert.equal(result.localSnapshotRetained, true, "refresh returns the newer local snapshot");
    assert.equal(rereads, 0, "the next read reuses the local commit without rereading");
    assert.equal(result.externalValidated, true);
    assert.ok(((await writer.call("get_evidence_bundle", { issueId: issue.id })) as any).id);
  } finally {
    fs.promises.readFile = originalRead;
    syncBuiltinESMExports();
  }
} finally {
  evidence.store.close();
}
