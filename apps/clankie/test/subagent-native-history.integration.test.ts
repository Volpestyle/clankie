import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { emptySettings } from "@clankie/settings";
import { parseHerdrSeatTranscript } from "@clankie/agent-transcript";
import { createAgentSessions } from "../src/agent-sessions.ts";
import { OpenCodeProfiles } from "../src/opencode-profiles.ts";
import { writeOpenCodeNativeSession } from "./helpers/opencode-native-db.ts";
import claude from "./fixtures/claude-subagent-history-native.json" with { type: "json" };
import codex from "./fixtures/codex-subagents.json" with { type: "json" };
import opencode from "./fixtures/opencode-subagents-native.json" with { type: "json" };

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const text = (page: { entries: readonly unknown[] }) =>
  page.entries.flatMap((entry) =>
    typeof entry === "object" && entry !== null && "text" in entry ? [entry.text] : [],
  );
async function root() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "native-child-history-")));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
const sessions = () => createAgentSessions({ load: async () => emptySettings() });
async function claudeFiles() {
  const directory = await root();
  const parent = join(directory, `${claude.parentId}.jsonl`);
  const childRoot = join(directory, claude.parentId, "subagents");
  await mkdir(childRoot, { recursive: true });
  const child = join(childRoot, `agent-${claude.agentId}.jsonl`);
  await writeFile(parent, claude.parent.map(line).join(""));
  await writeFile(child, claude.child.map(line).join(""));
  const source = { source: "herdr:claude", kind: "path" as const, value: parent };
  return { directory, parent, child, source };
}

test("real native Claude call/result and nested sidechain produce read-only child pages without changing parent parsing", async () => {
  const f = await claudeFiles();
  const service = sessions();
  expect(parseHerdrSeatTranscript("claude", await readFile(f.child, "utf8"))).toEqual([]);
  const page = await service.readSubagent!("claude", f.source, claude.callId, { tail: 500 });
  expect(page.session).toMatchObject({ harness: "claude", sessionId: `agent-${claude.agentId}` });
  expect(text(page)).toEqual(["Fixture child prompt", "Fixture child answer"]);
  expect(
    (await service.readSubagent!("claude", f.source, claude.callId, { tail: 500, after: page.cursor }))
      .entries,
  ).toEqual([]);
  const next = {
    ...claude.child[1],
    uuid: "fixture-next",
    parentUuid: claude.child[1]!.uuid,
    message: { role: "assistant", content: [{ type: "text", text: "Appended child answer" }] },
  };
  await appendFile(f.child, line(next));
  const appended = await service.readSubagent!("claude", f.source, claude.callId, {
    tail: 500,
    after: page.cursor,
  });
  expect(text(appended)).toEqual(["Appended child answer"]);
  await writeFile(
    f.child,
    claude.child
      .map((row) =>
        row.type === "assistant"
          ? { ...row, message: { role: "assistant", content: [{ type: "text", text: "Rewritten answer" }] } }
          : row,
      )
      .map(line)
      .join(""),
  );
  const rewritten = await service.readSubagent!("claude", f.source, claude.callId, {
    tail: 500,
    after: appended.cursor,
  });
  expect(rewritten.reset).toBe(true);
  expect(text(rewritten)).toEqual(["Fixture child prompt", "Rewritten answer"]);
});

test("Claude child reading requires native call mapping and rejects mismatched headers and escaped symlinks", async () => {
  const f = await claudeFiles();
  const service = sessions();
  await expect(service.readSubagent!("claude", f.source, "unknown-call")).rejects.toMatchObject({
    status: 404,
  });
  await writeFile(f.parent, line(claude.parent[0]));
  await expect(service.readSubagent!("claude", f.source, claude.callId)).rejects.toMatchObject({
    status: 409,
  });
  await writeFile(f.parent, claude.parent.map(line).join(""));
  await writeFile(
    f.child,
    claude.child
      .map((row) => ({ ...row, sessionId: "foreign-parent" }))
      .map(line)
      .join(""),
  );
  await expect(service.readSubagent!("claude", f.source, claude.callId)).rejects.toMatchObject({
    status: 409,
  });
  const outside = join(f.directory, "outside.jsonl");
  await writeFile(outside, claude.child.map(line).join(""));
  await rm(f.child);
  await symlink(outside, f.child);
  await expect(service.readSubagent!("claude", f.source, claude.callId)).rejects.toMatchObject({
    status: 409,
  });
});

test("Codex child UUID resolves only under the exact native parent and preserves native cursor isolation", async () => {
  const directory = join(await root(), "sessions", "2026", "10", "04");
  await mkdir(directory, { recursive: true });
  const parent = join(directory, `rollout-parent-${codex.parent.payload.id}.jsonl`);
  const child = join(directory, `rollout-child-${codex.child.payload.id}.jsonl`);
  const answer = {
    timestamp: "2026-10-04T17:20:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      id: "child-message",
      role: "assistant",
      content: [{ type: "output_text", text: "Codex child answer" }],
    },
  };
  await writeFile(parent, line(codex.parent));
  await writeFile(child, line(codex.child) + line(codex.taskStarted) + line(answer));
  const service = sessions();
  const source = { source: "herdr:codex", kind: "path" as const, value: parent };
  const page = await service.readSubagent!("codex", source, codex.child.payload.id);
  expect(page.session.sessionId).toBe(codex.child.payload.id);
  expect(text(page)).toEqual(["Codex child answer"]);
  const foreign = {
    ...codex.child,
    payload: { ...codex.child.payload, parent_thread_id: "10000000-0000-4000-8000-000000000001" },
  };
  await writeFile(child, line(foreign) + line(answer));
  await expect(
    service.readSubagent!("codex", source, codex.child.payload.id, { after: page.cursor }),
  ).rejects.toMatchObject({ status: 404 });
});

async function openCodeFiles() {
  const directory = await root();
  const profiles = new OpenCodeProfiles(directory);
  const profile = await profiles.allocate();
  await writeOpenCodeNativeSession(profile.database, directory, opencode.parent);
  await profiles.register(profile, opencode.parent, directory, async () => {});
  const db = new DatabaseSync(profile.database);
  cleanup.push(async () => db.close());
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare(
    "INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(opencode.child, "project", opencode.parent, "child", directory, "Child fixture", "1.18.18", 1, 2);
  const put = (id: string, sessionId: string, part: unknown, role = "assistant") => {
    db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(
      id,
      sessionId,
      3,
      3,
      JSON.stringify({ role, time: { created: 3, ...(role === "assistant" ? { completed: 4 } : {}) } }),
    );
    db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(
      `prt_${id}`,
      id,
      sessionId,
      3,
      3,
      JSON.stringify(part),
    );
  };
  put("parent-task", opencode.parent, opencode.completed);
  put("child-answer", opencode.child, { type: "text", text: "OpenCode child answer" });
  return {
    db,
    profiles,
    service: createAgentSessions({ load: async () => emptySettings() }, undefined, profiles),
    source: { source: "herdr:opencode", kind: "id" as const, value: opencode.parent },
  };
}

test("registered OpenCode task call resolves its direct child in the same native profile without registering or resuming it", async () => {
  const f = await openCodeFiles();
  const page = await f.service.readSubagent!("opencode", f.source, opencode.completed.callID, { tail: 500 });
  expect(page.session).toMatchObject({ harness: "opencode", sessionId: opencode.child });
  expect(text(page)).toEqual(["OpenCode child answer"]);
  await expect(f.profiles.resolve(opencode.child)).rejects.toMatchObject({ status: 404 });
  expect(
    (
      await f.service.readSubagent!("opencode", f.source, opencode.completed.callID, {
        tail: 500,
        after: page.cursor,
      })
    ).entries,
  ).toEqual([]);
  f.db
    .prepare("UPDATE part SET data=? WHERE id=?")
    .run(JSON.stringify({ type: "text", text: "Changed native child" }), "prt_child-answer");
  const changed = await f.service.readSubagent!("opencode", f.source, opencode.completed.callID, {
    tail: 500,
    after: page.cursor,
  });
  expect(changed.reset).toBe(true);
  expect(text(changed)).toEqual(["Changed native child"]);
  const parentPage = await f.profiles.read(opencode.parent, { tail: 500 });
  await expect(
    f.service.readSubagent!("opencode", f.source, opencode.completed.callID, {
      tail: 500,
      after: parentPage.cursor,
    }),
  ).rejects.toMatchObject({ status: 409 });
  f.db.prepare("UPDATE session SET parent_id=? WHERE id=?").run("ses_foreignParent123", opencode.child);
  await expect(
    f.service.readSubagent!("opencode", f.source, opencode.completed.callID),
  ).rejects.toMatchObject({ status: 404 });
});
