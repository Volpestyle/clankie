import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { runSeatCommand } from "../../tui/src/command/seat.ts";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

// VUH-2045 item 3: reattach an exact Claude session to its conversation with
// the seat identity set, across config homes. The real launcher, the real
// service routes and captain, and real config homes on disk; only the Claude
// process itself is not started.

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const token = "clankie_op_" + "a".repeat(43);
const repoRoot = resolve(import.meta.dirname, "../../..");

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "seat-explicit-resume-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const seeded = new ConversationStore(join(root, "conversations"), async () => {});
  const other = await seeded.serve({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "global" },
    title: "Work",
  });
  if (other.op !== "create") throw new Error("create failed");
  await seeded.close();
  const settings = new SettingsStore(join(root, "settings.json"));
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      embodiment: {},
      memory: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings,
      discordEnvironment: {},
      seatAdapters: [],
    },
  );
  cleanup.push(() => captain.close());
  const service = await createClankieApp({
    captain,
    settings,
    authenticateOperator: async (incoming) =>
      incoming.headers.get("authorization") === `Bearer ${token}`
        ? { operatorId: "fixture-owner" }
        : undefined,
  });
  // The session lives in the old config home, under its own project directory.
  const cwd = join(root, "work dir");
  mkdirSync(cwd);
  const project = cwd.replace(/[^A-Za-z0-9]/gu, "-");
  const sessionId = randomUUID();
  const oldHome = join(root, ".claude-james");
  const newHome = join(root, ".claude");
  mkdirSync(join(oldHome, "projects", project), { recursive: true });
  const transcript = `${JSON.stringify({ type: "user", cwd, sessionId, message: { content: "hi" } })}\n`;
  writeFileSync(join(oldHome, "projects", project, `${sessionId}.jsonl`), transcript);
  const spawned: Array<{ command: string; args: readonly string[]; cwd: string; env?: NodeJS.ProcessEnv }> =
    [];
  const launch = (args: readonly string[]) =>
    runSeatCommand(args, {
      repoRoot,
      host: "http://clankie.test",
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLAUDE_CONFIG_DIR: newHome,
        CLANKIE_STATE_HOME: join(root, "state"),
        CLANKIE_OPERATOR_TOKEN: token,
      },
      fetchImpl: async (input, init) => service.app.fetch(new Request(input, init)),
      execFileImpl: async () => ({ stdout: "2.1.0 (Claude Code)", stderr: "" }),
      spawnImpl: async (command, args, launchCwd, env) => {
        spawned.push({ command, args, cwd: launchCwd, ...(env === undefined ? {} : { env }) });
        return 0;
      },
      stdout: { write: () => true },
      stderr: { write: () => true },
    });
  const sync = (conversationId: string, session: string) =>
    service.app.request(`/v1/seat/transcript?conversationId=${conversationId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session, entries: [] }),
    });
  return {
    root,
    captain,
    cwd,
    project,
    sessionId,
    oldHome,
    newHome,
    transcript,
    spawned,
    launch,
    sync,
    other: other.conversation.conversationId,
  };
}

it("resumes an exact session into its conversation from another config home, with the seat identity set", async () => {
  const f = await fixture();
  expect((await f.sync("global-default", f.sessionId)).status).toBe(200);
  const resumeArgs = [
    "--resume",
    f.sessionId,
    "--conversation",
    "global-default",
    "--from-config-dir",
    f.oldHome,
  ];

  // Planning copies nothing.
  await f.launch([...resumeArgs, "--dry-run"]);
  expect(existsSync(join(f.newHome, "projects", f.project, `${f.sessionId}.jsonl`))).toBe(false);

  expect(await f.launch(resumeArgs)).toBe(0);
  const [launched] = f.spawned;
  expect(launched!.command).toBe("claude");
  expect(launched!.args).toEqual(expect.arrayContaining(["--resume", f.sessionId]));
  expect(launched!.args).not.toContain("--session-id");
  // Claude resumes the thread only from its own project directory.
  expect(launched!.cwd).toBe(f.cwd);
  expect(launched!.env).toMatchObject({
    CLANKIE_SEAT_SESSION_ID: f.sessionId,
    CLANKIE_CONVERSATION_ID: "global-default",
    CLAUDE_CONFIG_DIR: f.newHome,
  });
  // The transcript is copied, not moved, and becomes this command's resumable seat.
  expect(readFileSync(join(f.newHome, "projects", f.project, `${f.sessionId}.jsonl`), "utf8")).toBe(
    f.transcript,
  );
  expect(existsSync(join(f.oldHome, "projects", f.project, `${f.sessionId}.jsonl`))).toBe(true);
  expect(JSON.parse(readFileSync(join(f.root, "state", "clankie", "seat.json"), "utf8"))).toMatchObject({
    sessionId: f.sessionId,
    cwd: f.cwd,
    conversationId: "global-default",
  });
  // Once in the new home, a second resume needs no copy and still holds.
  expect(await f.launch(["--resume", f.sessionId, "--conversation", "global-default"])).toBe(0);
});

it("refuses a session another conversation owns, a conversation with a live seat, and a missing transcript", async () => {
  const f = await fixture();
  const resume = (conversationId: string) => [
    "--resume",
    f.sessionId,
    "--conversation",
    conversationId,
    "--from-config-dir",
    f.oldHome,
  ];
  expect((await f.sync(f.other, f.sessionId)).status).toBe(200);
  await expect(f.launch(resume("global-default"))).rejects.toThrow("belongs to another conversation");

  // A live bridge already holds the session's own conversation.
  const stop = new AbortController();
  const poll = f.captain.pollSeatEvents(5_000, stop.signal, f.other);
  cleanup.push(async () => {
    stop.abort();
    await poll.catch(() => undefined);
  });
  await expect.poll(() => f.captain.operatorSeatReady?.(f.other)).toBe(true);
  await expect(f.launch(resume(f.other))).rejects.toThrow("already has a live seat");

  await expect(
    f.launch(["--resume", randomUUID(), "--conversation", "global-default", "--from-config-dir", f.oldHome]),
  ).rejects.toThrow("is in neither");
  // Nothing launched and nothing copied by a refusal.
  expect(f.spawned).toEqual([]);
  expect(existsSync(join(f.newHome, "projects"))).toBe(false);
});
