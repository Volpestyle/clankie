import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import {
  FileCredentialStore,
  ensureOperatorCredential,
  rotateOperatorCredential,
} from "@clankie/credential-broker";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { SettingsStore } from "@clankie/settings";
import { OPERATOR_CONVERSATION_DISPATCH_PATH, type ConversationQuestionResult } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createClankieApp } from "../src/app.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { runAutonomyCommand } from "../../tui/src/command/fleet.ts";
import { fleetSettingsClient } from "../../tui/test/fixtures/fleet-settings-client.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Actual captain, native Claude adapter/claims, disk settings/asks, HTTP route and installed hook child.
 * Only Herdr's inventory and OS membership observations are fixture-owned substitutes.
 */
async function fixture(watch = true) {
  const root = await mkdtemp(join(tmpdir(), "watch-worker-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const pane = "worker-pane",
    seat = "worker-seat",
    session = randomUUID();
  const native = { source: "herdr:claude", kind: "id" as const, value: session };
  const row = {
    pane_id: pane,
    terminal_id: seat,
    agent: "claude",
    agent_status: "blocked",
    title: "worker",
    agent_session: native,
    cwd: root,
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((s) => ({ ...s, machineAccess: { local: "workers" } }));
  const dial = (level: string) => runAutonomyCommand([level], fleetSettingsClient(settings));
  await dial("low");
  if (watch) await dial("watch");
  await writeFile(
    join(root, "herdr-watches.json.owners.json"),
    JSON.stringify({
      schemaVersion: 1,
      hires: [
        {
          id: "native-hire",
          paneId: pane,
          seatId: seat,
          occupantId: occupantIdForHerdrSession(native),
          hired: true,
          owner: { conversationId: "global-default" },
        },
      ],
    }),
  );
  let holdRead: (() => Promise<void>) | undefined;
  const runner = createHerdrWatchRunner(
    () => true,
    async (args, signal) => {
      if (args[0] === "agent" && args[1] === "get") {
        await holdRead?.();
        return JSON.stringify({ result: { agent: row } });
      }
      if (args[0] === "agent" && args[1] === "wait")
        return new Promise<string>((_resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      if (args[0] === "agent" && args[1] === "list") return JSON.stringify({ result: { agents: [row] } });
      if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [row] } });
      if (args[0] === "workspace" && args[1] === "list")
        return JSON.stringify({ result: { workspaces: [] } });
      throw new Error(`Unrequested native operation: ${args.join(" ")}`);
    },
  );
  const captain = createCaptain(
    {
      herdrAvailable: () => true,
      memory: {},
      embodiment: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings,
      nativeHerdrRunner: runner,
      nativeSummariesPath: join(root, "summaries.json"),
      discordEnvironment: {},
    },
  );
  cleanup.push(() => captain.close());
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const credential = await ensureOperatorCredential({ env: {}, store: credentials });
  const app = await createClankieApp({
    captain,
    settings,
    authenticateCaptain: async () => undefined,
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: {},
      store: credentials,
      identity: { operatorId: "owner", steerSourceLane: "tui" },
    }),
    localFleet: {
      identity: (request) =>
        request.headers.get("x-clankie-pane") === pane
          ? { pane, current: () => true, validate: async () => true }
          : undefined,
    },
  });
  cleanup.push(async () => {
    app.close();
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app.app.fetch(request) });
  cleanup.push(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (request: unknown, token = credential.token) => {
    const response = await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, url), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return { status: response.status, body: await response.json() };
  };
  await captain.recordSeatHook(pane, { schemaVersion: 1, event: "SessionStart", sessionId: session });
  await mkdir(join(root, "links"));
  await writeFile(
    join(root, "links", "fixture.json"),
    JSON.stringify({
      schemaVersion: 2,
      fleet: "default",
      socket: "fixture",
      url,
      authentication: "local-process",
    }),
  );
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/seat-hook.mjs")],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CLANKIE_STATE: root,
        HERDR_PANE_ID: pane,
        HERDR_SOCKET_PATH: "fixture",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (v) => {
    stdout += String(v);
  });
  child.stderr.on("data", (v) => {
    stderr += String(v);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  });
  child.stdin.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: session,
      tool_name: "AskUserQuestion",
      tool_use_id: "question-invocation",
      tool_input: {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "Components" },
              { label: "Vue", description: "Views" },
            ],
            multiSelect: false,
          },
        ],
      },
    }),
  );
  const list = async (): Promise<ConversationQuestionResult[]> => {
    const read = await call({ schemaVersion: 1, op: "input_list" });
    expect(read.status).toBe(200);
    return (read.body as { result: { questions: ConversationQuestionResult[] } }).result.questions;
  };
  const ask = async () => {
    await expect.poll(async () => (await list()).length).toBe(1);
    return (await list())[0]!;
  };
  const answerRequest = (ask: ConversationQuestionResult) => ({
    schemaVersion: 1,
    op: "input_answer",
    conversationId: ask.conversationId,
    requestId: ask.question!.requestId,
    incarnationId: ask.question!.incarnationId,
    expectedRevision: ask.revision,
    answer: { kind: "worker", answers: { q0: { answers: ["React"] } } },
  });
  return {
    root,
    captain,
    settings,
    dial,
    list,
    ask,
    call,
    answerRequest,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    revoke: () => rotateOperatorCredential({ env: {}, store: credentials }),
    holdRead: (next: (() => Promise<void>) | undefined) => {
      holdRead = next;
    },
    meta: async () =>
      JSON.parse(await readFile(join(root, "conversations", "global-default", "meta.json"), "utf8")),
  };
}

it("Watch routes an everyday native question once; the authenticated owner answers through the held hook once without a lead turn", async () => {
  const f = await fixture();
  const ask = await f.ask();
  expect(ask.question!.workerQuestion?.seatId).toBe("worker-seat");
  await expect.poll(f.stderr).toContain("owner's feed");
  expect(await f.list()).toHaveLength(1);
  const request = f.answerRequest(ask);
  const answered = await f.call(request);
  expect(answered.status).toBe(200);
  expect(answered.body).toMatchObject({ result: { status: "resolved", question: { status: "submitted" } } });
  expect(await f.exited).toBe(0);
  expect(JSON.parse(f.stdout())).toMatchObject({
    hookSpecificOutput: { updatedInput: { answers: { "Which framework?": "React" } } },
  });
  expect(await f.call(request)).toEqual(answered);
  expect(await f.list()).toEqual([]);
  expect((await f.settings.load()).autonomy.watch).toBe(true);
  expect((await f.meta()).questions.records[0].question.continuation).toBeUndefined();
});

it("a non-owner or revoked owner cannot answer a Watch question", async () => {
  const f = await fixture();
  const request = f.answerRequest(await f.ask());
  expect((await f.call(request, "worker-token")).status).toBe(401);
  await f.revoke();
  expect((await f.call(request)).status).toBe(401);
  expect(f.stdout()).toBe("");
});

it("leaving Watch returns the same open question to the lead once and refuses its stale owner card", async () => {
  const f = await fixture();
  const ask = await f.ask();
  await f.dial("low");
  expect(await f.list()).toEqual([]);
  await expect.poll(f.stderr).toContain("no second question was sent");
  expect(await f.call(f.answerRequest(ask))).toMatchObject({
    status: 200,
    body: { result: { status: "refused", reason: "worker_question_returned_to_lead" } },
  });
  await f.dial("watch");
  expect((await f.ask()).question!.requestId).toBe(ask.question!.requestId);
  expect((await f.meta()).questions.records).toHaveLength(1);
  expect(f.stdout()).toBe("");
});

it("a native question already sent to Clankie's answering conversation moves to the owner feed when Watch starts", async () => {
  const f = await fixture(false);
  await expect.poll(f.stderr).toContain("leading conversation");
  expect(await f.list()).toEqual([]);
  await f.dial("watch");
  const ask = await f.ask();
  expect(await f.list()).toHaveLength(1);
  expect((await f.meta()).questions.records).toHaveLength(1);
  await expect.poll(f.stderr).toContain("owner's feed");
  const answered = await f.call(f.answerRequest(ask));
  expect(answered).toMatchObject({ status: 200, body: { result: { status: "resolved" } } });
  expect(await f.exited).toBe(0);
  expect(JSON.parse(f.stdout()).hookSpecificOutput.updatedInput.answers).toEqual({
    "Which framework?": "React",
  });
  expect((await f.meta()).questions.records[0].question.continuation).toBeUndefined();
});

it("rotating the real owner credential during native preparation refuses before the answer write", async () => {
  const f = await fixture();
  const ask = await f.ask();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.holdRead(async () => {
    f.holdRead(undefined);
    entered();
    await gate;
  });
  const answer = f.call(f.answerRequest(ask));
  await waiting;
  await f.revoke();
  release();
  expect(await answer).toMatchObject({ status: 403 });
  expect(f.stdout()).toBe("");
  expect((await f.meta()).questions.records[0].question.status).toBe("pending");
});
