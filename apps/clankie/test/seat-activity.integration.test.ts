import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import {
  OperatorAgentStanceSchema,
  OperatorConversationServiceResultSchema,
  OperatorFleetSeatSchema,
  parseProtocolResponse,
  safeParseProtocolResponse,
} from "@clankie/protocol";
import { SettingsStore, ClankieSettingsSchema } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { createClankieApp } from "../src/app.ts";
import { runStanceCommand } from "../../tui/src/command/stance.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
// Exact pre-change seat/stance shapes, consumed with the existing tolerant response parser.
const oldSeatContract = OperatorFleetSeatSchema.omit({ activity: true }).extend({
  stance: OperatorAgentStanceSchema.omit({ activityKind: true }).optional(),
});

// Codex response_item and Claude tool_use/tool_result shapes are the native
// producers already consumed by @clankie/agent-transcript. No model runs here.
async function fixture(
  harness: "codex" | "claude" = "codex",
  retained?: { root: string; id: string; path: string },
) {
  const root = retained?.root ?? (await realpath(await mkdtemp(join(tmpdir(), "seat-activity-"))));
  const id = retained?.id ?? randomUUID(),
    path = retained?.path ?? join(root, "native.jsonl");
  if (!retained)
    await writeFile(
      path,
      harness === "codex"
        ? line({ type: "session_meta", payload: { id, cwd: root } })
        : line({ type: "system", sessionId: id, timestamp: new Date().toISOString() }),
    );
  const row = {
    pane_id: "w1:p1",
    terminal_id: "term_activity",
    agent: harness,
    agent_status: "working",
    title: "Activity fixture",
    cwd: root,
    agent_session: { source: `herdr:${harness}`, kind: "path", value: path },
  };
  const execute = async (args: readonly string[]) => {
    if (args[0] === "agent" && args[1] === "list") return JSON.stringify({ result: { agents: [row] } });
    if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: row } });
    if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [row] } });
    if (args[0] === "workspace" && args[1] === "list") return JSON.stringify({ result: { workspaces: [] } });
    throw new Error(`Unexpected native mutation: ${args.join(" ")}`);
  };
  const settings = new SettingsStore(join(root, "settings.json"));
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
      nativeHerdrRunner: createHerdrWatchRunner(() => true, execute, undefined, {
        localCodexRecovery: false,
      }),
      nativeCensusRunner: async (_command, args) => ({ stdout: await execute(args), stderr: "" }),
      nativeSummariesPath: join(root, "summaries.json"),
      seatAdapters: [],
      discordEnvironment: {},
      fleetRoundIntervalMs: 60 * 60_000,
    },
  );
  const service = await createClankieApp({
    captain,
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(root, "events.jsonl"),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-captain"
        ? { captainId: "fixture" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "fixture" } : undefined,
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server address");
  const host = `http://127.0.0.1:${address.port}`;
  let closed = false;
  const closeHost = async () => {
    if (closed) return;
    closed = true;
    (server as Server).closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    service.close();
    await captain.close();
  };
  cleanups.push(async () => {
    await closeHost();
    await rm(root, { recursive: true, force: true });
  });
  const post = async (body: unknown, token = "fixture-captain") => {
    const response = await fetch(`${host}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const read = async (op: "roster" | "fleet" = "roster") => {
    // A real agent self-read clears the one-second roster cache without making
    // or restating an activity; its null assignment is the existing clear op.
    await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "state_work",
      work: { herdrPaneId: row.pane_id, assignment: null },
    });
    const response = await post({ schemaVersion: 1, op });
    const seats =
      response.op === "roster" ? response.seats : response.op === "fleet" ? response.snapshot.seats : [];
    const old = parseProtocolResponse(oldSeatContract, seats[0]);
    expect(old).not.toHaveProperty("activity");
    if (old.stance) expect(old.stance).not.toHaveProperty("activityKind");
    return OperatorFleetSeatSchema.parse(seats[0]);
  };
  const start = async (name: string, callId = randomUUID(), at = new Date().toISOString(), extra = {}) => {
    await appendFile(
      path,
      line(
        harness === "codex"
          ? {
              timestamp: at,
              type: "response_item",
              payload: {
                type: "function_call",
                name,
                call_id: callId,
                arguments: JSON.stringify({ cmd: "pnpm test", note: "editing planning testing" }),
                ...extra,
              },
            }
          : {
              type: "assistant",
              uuid: randomUUID(),
              sessionId: id,
              timestamp: at,
              message: {
                role: "assistant",
                content: [{ type: "tool_use", id: callId, name, input: { note: "planning" } }],
              },
              ...extra,
            },
      ),
    );
    return callId;
  };
  const finish = async (callId: string, failed = false) =>
    appendFile(
      path,
      line(
        harness === "codex"
          ? {
              timestamp: new Date().toISOString(),
              type: "response_item",
              payload: { type: "function_call_output", call_id: callId, output: "done", is_error: failed },
            }
          : {
              type: "user",
              uuid: randomUUID(),
              sessionId: id,
              timestamp: new Date().toISOString(),
              message: {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: callId, content: "done", is_error: failed }],
              },
            },
      ),
    );
  const stance = async (kind: string, ttl = "60") =>
    runStanceCommand(["working", "--activity", kind, "--for", ttl], {
      host,
      env: {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: join(root, "fixture.sock"),
        HERDR_PANE_ID: row.pane_id,
        CLANKIE_CAPTAIN_TOKEN: "fixture-captain",
      },
      stdout: { write: () => true },
    });
  return { root, id, path, row, captain, host, post, read, start, finish, stance, closeHost };
}

for (const harness of ["codex", "claude"] as const)
  it(`carries real ${harness} tool lifecycle facts through roster and fleet schemas`, async () => {
    const f = await fixture(harness);
    expect(await f.read()).not.toHaveProperty("activity");
    for (const [name, kind] of [
      ["Read", "reading"],
      ["Edit", "editing"],
      ["build", "testing"],
      ["update_plan", "planning"],
      ["AskUserQuestion", "waiting"],
    ]) {
      const call = await f.start(name!);
      const seat = await f.read("fleet");
      expect(seat.activity).toMatchObject({ kind, source: "native_tool", toolName: name });
      expect(seat.activity).not.toHaveProperty("arguments");
      expect(
        safeParseProtocolResponse(OperatorFleetSeatSchema, {
          ...seat,
          activity: { ...seat.activity, kind: "invented" },
        }).success,
      ).toBe(false);
      await f.finish(call, kind === "testing");
      expect(await f.read()).not.toHaveProperty("activity");
    }
  });

it("does not classify shell arguments, prose, concurrent conflicts, stale tools or foreign sessions", async () => {
  const f = await fixture();
  const shell = await f.start("functions.exec_command");
  expect(await f.read()).not.toHaveProperty("activity");
  await f.finish(shell);
  const read = await f.start("functions.read_file"),
    edit = await f.start("functions.apply_patch");
  expect(await f.read()).not.toHaveProperty("activity");
  await f.finish(edit);
  expect((await f.read()).activity?.kind).toBe("reading");
  const unknown = await f.start("functions.exec");
  expect(await f.read()).not.toHaveProperty("activity");
  await f.finish(unknown);
  expect((await f.read()).activity?.kind).toBe("reading");
  await f.finish(read);
  await f.start("Read", randomUUID(), new Date(Date.now() - 6 * 60_000).toISOString());
  expect(await f.read()).not.toHaveProperty("activity");
  await appendFile(f.path, line({ type: "event_msg", payload: { type: "task_completed" } }));
  await f.start("Read", randomUUID(), new Date().toISOString(), { thread_id: randomUUID() });
  expect(await f.read()).not.toHaveProperty("activity");
});

it("stated CLI kinds expire, replace, clear and cannot follow a different occupant or a restarted host", async () => {
  const f = await fixture();
  await f.stance("testing", "0.4");
  expect((await f.read()).activity).toMatchObject({ kind: "testing", source: "stated" });
  await new Promise<void>((resolve) => setTimeout(resolve, 450));
  expect(await f.read()).not.toHaveProperty("activity");
  for (const kind of ["reading", "editing", "testing", "planning", "waiting"]) {
    await f.stance(kind);
    expect((await f.read()).activity).toMatchObject({ kind, source: "stated" });
  }
  await expect(f.stance("a guessed kind")).rejects.toThrow(/--activity takes/u);
  const invalid = await fetch(`${f.host}/operator/v1/dispatch`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-captain", "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: 1,
      op: "state_stance",
      stance: { herdrPaneId: f.row.pane_id, pose: "working", activityKind: "invented" },
    }),
  });
  expect(invalid.status).toBe(400);
  expect((await f.read()).activity?.kind).toBe("waiting");
  const native = await f.start("Read");
  expect((await f.read()).activity?.source).toBe("native_tool");
  await f.finish(native);
  expect((await f.read()).activity?.source).toBe("stated");
  f.row.agent_status = "idle";
  expect(await f.read()).not.toHaveProperty("activity");
  f.row.agent_status = "offline";
  expect(await f.read()).not.toHaveProperty("activity");
  f.row.agent_status = "working";
  const other = join(f.root, "replacement.jsonl");
  await writeFile(other, line({ type: "session_meta", payload: { id: randomUUID() } }));
  f.row.agent_session.value = other;
  expect(await f.read()).not.toHaveProperty("activity");
  await f.stance("testing");
  // Omitting activity on the next statement explicitly clears it.
  await f.post(
    { schemaVersion: 1, op: "state_stance", stance: { herdrPaneId: f.row.pane_id, pose: "working" } },
    "fixture-captain",
  );
  expect(await f.read()).not.toHaveProperty("activity");
  await f.stance("testing");
  expect((await f.read()).activity?.kind).toBe("testing");
  const occupant = (await f.read()).occupantId;
  await f.closeHost();
  const fresh = await fixture("codex", { root: f.root, id: f.id, path: f.row.agent_session.value });
  const restarted = await fresh.read();
  expect(restarted.occupantId).toBe(occupant);
  expect(restarted).not.toHaveProperty("activity");
});

it("turn boundaries, deleted transcripts, sidechains and unsupported harnesses cannot retain an observation", async () => {
  const f = await fixture();
  await f.start("Read");
  expect((await f.read()).activity?.kind).toBe("reading");
  for (const type of ["task_started", "turn_aborted", "turn_interrupted", "task_complete"]) {
    await appendFile(f.path, line({ type: "event_msg", payload: { type } }));
    expect(await f.read()).not.toHaveProperty("activity");
    await f.start("Read");
  }
  await rm(f.path);
  expect(await f.read()).not.toHaveProperty("activity");
  f.row.agent = "opencode" as "codex";
  f.row.agent_session.source = "herdr:opencode";
  expect(await f.read()).not.toHaveProperty("activity");
  const claude = await fixture("claude");
  await claude.start("Read", randomUUID(), new Date().toISOString(), { isSidechain: true });
  expect(await claude.read()).not.toHaveProperty("activity");
});
