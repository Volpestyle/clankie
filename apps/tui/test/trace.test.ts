import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, HandleMessageStreamEvent, SessionState } from "eve/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  processTraceStream,
  runHeadlessCaptainCommand,
  traceCaptainCursorPath,
} from "../bin/headless-captain.ts";
import {
  CAPTAIN_AGENT_NAME,
  CAPTAIN_AUTHORED_TOOL_NAMES,
  CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES,
  EVE_WORKFLOW_ID,
} from "../src/session/captain-identity.ts";
import { reportHerdrAgent, reportHerdrMetadata } from "../src/session/herdr-report.ts";
import { CaptainSessionCursorStore } from "../src/session/session-cursor.ts";
import { headlessCaptainCursorPath } from "../bin/headless-captain.ts";
import { renderTraceEvent, renderTraceEvents } from "../src/session/trace-renderer.ts";
import type { TraceCursor } from "../src/session/trace-types.ts";

const tempDirs: string[] = [];
const TEST_GENERATION = "b".repeat(64);
const SECRET = "Bearer super-secret-token-do-not-leak";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function captainInfo(): unknown {
  return {
    kind: "eve-agent-info",
    mode: "start",
    agent: {
      name: CAPTAIN_AGENT_NAME,
      agentRoot: "/captain/agent",
      appRoot: "/captain/app",
    },
    tools: {
      authored: CAPTAIN_AUTHORED_TOOL_NAMES.map((name) => ({ name })),
      available: CAPTAIN_AUTHORED_TOOL_NAMES.map((name) => ({ name })),
      disabledFramework: [...CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES],
    },
  };
}

function outputBuffer(): { readonly stream: { write(chunk: string): void }; readonly text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += chunk;
      },
    },
    text: () => output,
  };
}

function fakeClient(input: {
  readonly events?: readonly HandleMessageStreamEvent[];
  readonly streamImpl?: (signal: AbortSignal | undefined) => AsyncIterable<HandleMessageStreamEvent>;
  readonly onStream?: (state: SessionState, startIndex: number | undefined) => void;
}): Client {
  return {
    health: async () => ({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID }),
    info: async () => captainInfo(),
    session: (state: SessionState = { streamIndex: 0 }) => ({
      send: async () => ({
        continuationToken: "continuation-private",
        sessionId: state.sessionId ?? "trace-session",
      }),
      stream: (options?: { signal?: AbortSignal; startIndex?: number }) => {
        input.onStream?.(state, options?.startIndex);
        if (input.streamImpl !== undefined) return input.streamImpl(options?.signal);
        return (async function* () {
          for (const event of input.events ?? []) yield event;
        })();
      },
    }),
  } as unknown as Client;
}

async function stateEnv(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "clankie-trace-test-"));
  tempDirs.push(root);
  return { XDG_STATE_HOME: root };
}

async function writeServiceRecord(env: NodeJS.ProcessEnv, host: string): Promise<void> {
  const directory = join(env.XDG_STATE_HOME as string, "clankie");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "captain-eve-service.json"),
    `${JSON.stringify({
      version: 1,
      host,
      generation: TEST_GENERATION,
      pid: process.pid,
    })}\n`,
  );
}

async function seedHeadlessSession(env: NodeJS.ProcessEnv, sessionId = "trace-session"): Promise<void> {
  await new CaptainSessionCursorStore(headlessCaptainCursorPath(env)).write({
    version: 2,
    active: true,
    generation: TEST_GENERATION,
    sessionId,
    streamIndex: 0,
  });
}

const multiTurnEvents = [
  {
    type: "turn.started",
    data: { sequence: 0, turnId: "turn-1" },
  },
  {
    type: "reasoning.appended",
    data: {
      turnId: "turn-1",
      stepIndex: 0,
      reasoningDelta: "planning the next step",
      reasoningSoFar: "planning the next step",
    },
  },
  {
    type: "actions.requested",
    data: {
      sequence: 1,
      stepIndex: 0,
      turnId: "turn-1",
      actions: [
        {
          kind: "tool-call",
          callId: "call-1",
          toolName: "lookup_status",
          input: { query: "mission-1" },
        },
      ],
    },
  },
  {
    type: "action.result",
    data: {
      sequence: 2,
      stepIndex: 0,
      turnId: "turn-1",
      status: "completed",
      result: {
        kind: "tool-result",
        callId: "call-1",
        toolName: "lookup_status",
        output: { ok: true },
        isError: false,
      },
    },
  },
  {
    type: "session.waiting",
    data: { wait: "next-user-message" },
  },
  // Second turn continues without process exit.
  {
    type: "turn.started",
    data: { sequence: 1, turnId: "turn-2" },
  },
  {
    type: "reasoning.appended",
    data: {
      turnId: "turn-2",
      stepIndex: 0,
      reasoningDelta: "continuing after settle",
      reasoningSoFar: "continuing after settle",
    },
  },
  {
    type: "message.completed",
    data: { message: "done", sequence: 3, stepIndex: 0, turnId: "turn-2" },
  },
  {
    type: "session.waiting",
    data: { wait: "next-user-message" },
  },
] as unknown as HandleMessageStreamEvent[];

describe("trace renderer", () => {
  it("labels two interleaved typed lanes without inferring from prose", () => {
    const lines = renderTraceEvents(
      [
        {
          lane: "tui",
          event: {
            type: "reasoning.appended",
            data: {
              turnId: "t1",
              stepIndex: 0,
              reasoningDelta: "operator path",
              reasoningSoFar: "operator path",
            },
          } as HandleMessageStreamEvent,
        },
        {
          lane: "discord_voice",
          event: {
            type: "actions.requested",
            data: {
              sequence: 0,
              stepIndex: 0,
              turnId: "t2",
              actions: [
                {
                  kind: "tool-call",
                  callId: "v1",
                  toolName: "speak",
                  input: { text: "hello" },
                },
              ],
            },
          } as HandleMessageStreamEvent,
        },
        {
          lane: "tui",
          event: {
            type: "action.result",
            data: {
              sequence: 1,
              stepIndex: 0,
              turnId: "t1",
              status: "completed",
              result: {
                kind: "tool-result",
                callId: "c1",
                toolName: "plan",
                output: { ok: true },
                isError: false,
              },
            },
          } as HandleMessageStreamEvent,
        },
        {
          lane: "discord_voice",
          event: {
            type: "action.result",
            data: {
              sequence: 2,
              stepIndex: 0,
              turnId: "t2",
              status: "completed",
              result: {
                kind: "tool-result",
                callId: "v1",
                toolName: "speak",
                output: { spoken: true },
                isError: false,
              },
            },
          } as HandleMessageStreamEvent,
        },
      ],
      "human",
    );

    const joined = lines.join("\n");
    expect(joined).toContain("[tui] reasoning");
    expect(joined).toContain("[discord_voice] tool speak");
    expect(joined).toContain("[tui] tool-result plan");
    expect(joined).toContain("[discord_voice] tool-result speak");
    // Lane labels are structural tags, not scraped from the model text body alone.
    expect(joined.indexOf("[tui]")).toBeLessThan(joined.indexOf("[discord_voice]"));
  });

  it("redacts Authorization headers in tool input via the central sanitizer", () => {
    const lines = renderTraceEvent({
      lane: "tui",
      event: {
        type: "actions.requested",
        data: {
          sequence: 0,
          stepIndex: 0,
          turnId: "t",
          actions: [
            {
              kind: "tool-call",
              callId: "auth-call",
              toolName: "http_request",
              input: {
                headers: {
                  Authorization: SECRET,
                  "Content-Type": "application/json",
                },
              },
            },
          ],
        },
      } as HandleMessageStreamEvent,
    });

    const human = lines.map((line) => line.text).join("\n");
    const json = lines.map((line) => JSON.stringify(line.json)).join("\n");
    expect(human).not.toContain(SECRET);
    expect(json).not.toContain(SECRET);
    expect(human).toMatch(/\[REDACTED\]/i);
    expect(json).toMatch(/\[REDACTED\]/i);
    expect(human).toContain("http_request");
  });
});

describe("processTraceStream multi-turn continuity", () => {
  it("renders reasoning, tools, and results across consecutive turn boundaries without exiting", async () => {
    const stdout = outputBuffer();
    const checkpoints: TraceCursor[] = [];
    const cursor: TraceCursor = {
      version: 1,
      generation: TEST_GENERATION,
      sessionId: "trace-session",
      streamIndex: 0,
      lane: "tui",
      active: true,
    };

    const result = await processTraceStream({
      events: (async function* () {
        for (const event of multiTurnEvents) yield event;
      })(),
      cursor,
      mode: "human",
      write: (line) => {
        stdout.stream.write(line);
      },
      onCursor: async (next) => {
        checkpoints.push(next);
      },
    });

    expect(result.eventsSeen).toBe(multiTurnEvents.length);
    expect(result.hitBoundary).toBe(true);
    expect(result.cursor.streamIndex).toBe(multiTurnEvents.length);
    const text = stdout.text();
    expect(text).toContain("planning the next step");
    expect(text).toContain("lookup_status");
    expect(text).toContain("tool-result");
    expect(text).toContain("continuing after settle");
    expect(text).toContain("session.waiting");
    // Two turns, two waiting boundaries — process still returned after full stream.
    expect(text.match(/session\.waiting/g)?.length).toBe(2);
    // Checkpoints are identity-only.
    for (const checkpoint of checkpoints) {
      expect(Object.keys(checkpoint).sort()).toEqual(
        ["active", "generation", "lane", "sessionId", "streamIndex", "version"].sort(),
      );
      expect(JSON.stringify(checkpoint)).not.toContain("planning the next step");
      expect(JSON.stringify(checkpoint)).not.toContain("lookup_status");
      expect(JSON.stringify(checkpoint)).not.toContain("continuing after settle");
    }
  });
});

describe("clankie trace command", () => {
  it("streams multi-turn events, keeps identity-only checkpoint, and supports --json", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    await writeServiceRecord(env, host);
    await seedHeadlessSession(env);
    const stdout = outputBuffer();
    let observedStart: number | undefined;

    const exitCode = await runHeadlessCaptainCommand(["trace", "--json"], {
      repoRoot: "/repo",
      env,
      host,
      clientFactory: () =>
        fakeClient({
          events: multiTurnEvents,
          onStream: (_state, startIndex) => {
            observedStart = startIndex;
          },
        }),
      stdout: stdout.stream,
      traceOnce: true,
      sleepImpl: async () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(observedStart).toBe(0);
    const lines = stdout.text().trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { type?: string; lane?: string };
      expect(parsed.lane).toBe("tui");
      expect(typeof parsed.type).toBe("string");
    }
    expect(stdout.text()).toContain('"type":"reasoning.appended"');
    expect(stdout.text()).toContain('"type":"actions.requested"');
    expect(stdout.text()).toContain('"type":"action.result"');
    expect(stdout.text()).toContain('"type":"session.waiting"');

    const path = traceCaptainCursorPath(env);
    const checkpoint = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(checkpoint).toMatchObject({
      version: 1,
      generation: TEST_GENERATION,
      sessionId: "trace-session",
      streamIndex: multiTurnEvents.length,
      lane: "tui",
    });
    expect(Object.keys(checkpoint).sort()).toEqual(
      ["active", "generation", "lane", "sessionId", "streamIndex", "version"].sort(),
    );
    expect(JSON.stringify(checkpoint)).not.toContain("planning the next step");
    expect(JSON.stringify(checkpoint)).not.toContain(SECRET);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("redacts Authorization when rendering tool input on the live command path", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    await writeServiceRecord(env, host);
    await seedHeadlessSession(env);
    const stdout = outputBuffer();
    const events = [
      {
        type: "actions.requested",
        data: {
          sequence: 0,
          stepIndex: 0,
          turnId: "t",
          actions: [
            {
              kind: "tool-call",
              callId: "c",
              toolName: "fetch",
              input: { headers: { Authorization: SECRET } },
            },
          ],
        },
      },
      { type: "session.waiting", data: { wait: "next-user-message" } },
    ] as unknown as HandleMessageStreamEvent[];

    const exitCode = await runHeadlessCaptainCommand(["trace", "--json"], {
      repoRoot: "/repo",
      env,
      host,
      clientFactory: () => fakeClient({ events }),
      stdout: stdout.stream,
      traceOnce: true,
      sleepImpl: async () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stdout.text()).not.toContain(SECRET);
    expect(stdout.text()).toMatch(/\[REDACTED\]/i);
  });

  it("reports Herdr presence when HERDR_ENV=1 and is inert otherwise", async () => {
    const calls: string[][] = [];
    const runner = async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return { stdout: "", stderr: "" };
    };

    expect(
      await reportHerdrAgent("working", {
        env: {},
        runCommand: runner,
      }),
    ).toBe(false);
    expect(calls).toEqual([]);

    expect(
      await reportHerdrMetadata({
        env: { HERDR_ENV: "1", HERDR_PANE_ID: "wS:p1D" },
        runCommand: runner,
        title: "clankie trace",
      }),
    ).toBe(true);
    expect(
      await reportHerdrAgent("working", {
        env: { HERDR_ENV: "1", HERDR_PANE_ID: "wS:p1D" },
        runCommand: runner,
        message: "tracing",
      }),
    ).toBe(true);

    expect(calls[0]?.slice(0, 3)).toEqual(["pane", "report-metadata", "wS:p1D"]);
    expect(calls[1]?.slice(0, 3)).toEqual(["pane", "report-agent", "wS:p1D"]);
    expect(calls[1]).toContain("working");

    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    await writeServiceRecord(env, host);
    await seedHeadlessSession(env);
    const herdrCalls: string[][] = [];
    await runHeadlessCaptainCommand(["trace"], {
      repoRoot: "/repo",
      env: { ...env, HERDR_ENV: "1", HERDR_PANE_ID: "wS:p1D" },
      host,
      clientFactory: () =>
        fakeClient({
          events: [
            { type: "session.waiting", data: { wait: "next-user-message" } },
          ] as HandleMessageStreamEvent[],
        }),
      stdout: outputBuffer().stream,
      traceOnce: true,
      sleepImpl: async () => undefined,
      herdrRunCommand: async (_command, args) => {
        herdrCalls.push([...args]);
        return { stdout: "", stderr: "" };
      },
    });
    expect(herdrCalls.some((args) => args.includes("report-agent"))).toBe(true);
    expect(herdrCalls.some((args) => args.includes("report-metadata"))).toBe(true);

    const inertCalls: string[][] = [];
    await runHeadlessCaptainCommand(["trace"], {
      repoRoot: "/repo",
      env,
      host,
      clientFactory: () =>
        fakeClient({
          events: [
            { type: "session.waiting", data: { wait: "next-user-message" } },
          ] as HandleMessageStreamEvent[],
        }),
      stdout: outputBuffer().stream,
      traceOnce: true,
      sleepImpl: async () => undefined,
      herdrRunCommand: async (_command, args) => {
        inertCalls.push([...args]);
        return { stdout: "", stderr: "" };
      },
    });
    expect(inertCalls).toEqual([]);
  });

  it("accepts a typed --lane without inventing labels from model text", async () => {
    const env = await stateEnv();
    const host = "http://127.0.0.1:4321";
    await writeServiceRecord(env, host);
    await seedHeadlessSession(env);
    const stdout = outputBuffer();

    const exitCode = await runHeadlessCaptainCommand(["trace", "--lane", "gameplay", "--json"], {
      repoRoot: "/repo",
      env,
      host,
      clientFactory: () =>
        fakeClient({
          events: [
            {
              type: "reasoning.appended",
              data: {
                turnId: "g",
                stepIndex: 0,
                reasoningDelta: "this prose mentions tui and discord but is not the lane",
                reasoningSoFar: "this prose mentions tui and discord but is not the lane",
              },
            },
          ] as unknown as HandleMessageStreamEvent[],
        }),
      stdout: stdout.stream,
      traceOnce: true,
      sleepImpl: async () => undefined,
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.text().trim().split("\n")[0] ?? "{}") as { lane?: string };
    expect(parsed.lane).toBe("gameplay");
    const checkpoint = JSON.parse(await readFile(traceCaptainCursorPath(env), "utf8")) as { lane?: string };
    expect(checkpoint.lane).toBe("gameplay");
  });
});
