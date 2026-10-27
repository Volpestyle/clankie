// LOCAL-VUH-51 review probe: can the CAS in readStore hand a locked writer an older snapshot
// than the one its own refresh read, so its append truncates an external acknowledged commit?
// Usage: tsx stale-base.ts <isolated scratch root> (scratch HOME/XDG required).
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = process.argv[2]!;
assert.ok(process.env.HOME?.startsWith(root));
const source = new URL("../../../../packages/work-items/src/index.ts", import.meta.url).href;
const { createLocalTracker } = await import(source);
const directory = join(root, "tracker");
const external = (args: Record<string, unknown>) =>
  promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {createLocalTracker}=await import(${JSON.stringify(source)}); await createLocalTracker({directory:${JSON.stringify(directory)}}).call('save_project',${JSON.stringify(args)});`,
    ],
    { env: process.env },
  );

const writer = createLocalTracker({ directory });
const project: any = await writer.call("save_project", { name: "Initial", addTeams: ["LOCAL"] });
for (let n = 0; !fs.existsSync(join(directory, "tracker.journal")); n++)
  await writer.call("save_issue", {
    team: "LOCAL",
    project: project.id,
    title: "j" + n,
    description: "x".repeat(300 * 1024),
  });
await writer.checkpoint();
const reader = createLocalTracker({ directory });
await reader.referenceProjects([project.id]);

await external({ id: project.id, name: "W" }); // external commit n+1
const live = () =>
  join(
    directory,
    "tracker.journal",
    fs
      .readdirSync(join(directory, "tracker.journal"))
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .at(-1)!,
  );
const liveName = live();
const originalRead = fs.promises.readFile;
const gates: Array<{ entered: Promise<void>; release: () => void }> = [];
const slots: Array<{ enter: () => void; wait: Promise<void> }> = [];
for (let i = 0; i < 2; i++) {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const wait = new Promise<void>((r) => (release = r));
  gates.push({ entered, release });
  slots.push({ enter, wait });
}
let liveReads = 0;
fs.promises.readFile = (async (...args: Parameters<typeof originalRead>) => {
  const bytes = await originalRead(...args);
  if (String(args[0]) === liveName) {
    const slot = slots[liveReads++];
    if (slot) {
      slot.enter();
      await slot.wait;
    }
  }
  return bytes;
}) as typeof originalRead;
syncBuiltinESMExports();
let writeError: string | null = null;
try {
  const refreshing = reader.referenceProjects(["W"]); // A: holds bytes with W only
  await gates[0]!.entered;
  await external({ name: "ExternalX", addTeams: ["LOCAL"] }); // external commit n+2, acknowledged
  const saving = writer.call("save_project", { id: project.id, name: "Local" }).then(
    () => null,
    (e: unknown) => String(e),
  );
  await gates[1]!.entered; // writer's locked refresh holds bytes with W and X
  gates[0]!.release();
  await refreshing; // A publishes its W-only snapshot first
  gates[1]!.release();
  writeError = await saving;
} finally {
  fs.promises.readFile = originalRead;
  syncBuiltinESMExports();
}
const { stdout } = await promisify(execFile)(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `const {createLocalTracker}=await import(${JSON.stringify(source)}); const r=await createLocalTracker({directory:${JSON.stringify(directory)}}).call('list_projects',{}); console.log(JSON.stringify(r));`,
  ],
  { env: process.env },
);
const listed = JSON.parse(stdout.trim().split("\n").at(-1)!);
const names = (listed.nodes ?? listed.projects ?? listed).map((p: any) => p.name);
const result = {
  liveReads,
  writeError,
  freshProcessProjects: names,
  externalXSurvived: names.includes("ExternalX"),
};
console.log(JSON.stringify(result));
assert.equal(result.externalXSurvived, true, "an acknowledged external commit was lost");
assert.equal(writeError, null, "a refreshed writer must commit without a spurious refusal");
assert.ok(names.includes("Local"), "the local write also survives a fresh-process reopen");

// The actual append fence also refuses a generation change made by an external process
// during an authorization callback, after commit's first check, before any bytes are cut.
const beforeBytes = fs.statSync(liveName).size;
let dispatched = false;
const guardError = await writer
  .call(
    "save_project",
    { id: project.id, name: "Must refuse" },
    {
      beforeWrite: async () => {
        await promisify(execFile)(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import fs from "node:fs"; fs.utimesSync(${JSON.stringify(join(directory, "tracker.json"))},new Date(),new Date(Date.now()+1000));`,
          ],
          { env: process.env },
        );
      },
      onDispatch: () => {
        dispatched = true;
      },
    },
  )
  .then(
    () => null,
    (error: unknown) => String(error),
  );
assert.match(guardError ?? "", /Tracker store changed before commit/);
assert.equal(dispatched, false);
assert.equal(fs.statSync(liveName).size, beforeBytes);
const final = (await writer.call("list_projects", {})) as any;
const finalNames = (final.nodes ?? final.projects ?? final).map((entry: any) => entry.name);
assert.ok(finalNames.includes("ExternalX"));
assert.ok(finalNames.includes("Local"));
console.log(
  JSON.stringify({
    ...result,
    guard: { refused: true, appendedBytes: 0, dispatched, externalXSurvived: true },
  }),
);
