import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(".local/vuh49/baseline");
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  NODE_ENV: "test",
  XDG_CONFIG_HOME: join(root, "home/.config"),
  XDG_STATE_HOME: join(root, "home/.state"),
};
const current = pathToFileURL(resolve("packages/work-items/src/index.ts")).href;
const previous = pathToFileURL(
  resolve("packages/work-items/.local/vuh49-old/packages/work-items/src/index.ts"),
).href;
const results = [];
function run(source, directory, body) {
  const r = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      "--input-type=module",
      "-e",
      `const {createLocalTracker,readTrackerStoreSnapshot}=await import(${JSON.stringify(source)}); const directory=${JSON.stringify(directory)}; const tracker=createLocalTracker({directory}); ${body}`,
    ],
    { env, encoding: "utf8", timeout: 60000, maxBuffer: 1 << 20 },
  );
  const result = {
    source,
    directory,
    status: r.status,
    signal: r.signal,
    error: r.error?.message,
    stdout: r.stdout,
    stderr: r.stderr,
  };
  results.push(result);
  console.log(JSON.stringify(result));
  return result;
}
async function digests(directory) {
  const files = {};
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const h = createHash("sha256");
        for await (const bytes of createReadStream(path)) h.update(bytes);
        files[path.slice(directory.length)] = h.digest("hex");
      }
    }
  }
  await visit(directory);
  return files;
}
const small = join(root, "rollback-small");
if (
  run(
    current,
    small,
    `for(let i=0;i<8;i++) await tracker.call('save_issue',{team:'LOCAL',title:'rollback '+i,description:'x'.repeat(300000)}); await tracker.checkpoint(); console.log(await tracker.storeId());`,
  ).status !== 0
)
  process.exit(1);
if (
  run(
    previous,
    small,
    `const listed=await tracker.call('list_issues',{limit:1}); await tracker.call('save_comment',{issueId:listed.issues[0].id,body:'old build acknowledged',idempotencyKey:'old-rollback-ack'}); console.log('old read/write passed');`,
  ).status !== 0
)
  process.exit(1);
if (
  run(
    current,
    small,
    `const store=await readTrackerStoreSnapshot(directory); if(!store.comments.some(c=>c.body==='old build acknowledged')) throw Error('lost old commit'); const result=await tracker.call('get_write_receipt',{idempotencyKey:'old-rollback-ack'}); if(result.state!=='applied') throw Error('lost receipt'); await tracker.call('save_comment',{issueId:store.issues[0].id,body:'new after old'}); console.log('new after rollback passed');`,
  ).status !== 0
)
  process.exit(1);
const large = join(root, "180");
const before = await digests(large);
const refused = run(previous, large, `await tracker.call('save_issue',{team:'LOCAL',title:'must refuse'});`);
const after = await digests(large);
if (
  refused.status === 0 ||
  !refused.stderr.includes("Cannot create a string longer") ||
  JSON.stringify(before) !== JSON.stringify(after)
)
  throw Error("old runtime did not refuse without changing bytes");
const reopened = run(
  current,
  large,
  `const result=await tracker.call('get_write_receipt',{idempotencyKey:'vuh49-large-fresh-write'}); if(result.state!=='applied') throw Error('missing oversized-store receipt'); const store=await readTrackerStoreSnapshot(directory); if(!store.comments.some(c=>c.body==='fresh-process write beyond old limit')) throw Error('missing oversized-store write'); console.log(JSON.stringify({syncId:store.syncId,receipt:result.state,comments:store.comments.length}));`,
);
if (reopened.status !== 0) process.exit(1);
await writeFile(
  join(root, "rollback.json"),
  JSON.stringify({ results, oldLargeRefusal: { before, after, unchanged: true } }, null, 2),
);
