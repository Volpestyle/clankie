import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { JOURNAL_DIRECTORY } from "../src/tracker-journal.ts";
import {
  createLocalTracker,
  exportTrackerStore,
  promoteLinearImport,
  readTrackerStoreSnapshot,
  restoreTrackerStore,
  type LocalTrackerBackend,
} from "../src/tracker-local.ts";
import { TRACKER_LEAD, TRACKER_OWNER } from "../src/tracker-tools.ts";
import type { LinearImportSnapshot } from "../src/linear-import.ts";

// LOCAL-VUH-42: a large built-in store keeps a checkpoint and appends each commit to a journal.
// These run the real store on disk, other real processes and real kill -9.

const roots: string[] = [];
afterEach(async () => {
  // A background checkpoint may still be finishing its temp file when a test ends.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10 });
});
async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const childScript = (directory: string, body: string) => `
  const { createLocalTracker, readTrackerStoreSnapshot } = await import(${JSON.stringify(source)});
  const directory = ${JSON.stringify(directory)};
  ${body}
`;
/** Runs a script in a fresh Node process: no in-memory store, every segment proven again. */
async function inChild(directory: string, body: string): Promise<string> {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", childScript(directory, body)],
    { maxBuffer: 64 << 20 },
  );
  return stdout;
}
/** What a fresh process opens: titles, sync head and chain lengths. */
const openedInChild = async (directory: string) =>
  JSON.parse(
    await inChild(
      directory,
      `const tracker = createLocalTracker({ directory });
       await tracker.storeId();
       const store = await readTrackerStoreSnapshot(directory);
       process.stdout.write(JSON.stringify({
         titles: store.issues.map((issue) => issue.title).sort(),
         syncId: store.syncId,
         events: store.events.length,
         audit: store.audit.length,
       }));`,
    ),
  ) as { titles: string[]; syncId: number; events: number; audit: number };

const LARGE = "x".repeat(300 * 1024);
/** Writes large issues until the store has moved onto the journal. */
async function journalStore(directory: string): Promise<{ tracker: LocalTrackerBackend; keys: string[] }> {
  const tracker = createLocalTracker({ directory });
  const keys: string[] = [];
  for (let index = 0; !existsSync(join(directory, JOURNAL_DIRECTORY)); index++) {
    keys.push(`journal-large-${String(index).padStart(4, "0")}`);
    await tracker.call("save_issue", {
      team: "LOCAL",
      title: `large ${String(index)}`,
      description: LARGE,
      idempotencyKey: keys.at(-1),
    });
  }
  return { tracker, keys };
}
const segments = async (directory: string) =>
  (await readdir(join(directory, JOURNAL_DIRECTORY))).filter((name) => name.endsWith(".jsonl")).sort();
const checkpointHeader = async (directory: string) =>
  JSON.parse(await readFile(join(directory, "tracker.json"), "utf8")) as {
    journal?: { sealed: { name: string; bytes: number }[] };
    syncLog?: unknown;
    receipts?: { resultInJournal?: boolean }[];
  };

it("moves a large store onto the journal and keeps every issue, event and receipt", async () => {
  const directory = await scratch("tracker-journal-migrate-");
  const { tracker, keys } = await journalStore(directory);
  const [backupName] = (await readdir(directory)).filter((name) => name.startsWith("tracker.pre-journal-"));
  const backup = JSON.parse(await readFile(join(directory, backupName!), "utf8")) as {
    issues: { id: string }[];
    events: unknown[];
    audit: unknown[];
    syncId: number;
  };
  for (let index = 0; index < 16; index++) {
    keys.push(`journal-after-${String(index).padStart(4, "0")}`);
    await tracker.call("save_issue", {
      team: "LOCAL",
      title: `after ${String(index)}`,
      description: LARGE,
      idempotencyKey: keys.at(-1),
    });
  }
  const receipts = [];
  for (const key of keys) receipts.push(await tracker.call("get_write_receipt", { idempotencyKey: key }));
  await tracker.checkpoint();

  // The checkpoint holds no sync log, and large applied results moved out of memory.
  const header = await checkpointHeader(directory);
  expect(header.syncLog).toBeUndefined();
  expect(header.journal!.sealed.length).toBeGreaterThan(1);
  expect(header.receipts!.some((receipt) => receipt.resultInJournal === true)).toBe(true);

  const fresh = JSON.parse(
    await inChild(
      directory,
      `const tracker = createLocalTracker({ directory });
       const receipts = [];
       for (const key of ${JSON.stringify(keys)})
         receipts.push(await tracker.call("get_write_receipt", { idempotencyKey: key }));
       const store = await readTrackerStoreSnapshot(directory);
       const page = await tracker.sync({ action: "subscribe", projects: ["unprojected"],
         storeId: await tracker.storeId(), lastSyncId: 0, waitMs: 0, limit: 250 });
       process.stdout.write(JSON.stringify({ receipts, store, syncIds: page.commits.map((c) => c.syncId) }));`,
    ),
  ) as {
    receipts: unknown[];
    store: { issues: { id: string }[]; events: unknown[]; audit: unknown[]; syncId: number };
    syncIds: number[];
  };
  expect(fresh.receipts).toEqual(receipts);
  for (const issue of backup.issues)
    expect(fresh.store.issues.find((entry) => entry.id === issue.id)).toEqual(issue);
  expect(fresh.store.events.slice(0, backup.events.length)).toEqual(backup.events);
  expect(fresh.store.audit.slice(0, backup.audit.length)).toEqual(backup.audit);
  // The whole sync history, from before the move too, still serves a cursor of 0.
  expect(fresh.syncIds).toEqual(Array.from({ length: fresh.store.syncId }, (_, index) => index + 1));
  expect(fresh.store.syncId).toBeGreaterThan(backup.syncId);
}, 120_000);

it("reopens the same store from every crash point of a commit and a checkpoint", async () => {
  const directory = await scratch("tracker-journal-crash-points-");
  const { tracker } = await journalStore(directory);
  for (let index = 0; index < 3; index++)
    await tracker.call("save_issue", { team: "LOCAL", title: `kept ${String(index)}`, description: LARGE });
  const committed = await openedInChild(directory);

  // Between append and fsync: the page cache kept part of the line. It was never acknowledged.
  const live = join(directory, JOURNAL_DIRECTORY, (await segments(directory)).at(-1)!);
  await appendFile(live, '{"syncId":');
  expect(await openedInChild(directory)).toEqual(committed);
  // The next commit, from another process, cuts the torn bytes off before appending.
  await inChild(
    directory,
    `await createLocalTracker({ directory }).call("save_issue", { team: "LOCAL", title: "after torn" });`,
  );
  for (const line of (await readFile(live, "utf8")).split("\n").filter(Boolean))
    expect(() => JSON.parse(line)).not.toThrow();
  const afterTorn = await openedInChild(directory);
  expect(afterTorn.titles).toEqual([...committed.titles, "after torn"].sort());

  // Between checkpoint and rename: segments sealed and a new one started, the old checkpoint
  // still in place, a temp file left behind, and commits kept landing in the new segment.
  const previous = await readFile(join(directory, "tracker.json"));
  await tracker.checkpoint();
  await tracker.call("save_issue", { team: "LOCAL", title: "after checkpoint" });
  await writeFile(join(directory, "tracker.json"), previous);
  await writeFile(join(directory, "tracker.json.00000000-0000-4000-8000-000000000000.tmp"), "{");
  const unrenamed = await openedInChild(directory);
  expect(unrenamed.titles).toEqual([...afterTorn.titles, "after checkpoint"].sort());
  // That store keeps working: it commits, and checkpoints over every segment since.
  await inChild(
    directory,
    `const tracker = createLocalTracker({ directory });
     await tracker.call("save_issue", { team: "LOCAL", title: "after recovery" });
     await tracker.checkpoint();`,
  );
  expect((await openedInChild(directory)).titles).toEqual([...unrenamed.titles, "after recovery"].sort());
}, 120_000);

// LOCAL-VUH-42 review B1: a checkpoint stopped after starting its new segment left that empty
// segment as the live one. The next start's checkpoint sealed it, and the store no longer opened.
it("restarts after a checkpoint stopped before its rename, checkpoints and keeps writing", async () => {
  const directory = await scratch("tracker-journal-interrupted-checkpoint-");
  const { tracker } = await journalStore(directory);
  for (let index = 0; index < 2; index++)
    await tracker.call("save_issue", { team: "LOCAL", title: `kept ${String(index)}` });
  const previous = await readFile(join(directory, "tracker.json"));
  await tracker.checkpoint();
  // Back to the state after phase 1: sealed and started, the old checkpoint still in place.
  await writeFile(join(directory, "tracker.json"), previous);
  const before = await openedInChild(directory);
  // The service's start-up checkpoint runs before any commit, then a write.
  await inChild(
    directory,
    `const tracker = createLocalTracker({ directory });
     await tracker.checkpoint();
     await tracker.call("save_issue", { team: "LOCAL", title: "after restart" });`,
  );
  const header = await checkpointHeader(directory);
  expect(header.journal!.sealed.every((segment) => segment.bytes > 0)).toBe(true);
  expect((await openedInChild(directory)).titles).toEqual([...before.titles, "after restart"].sort());
}, 120_000);

it("keeps every acknowledged write across twenty kill -9s of another writing process", async () => {
  const directory = await scratch("tracker-journal-kill-");
  const { tracker } = await journalStore(directory);
  const acknowledged = new Set((await openedInChild(directory)).titles);
  let checkpointed = 0;
  for (let round = 0; round < 20; round++) {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        childScript(
          directory,
          `const tracker = createLocalTracker({ directory });
           for (let index = 0; ; index++) {
             const title = "round ${String(round)} write " + index;
             await tracker.call("save_issue", { team: "LOCAL", title, description: "x".repeat(300 * 1024) });
             process.stdout.write(title + "\\n");
           }`,
        ),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const acks: string[] = [];
    const stop = 1 + (round % 3);
    await new Promise<void>((resolve) => {
      let buffered = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        const lines = buffered.split("\n");
        buffered = lines.pop()!;
        acks.push(...lines);
        // Kill mid-write: after a few acknowledged writes, at a varying point in the next.
        if (acks.length >= stop) setTimeout(() => child.kill("SIGKILL"), (round * 7) % 23);
      });
      child.on("exit", () => resolve());
    });
    for (const title of acks) acknowledged.add(title);
    // A killed holder's lock goes stale after 60 seconds; age it past that rather than wait.
    const lock = join(directory, "tracker.json.lock");
    if (existsSync(lock)) await utimes(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    // This process's backend replays the other's journal tail onto its snapshot, then writes after it.
    const titles = new Set(
      ((await tracker.call("list_issues", { limit: 250 })) as { issues: { title: string }[] }).issues.map(
        (issue) => issue.title,
      ),
    );
    for (const title of acknowledged) expect(titles).toContain(title);
    const inflight = `round ${String(round)} write ${String(acks.length)}`;
    for (const title of titles) if (!acknowledged.has(title)) expect(title).toBe(inflight);
    if (titles.has(inflight)) acknowledged.add(inflight);
    await tracker.call("save_issue", { team: "LOCAL", title: `service after round ${String(round)}` });
    acknowledged.add(`service after round ${String(round)}`);
    checkpointed = Math.max(checkpointed, (await checkpointHeader(directory)).journal?.sealed.length ?? 0);
  }
  // A fresh process proves every chain and sealed segment, and sees exactly the acknowledged writes.
  expect((await openedInChild(directory)).titles).toEqual([...acknowledged].sort());
  expect(checkpointed).toBeGreaterThan(1);
}, 240_000);

it("replays the journal the same way on every open and answers a keyed retry from it", async () => {
  const directory = await scratch("tracker-journal-replay-");
  const { tracker } = await journalStore(directory);
  const created = await tracker.call("save_issue", {
    team: "LOCAL",
    title: "keyed",
    description: LARGE,
    idempotencyKey: "journal-keyed-0001",
  });
  await tracker.checkpoint();
  for (let index = 0; index < 3; index++)
    await tracker.call("save_issue", { team: "LOCAL", title: `tail ${String(index)}` });
  const first = await readTrackerStoreSnapshot(directory);
  expect(await readTrackerStoreSnapshot(directory)).toEqual(first);
  expect(await openedInChild(directory)).toEqual(await openedInChild(directory));

  const retried = JSON.parse(
    await inChild(
      directory,
      `const tracker = createLocalTracker({ directory });
       const result = await tracker.call("save_issue", { team: "LOCAL", title: "keyed",
         description: "x".repeat(300 * 1024), idempotencyKey: "journal-keyed-0001" });
       process.stdout.write(JSON.stringify(result));`,
    ),
  ) as unknown;
  expect(retried).toEqual(created);
  expect((await readTrackerStoreSnapshot(directory))!.syncId).toBe(first!.syncId);
}, 120_000);

it("refuses a journal whose chain or sealed segment was changed", async () => {
  const directory = await scratch("tracker-journal-broken-");
  const { tracker } = await journalStore(directory);
  for (let index = 0; index < 3; index++)
    await tracker.call("save_issue", { team: "LOCAL", title: `kept ${String(index)}`, description: LARGE });
  await tracker.checkpoint();
  for (let index = 0; index < 2; index++)
    await tracker.call("save_issue", { team: "LOCAL", title: `tail ${String(index)}` });
  const opened = await openedInChild(directory);
  const open = `await createLocalTracker({ directory }).storeId();`;

  // A changed commit hash in the live segment: refused by a fresh process and by this one.
  const live = join(directory, JOURNAL_DIRECTORY, (await segments(directory)).at(-1)!);
  const original = await readFile(live, "utf8");
  const lines = original.split("\n");
  const record = JSON.parse(lines.at(-2)!) as { commit: { hash: string } };
  record.commit.hash = (record.commit.hash.startsWith("0") ? "1" : "0") + record.commit.hash.slice(1);
  lines[lines.length - 2] = JSON.stringify(record);
  await writeFile(live, lines.join("\n"));
  await expect(inChild(directory, open)).rejects.toThrow(/not intact/u);
  await expect(tracker.storeId()).rejects.toThrow(/not intact/u);
  await expect(tracker.call("save_issue", { team: "LOCAL", title: "forbidden" })).rejects.toThrow(
    /not intact/u,
  );
  await writeFile(live, original);
  expect(await openedInChild(directory)).toEqual(opened);

  // One changed byte in a sealed segment, same size: its digest refuses the open.
  const sealed = join(
    directory,
    JOURNAL_DIRECTORY,
    (await checkpointHeader(directory)).journal!.sealed[0]!.name,
  );
  const history = await readFile(sealed);
  const changed = Buffer.from(history);
  const at = changed.indexOf('"tool":"');
  changed[at + 8] = changed[at + 8] === 0x73 ? 0x74 : 0x73;
  await writeFile(sealed, changed);
  await expect(inChild(directory, open)).rejects.toThrow(/not intact/u);
  await writeFile(sealed, history);
  expect(await openedInChild(directory)).toEqual(opened);
}, 120_000);

it("serves ten long-polling subscribers during a write burst without raising per-write cost", async () => {
  const directory = await scratch("tracker-journal-pollers-");
  const { tracker } = await journalStore(directory);
  const { id } = (await tracker.call("save_issue", { team: "LOCAL", title: "burst" })) as { id: string };
  const storeId = await tracker.storeId();
  const median = async (round: string) => {
    const times: number[] = [];
    for (let index = 0; index < 15; index++) {
      const start = performance.now();
      await tracker.call("save_issue", { id, title: `${round} ${String(index)}` });
      times.push(performance.now() - start);
    }
    return times.sort((a, b) => a - b)[7]!;
  };
  await median("warm");
  const quiet = await median("quiet");

  const from = (await readTrackerStoreSnapshot(directory))!.syncId as number;
  const abort = new AbortController();
  const seen = Array.from({ length: 10 }, () => [] as number[]);
  const pollers = seen.map(async (syncIds) => {
    let cursor = from;
    while (!abort.signal.aborted) {
      const page = await tracker
        .sync(
          {
            action: "subscribe",
            projects: ["unprojected"],
            storeId,
            lastSyncId: cursor,
            waitMs: 5_000,
            limit: 100,
          },
          undefined,
          abort.signal,
        )
        .catch(() => undefined);
      if (page?.outcome !== "deltas") return;
      for (const commit of page.commits) syncIds.push(commit.syncId);
      cursor = page.lastSyncId;
    }
  });
  const busy = await median("busy");
  const to = (await readTrackerStoreSnapshot(directory))!.syncId as number;
  await expect.poll(() => seen.every((syncIds) => syncIds.at(-1) === to), { timeout: 10_000 }).toBe(true);
  abort.abort();
  await Promise.all(pollers);
  for (const syncIds of seen)
    expect(syncIds).toEqual(Array.from({ length: to - from }, (_, index) => from + index + 1));
  // Each waiter reads the shared committed store: no copy or parse per wake-up.
  expect(busy).toBeLessThan(quiet * 2 + 5);
}, 120_000);

it("cuts over onto a journal-backed store and switches back to all of its history", async () => {
  const root = await scratch("tracker-journal-cutover-");
  const live = join(root, "tracker");
  const { tracker, keys } = await journalStore(live);
  await tracker.checkpoint();
  await tracker.call("save_issue", { team: "LOCAL", title: "tail" });
  const receipts = [];
  for (const key of keys) receipts.push(await tracker.call("get_write_receipt", { idempotencyKey: key }));
  expect((await checkpointHeader(live)).receipts!.some((receipt) => receipt.resultInJournal === true)).toBe(
    true,
  );
  const opened = await openedInChild(live);

  const imported = join(root, "import");
  const snapshot = JSON.parse(
    await readFile(new URL("./fixtures/linear-import/clankie-work.json", import.meta.url), "utf8"),
  ) as LinearImportSnapshot;
  const actors = Object.fromEntries(
    snapshot.actors.map((actor) => [
      actor.id,
      actor.id === "634ad2c8-4992-48b5-b14d-af650cd30030"
        ? { ...TRACKER_OWNER, onBehalfOf: [] }
        : { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] },
    ]),
  );
  await createLocalTracker({ directory: imported }).importLinear(snapshot, actors);
  const projectId = ((await readTrackerStoreSnapshot(imported))!.projects as { id: string }[])[0]!.id;
  // The documented rollback export is that same whole store.
  const exported = join(root, "export.json");
  expect(await exportTrackerStore(live, exported)).toBe(true);
  const backup = join(root, "backup.json");
  await promoteLinearImport({
    source: imported,
    target: live,
    backup,
    linearProjectId: projectId,
    scratch: "import",
    actor: { ...TRACKER_OWNER, onBehalfOf: [] },
    verify: () => {},
  });
  // The backup is the whole store as one file: every sync commit, every receipt result.
  const saved = JSON.parse(await readFile(backup, "utf8")) as {
    syncLog: unknown[];
    syncId: number;
    journal?: unknown;
  };
  expect(saved.journal).toBeUndefined();
  expect(saved.syncLog).toHaveLength(saved.syncId);
  expect(saved.syncId).toBe(opened.syncId);
  expect(await readFile(exported, "utf8")).toBe(await readFile(backup, "utf8"));
  // The replaced journal is set aside, never deleted; the promoted store opens on its own.
  expect(existsSync(join(live, JOURNAL_DIRECTORY))).toBe(false);
  expect((await readdir(live)).some((name) => name.startsWith(`${JOURNAL_DIRECTORY}.replaced-`))).toBe(true);
  expect((await openedInChild(live)).titles).not.toEqual(opened.titles);

  await restoreTrackerStore({ target: live, backup, keep: join(root, "keep.json") });
  expect(await readFile(join(live, "tracker.json"), "utf8")).toBe(await readFile(backup, "utf8"));
  expect(await openedInChild(live)).toEqual(opened);
  // Back on the old store, receipts answer as before, and the next start moves it onto a journal again.
  const restored = JSON.parse(
    await inChild(
      live,
      `const tracker = createLocalTracker({ directory });
       await tracker.checkpoint();
       const receipts = [];
       for (const key of ${JSON.stringify(keys)})
         receipts.push(await tracker.call("get_write_receipt", { idempotencyKey: key }));
       process.stdout.write(JSON.stringify(receipts));`,
    ),
  ) as unknown[];
  expect(restored).toEqual(receipts);
  expect(existsSync(join(live, JOURNAL_DIRECTORY))).toBe(true);
  expect(await openedInChild(live)).toEqual(opened);
}, 120_000);
