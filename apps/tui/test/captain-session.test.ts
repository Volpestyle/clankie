import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, HandleMessageStreamEvent, SessionState } from "eve/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTAIN_AGENT_NAME,
  CAPTAIN_AUTHORED_TOOL_NAMES,
  CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES,
  EVE_WORKFLOW_ID,
} from "../src/session/captain-identity.ts";
import { EveCaptainSession } from "../src/session/eve-captain.ts";
import { EveFaceRenderer } from "../src/session/eve-renderer.ts";
import { CaptainSessionCursorStore, type CaptainSessionCursor } from "../src/session/session-cursor.ts";
import type { ClankieFaceShell, FaceBlockHandle } from "../src/shell/shell.ts";

const tempDirs: string[] = [];
const TEST_GENERATION = "a".repeat(64);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<{ path: string; store: CaptainSessionCursorStore }> {
  const root = await mkdtemp(join(tmpdir(), "captain-session-"));
  tempDirs.push(root);
  const path = join(root, "nested", "cursor.json");
  return { path, store: new CaptainSessionCursorStore(path) };
}

describe("CaptainSessionCursorStore", () => {
  it("writes the capability-like cursor atomically with private permissions", async () => {
    const { path, store } = await temporaryStore();
    const cursor: CaptainSessionCursor = {
      version: 2,
      active: true,
      generation: TEST_GENERATION,
      sessionId: "session-test",
      continuationToken: "continuation-secret",
      streamIndex: 7,
    };
    await store.write(cursor);
    await expect(store.read()).resolves.toEqual(cursor);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect(await readFile(path, "utf8")).toContain("continuation-secret");
    await store.clear();
    await expect(store.read()).resolves.toBeUndefined();
  });

  it("fails closed when a cursor exists but cannot be parsed safely", async () => {
    const { path, store } = await temporaryStore();
    await store.write(emptyCursorForTest());
    await writeFile(path, "{not-json\n", "utf8");
    await expect(store.read()).rejects.toThrow("refusing to start a new session");
  });
});

function emptyCursorForTest(): CaptainSessionCursor {
  return { version: 2, active: false, generation: TEST_GENERATION, streamIndex: 0 };
}

class TestBlock implements FaceBlockHandle {
  public markdown: string;
  public constructor(markdown: string) {
    this.markdown = markdown;
  }
  public remove(): void {}
  public setMarkdown(markdown: string): void {
    this.markdown = markdown;
  }
}

function testShell() {
  const blocks: TestBlock[] = [];
  const statuses: string[] = [];
  const shell = {
    insertMarkdown(markdown: string) {
      const block = new TestBlock(markdown);
      blocks.push(block);
      return block;
    },
    setTurnLoaderMessage() {},
    requestRender() {},
    refreshStatus(status: string) {
      statuses.push(status);
    },
  } as unknown as ClankieFaceShell;
  return { blocks, shell, statuses };
}

function turnEvents(prompt: string, turn: number): HandleMessageStreamEvent[] {
  const turnId = `turn-${turn}`;
  const sequence = turn * 10;
  return [
    ...(turn === 1 ? ([{ type: "session.started", data: {} }] as HandleMessageStreamEvent[]) : []),
    { type: "turn.started", data: { sequence, turnId } },
    { type: "message.received", data: { message: prompt, sequence: sequence + 1, turnId } },
    { type: "step.started", data: { sequence: sequence + 2, stepIndex: 0, turnId } },
    {
      type: "reasoning.appended",
      data: {
        reasoningDelta: "Checking",
        reasoningSoFar: "Checking",
        sequence: sequence + 3,
        stepIndex: 0,
        turnId,
      },
    },
    {
      type: "message.appended",
      data: {
        messageDelta: "Live ",
        messageSoFar: "Live ",
        sequence: sequence + 4,
        stepIndex: 0,
        turnId,
      },
    },
    {
      type: "message.appended",
      data: {
        messageDelta: `reply ${turn}`,
        messageSoFar: `Live reply ${turn}`,
        sequence: sequence + 5,
        stepIndex: 0,
        turnId,
      },
    },
    {
      type: "message.completed",
      data: {
        finishReason: "stop",
        message: `Live reply ${turn}`,
        sequence: sequence + 6,
        stepIndex: 0,
        turnId,
      },
    },
    {
      type: "step.completed",
      data: {
        finishReason: "stop",
        sequence: sequence + 7,
        stepIndex: 0,
        turnId,
        usage: { inputTokens: 100 * turn, outputTokens: 5 },
      },
    },
    { type: "turn.completed", data: { sequence: sequence + 8, turnId } },
    { type: "session.waiting", data: { continuationToken: `${turnId}-cont`, wait: "next-user-message" } },
  ];
}

function fakeClient(boundary: "waiting" | "completed" = "waiting") {
  const events: HandleMessageStreamEvent[] = [];
  const sent: string[] = [];
  const starts: number[] = [];
  const states: SessionState[] = [];
  const client = {
    health: () => Promise.resolve({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID }),
    info: () =>
      Promise.resolve({
        kind: "eve-agent-info",
        agent: { name: CAPTAIN_AGENT_NAME },
        tools: {
          authored: CAPTAIN_AUTHORED_TOOL_NAMES.map((name) => ({ name })),
          available: CAPTAIN_AUTHORED_TOOL_NAMES.map((name) => ({ name })),
          disabledFramework: [...CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES],
        },
      }),
    session(state: SessionState = { streamIndex: 0 }) {
      states.push(state);
      return {
        async send(input: string | { message?: string }) {
          const prompt = typeof input === "string" ? input : (input.message ?? "");
          sent.push(prompt);
          const nextEvents = turnEvents(prompt, sent.length);
          if (boundary === "completed") {
            nextEvents[nextEvents.length - 1] = {
              type: "session.completed",
              data: {},
            } as HandleMessageStreamEvent;
          }
          events.push(...nextEvents);
          return {
            sessionId: "session-live",
            continuationToken: sent.length === 1 ? "continuation-secret" : undefined,
          };
        },
        async *stream(options?: { startIndex?: number }) {
          const start = options?.startIndex ?? state.streamIndex;
          starts.push(start);
          for (const event of events.slice(start)) yield event;
        },
      };
    },
  } as unknown as Client;
  return { client, events, sent, starts, states };
}

describe("EveCaptainSession", () => {
  it("refuses a non-loopback captain even when constructed outside the launcher", () => {
    expect(
      () =>
        new EveCaptainSession({
          host: "https://captain.example.test",
          cursorStore: new CaptainSessionCursorStore("/unused"),
        }),
    ).toThrow("must use a loopback http URL");
  });

  it("streams real Eve events, continues the same session, and persists exact replay cursors", async () => {
    const { path, store } = await temporaryStore();
    const fake = fakeClient();
    const captain = new EveCaptainSession({
      host: "http://127.0.0.1:4321",
      cursorStore: store,
      client: fake.client,
      generation: TEST_GENERATION,
    });
    const view = testShell();
    captain.setContextWindowTokens(1_000);
    await captain.initialize();
    await captain.prompt("first", view.shell, new AbortController().signal);
    await captain.prompt("second", view.shell, new AbortController().signal);

    expect(fake.sent).toEqual(["first", "second"]);
    expect(fake.starts).toEqual([0, turnEvents("first", 1).length]);
    expect(view.blocks.map((block) => block.markdown).join("\n")).toContain("Live reply 1");
    expect(view.blocks.map((block) => block.markdown).join("\n")).toContain("Live reply 2");
    expect(view.blocks.map((block) => block.markdown).join("\n")).not.toContain("continuation-secret");
    expect(captain.tokenStatus).toContain("ctx 20%");
    expect(captain.hasActiveTurn).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      active: false,
      continuationToken: "continuation-secret",
      sessionId: "session-live",
      streamIndex: fake.events.length,
    });
  });

  it("preserves a completed session when the Eve client is configured to continue it", async () => {
    const { path, store } = await temporaryStore();
    const fake = fakeClient("completed");
    const captain = new EveCaptainSession({
      host: "http://127.0.0.1:4321",
      cursorStore: store,
      client: fake.client,
      generation: TEST_GENERATION,
    });
    await captain.initialize();
    await captain.prompt("first", testShell().shell, new AbortController().signal);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      active: false,
      sessionId: "session-live",
    });

    await captain.prompt("second", testShell().shell, new AbortController().signal);
    expect(fake.sent).toEqual(["first", "second"]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      active: false,
      sessionId: "session-live",
    });
  });

  it("replays every historical turn without regressing the cursor, then continues", async () => {
    const { path, store } = await temporaryStore();
    const fake = fakeClient();
    const first = new EveCaptainSession({
      host: "http://127.0.0.1:4321",
      cursorStore: store,
      client: fake.client,
      generation: TEST_GENERATION,
    });
    await first.initialize();
    await first.prompt("first", testShell().shell, new AbortController().signal);
    await first.prompt("second", testShell().shell, new AbortController().signal);
    const savedBeforeReplay = await readFile(path, "utf8");

    const restarted = new EveCaptainSession({
      host: "http://127.0.0.1:4321",
      cursorStore: store,
      client: fake.client,
      generation: TEST_GENERATION,
    });
    const replay = testShell();
    await restarted.initialize();
    await restarted.attach(replay.shell);
    const transcript = replay.blocks.map((block) => block.markdown).join("\n");
    expect(transcript.match(/Live reply 1/gu)).toHaveLength(1);
    expect(transcript.match(/Live reply 2/gu)).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe(savedBeforeReplay);

    await restarted.prompt("third", replay.shell, new AbortController().signal);
    expect(fake.sent).toEqual(["first", "second", "third"]);
    expect(fake.starts.at(-1)).toBe(turnEvents("first", 1).length + turnEvents("second", 2).length);
    expect(replay.blocks.map((block) => block.markdown).join("\n")).toContain("Live reply 3");
  });

  it("retires a settled cursor from an incompatible captain build before sending", async () => {
    const { path, store } = await temporaryStore();
    await store.write({
      version: 2,
      active: false,
      generation: "b".repeat(64),
      sessionId: "session-old-build",
      continuationToken: "old-continuation",
      streamIndex: 9,
    });
    const fake = fakeClient();
    const captain = new EveCaptainSession({
      host: "http://127.0.0.1:4321",
      cursorStore: store,
      client: fake.client,
      generation: TEST_GENERATION,
    });

    await captain.initialize();
    expect(captain.startupNotice).toContain("started a fresh conversation");
    await captain.prompt("fresh", testShell().shell, new AbortController().signal);

    expect(fake.sent).toEqual(["fresh"]);
    expect(fake.states.every((state) => state.sessionId !== "session-old-build")).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      generation: TEST_GENERATION,
      sessionId: "session-live",
      version: 2,
    });
  });

  it("migrates a settled legacy cursor without contacting its dev session", async () => {
    const { path, store } = await temporaryStore();
    await store.write(emptyCursorForTest());
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        active: false,
        sessionId: "legacy-dev-session",
        continuationToken: "legacy-continuation",
        streamIndex: 7,
      })}\n`,
      "utf8",
    );
    const fake = fakeClient();
    const captain = new EveCaptainSession({
      host: "http://127.0.0.1:4321",
      cursorStore: store,
      client: fake.client,
      generation: TEST_GENERATION,
    });

    await captain.initialize();
    expect(captain.startupNotice).toContain("started a fresh conversation");
    await captain.prompt("after-migration", testShell().shell, new AbortController().signal);
    expect(fake.sent).toEqual(["after-migration"]);
    expect(fake.states.every((state) => state.sessionId !== "legacy-dev-session")).toBe(true);
  });

  it("blocks an active cursor from an incompatible build until /new explicitly abandons it", async () => {
    const { store } = await temporaryStore();
    await store.write({
      version: 2,
      active: true,
      generation: "b".repeat(64),
      sessionId: "session-active-old-build",
      continuationToken: "old-active-continuation",
      streamIndex: 4,
    });
    const fake = fakeClient();
    const captain = new EveCaptainSession({
      host: "http://127.0.0.1:4321",
      cursorStore: store,
      client: fake.client,
      generation: TEST_GENERATION,
    });

    await captain.initialize();
    expect(captain.startupNotice).toContain("may still be active");
    await expect(
      captain.prompt("must-not-send", testShell().shell, new AbortController().signal),
    ).rejects.toThrow("may have produced mission side effects");
    expect(fake.sent).toEqual([]);

    await captain.newSession();
    await captain.prompt("explicitly-fresh", testShell().shell, new AbortController().signal);
    expect(fake.sent).toEqual(["explicitly-fresh"]);
  });
});

describe("EveFaceRenderer", () => {
  it("strips terminal controls from event-controlled identifiers", () => {
    const view = testShell();
    const renderer = new EveFaceRenderer(view.shell);
    const unsafeId = "call\u001B]52;c;payload\u0007\u009B31m";
    renderer.render({
      type: "actions.requested",
      data: {
        actions: [{ kind: "tool-call", callId: unsafeId, toolName: "tool\u009Dtitle\u0007", input: {} }],
      },
    } as unknown as HandleMessageStreamEvent);
    renderer.render({
      type: "subagent.called",
      data: { name: "helper", childSessionId: "child\u001B[31m\u009B" },
    } as unknown as HandleMessageStreamEvent);

    const transcript = view.blocks.map((block) => block.markdown).join("\n");
    expect(
      Array.from(transcript).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code === 27 || (code >= 127 && code <= 159);
      }),
    ).toBe(false);
  });
});
