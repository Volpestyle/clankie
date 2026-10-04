import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, realpath, rm, rename, symlink, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import {
  openCodeDatabaseIdentity,
  readOpenCodeHistory,
  type OpenCodeHistorySource,
} from "../src/opencode-history.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(wal = false) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "opencode-history-")));
  const root = await mkdtemp(join(parent, "profile-"));
  const path = join(root, "opencode.db");
  const db = new DatabaseSync(path);
  // Fixture contains only the four history tables, not unrelated native project tables.
  db.exec("PRAGMA foreign_keys=OFF");
  cleanup.push(async () => {
    if (db.isOpen) db.close();
    await rm(parent, { recursive: true, force: true });
  });
  if (wal) db.exec("PRAGMA journal_mode=WAL");
  db.exec(await readFile(new URL("./fixtures/opencode-history-1.18.18.sql", import.meta.url), "utf8"));
  const id = "ses_ownedNative1234";
  db.prepare(
    "INSERT INTO session(id,project_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?)",
  ).run(id, "project", "native", parent, "Native history", "1.18.18", 1, 2);
  const source: OpenCodeHistorySource = {
    kind: "opencode-sqlite",
    machineId: "local",
    profileId: root.split("/").at(-1)!,
    database: path,
    databaseIdentity: await openCodeDatabaseIdentity(path, root),
    sessionId: id,
    version: "1.18.18",
    workingDirectory: parent,
  };
  const message = (messageId: string, text: string, time = 3, role = "user") => {
    db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(
      messageId,
      id,
      time,
      time,
      JSON.stringify({
        role,
        time: { created: time, ...(role === "assistant" ? { completed: time + 1 } : {}) },
      }),
    );
    db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(
      `part_${messageId}`,
      messageId,
      id,
      time,
      time,
      JSON.stringify({ type: "text", text }),
    );
  };
  return {
    parent,
    root,
    path,
    db,
    id,
    source,
    message,
    read: (options: { tail?: number; after?: string } = {}) => readOpenCodeHistory(source, root, options),
  };
}
const text = (value: { entries: readonly { type: string }[] }) =>
  value.entries.flatMap((row) => ("text" in row ? [row.text] : []));
const hashes = async (root: string) =>
  Object.fromEntries(
    await Promise.all(
      (await readdir(root)).map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(root, name)))
          .digest("hex"),
      ]),
    ),
  );

test("reads native stored v1 chronologically and resets content/revert changes without a mirror", async () => {
  const f = await fixture();
  f.message("later", "reply", 5, "assistant");
  f.message("earlier", "hello", 3);
  const page = await f.read();
  expect(text(page)).toEqual(["hello", "reply"]);
  expect(page.scope).toBe("stored-v1-export");
  expect(page).not.toHaveProperty("size");
  expect((await f.read({ after: page.cursor })).entries).toEqual([]);
  f.db
    .prepare("UPDATE part SET data=? WHERE id=?")
    .run(JSON.stringify({ type: "text", text: "changed" }), "part_earlier");
  const changed = await f.read({ after: page.cursor });
  expect(changed.reset).toBe(true);
  expect(text(changed)).toEqual(["changed", "reply"]);
  f.db.prepare("UPDATE session SET revert=? WHERE id=?").run(JSON.stringify({ messageID: "later" }), f.id);
  const reverted = await f.read({ after: changed.cursor });
  expect(reverted.reset).toBe(true);
  expect(reverted.stagedRevert).toBe(true);
  expect(text(reverted)).toContain("reply"); // Stored export, not staged TUI visibility.
  f.db.exec("DELETE FROM part WHERE message_id='later';DELETE FROM message WHERE id='later'");
  expect((await f.read({ after: reverted.cursor })).reset).toBe(true);
});

test("tail bounds chronological native rows, invalid and foreign cursors refuse", async () => {
  const f = await fixture();
  f.message("one", "one", 1);
  f.message("two", "two", 2);
  f.message("three", "three", 3);
  const page = await f.read({ tail: 2 });
  expect(text(page)).toEqual(["two", "three"]);
  expect(page.truncated).toBe(true);
  await expect(f.read({ tail: 501 })).rejects.toThrow("tail");
  await expect(f.read({ after: "broken" })).rejects.toThrow("cursor");
  await expect(f.read({ tail: 3, after: page.cursor })).rejects.toThrow("another source");
  const foreign = await fixture();
  await expect(foreign.read({ tail: 2, after: page.cursor })).rejects.toThrow("another source");
});

test("SQL read-only WAL snapshot preserves DB/WAL bytes; normal SHM coordination is explicit", async () => {
  const f = await fixture(true);
  f.message("one", "native");
  const before = await hashes(f.root);
  const page = await f.read();
  const after = await hashes(f.root);
  expect(text(page)).toEqual(["native"]);
  expect(after["opencode.db"]).toBe(before["opencode.db"]);
  expect(after["opencode.db-wal"]).toBe(before["opencode.db-wal"]);
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  // SHM is native reader coordination; neither equality nor inequality is promised.
  expect(after["opencode.db-shm"]).toBeDefined();
});

test("closed rollback-mode read creates nothing and missing DB is never created", async () => {
  const f = await fixture();
  f.message("one", "native");
  const before = await hashes(f.root);
  await f.read();
  expect(await hashes(f.root)).toEqual(before);
  await rename(f.path, join(f.root, "saved.db"));
  await expect(f.read()).rejects.toThrow();
  expect(await readdir(f.root)).toEqual(["saved.db"]);
});

test.each(["linked-shm", "linked-db", "replaced-db", "directory"])(
  "%s source refuses before native data is accepted",
  async (change) => {
    const f = await fixture(true);
    f.message("one", "native");
    if (change === "linked-shm") {
      await rename(f.path + "-shm", join(f.root, "held-shm"));
      await symlink(join(f.root, "held-shm"), f.path + "-shm");
    }
    if (change === "linked-db") {
      await rename(f.path, join(f.root, "held-db"));
      await symlink(join(f.root, "held-db"), f.path);
    }
    if (change === "replaced-db") {
      await rename(f.path, join(f.root, "held-db"));
      await writeFile(f.path, await readFile(join(f.root, "held-db")));
    }
    if (change === "directory") f.db.prepare("UPDATE session SET directory=? WHERE id=?").run("/other", f.id);
    await expect(f.read()).rejects.toThrow();
  },
);

test.each([
  "future-migration",
  "missing-index",
  "wrong-collation",
  "unknown-column",
  "view",
  "v2-only",
  "bad-json",
  "unknown-part",
])("%s refuses instead of empty or guessed native history", async (change) => {
  const f = await fixture();
  if (change === "future-migration") f.db.exec("INSERT INTO migration VALUES('future',1)");
  if (change === "missing-index") f.db.exec("DROP INDEX part_message_id_id_idx");
  if (change === "wrong-collation")
    f.db.exec(
      "DROP INDEX part_message_id_id_idx;CREATE INDEX part_message_id_id_idx ON part(message_id COLLATE NOCASE,id)",
    );
  if (change === "unknown-column") f.db.exec("ALTER TABLE message ADD COLUMN future TEXT");
  if (change === "view") f.db.exec("DROP TABLE message;CREATE VIEW message AS SELECT 'fake' AS id");
  if (change === "v2-only")
    f.db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?,?)").run("v2", f.id, "user", 1, 1, 1, "{}");
  if (change === "bad-json" || change === "unknown-part") {
    f.message("one", "native");
    f.db
      .prepare("UPDATE part SET data=?")
      .run(change === "bad-json" ? "{broken" : JSON.stringify({ type: "future-part" }));
  }
  await expect(f.read()).rejects.toThrow();
});

test.each(["bytes", "parts", "long-id"])("%s payload refuses within native read bounds", async (change) => {
  const f = await fixture();
  f.message("one", "native");
  if (change === "bytes")
    f.db
      .prepare("UPDATE part SET data=?")
      .run(JSON.stringify({ type: "text", text: "x".repeat(4 * 1024 * 1024) }));
  if (change === "long-id") f.db.prepare("UPDATE message SET id=?").run("x".repeat(200));
  if (change === "parts") {
    const insert = f.db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)");
    f.db.exec("BEGIN");
    for (let n = 0; n < 2000; n++) insert.run(`p${n}`, "one", f.id, 1, 1, '{"type":"text","text":"part"}');
    f.db.exec("COMMIT");
  }
  await expect(f.read()).rejects.toThrow();
});

test("closed WAL writer permits native sidecar recreation while DB bytes and stored rows remain unchanged", async () => {
  const f = await fixture(true);
  f.message("one", "native");
  f.db.close();
  const before = await hashes(f.root);
  expect(Object.keys(before)).toEqual(["opencode.db"]);
  const page = await f.read();
  const after = await hashes(f.root);
  expect(text(page)).toEqual(["native"]);
  expect(after["opencode.db"]).toBe(before["opencode.db"]);
  expect(Object.keys(after).sort()).toEqual(["opencode.db", "opencode.db-shm", "opencode.db-wal"]);
  expect((await f.read({ after: page.cursor })).entries).toEqual([]);
});

test("service boundary redacts full native text/tool data before chunking, including a split credential", async () => {
  const f = await fixture();
  const fake = "sk-ant-api03-FAKEFAKEFAKEFAKE-native-history-marker";
  f.message("one", "x".repeat(16_380) + " " + fake + " end", 1, "assistant");
  f.db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(
    "part_tool",
    "one",
    f.id,
    1,
    1,
    JSON.stringify({
      type: "tool",
      callID: " call_native ",
      tool: " bash ",
      state: { status: "completed", output: `Authorization: Bearer fakefixturetoken1234; ${fake}` },
    }),
  );
  const page = await f.read();
  const serialized = JSON.stringify(page.entries);
  expect(serialized).not.toContain(fake);
  expect(serialized).not.toContain("native-history-marker");
  expect(serialized).not.toContain("fakefixturetoken1234");
  expect(serialized).toContain("[REDACTED]");
  expect(page.entries.find((row) => row.type === "tool")).toMatchObject({
    toolCallId: "call_native",
    name: "bash",
  });
  expect(page.entries.every((row) => row.type !== "message" || row.text.length <= 16_384)).toBe(true);
});

test.each(["long-ref", "long-name", "object-output", "object-error", "missing-output"])(
  "%s native tool metadata is unavailable, never guessed/coerced",
  async (mode) => {
    const f = await fixture();
    f.message("one", "reply", 1, "assistant");
    const value = {
      type: "tool",
      callID: mode === "long-ref" ? "x".repeat(513) : "call_native",
      tool: mode === "long-name" ? "x".repeat(513) : "bash",
      state:
        mode === "object-error"
          ? { status: "error", error: { secret: "fake" } }
          : mode === "missing-output"
            ? { status: "completed" }
            : { status: "completed", output: mode === "object-output" ? { value: "unexpected" } : "done" },
    };
    f.db
      .prepare("INSERT INTO part VALUES(?,?,?,?,?,?)")
      .run("part_tool", "one", f.id, 1, 1, JSON.stringify(value));
    await expect(f.read()).rejects.toThrow();
  },
);

test("malformed native JSON errors never echo credential-shaped record fragments", async () => {
  const f = await fixture();
  f.message("one", "native");
  f.db.prepare("UPDATE part SET data=?").run("sk-ant-api03-FAKEFAKEFAKE-malformed");
  await expect(f.read()).rejects.toThrow("malformed native JSON record");
});
