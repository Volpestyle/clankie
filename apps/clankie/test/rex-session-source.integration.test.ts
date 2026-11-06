import { afterEach, expect, it } from "vitest";
import {
  SessionRefusal,
  SessionSources,
  createRexSessionSource,
  type SessionSource,
} from "@clankie/agent-hosts/sessions";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { TRANSCRIPT_READ_REFUSED } from "../src/captain/agent-transcript-read.ts";
import { createRex } from "../src/captain/rex.ts";
import { fakeRex, type FakeRexState } from "./fixtures/fake-rex.ts";

// Rex's agents through the session seam (#963), end to end from the session source through
// Clankie's operator ops and his Rex adapter to a `rex` executable on PATH. Rex itself is
// never run: a fake `rex` replays Rex's documented JSON where it is documented and the
// adapter's guessed shapes where it isn't (see `fixtures/fake-rex.mjs`).

const S = "session:0a1b2c3d-0000-4000-8000-000000000001";
const AGENT = "block:0a1b2c3d-0000-4000-8000-0000000000a1";
const CLAUDE = "block:0a1b2c3d-0000-4000-8000-0000000000a2";
const WAITING = "block:0a1b2c3d-0000-4000-8000-0000000000a3";
const BUSY = "block:0a1b2c3d-0000-4000-8000-0000000000a4";
const SHELL = "block:0a1b2c3d-0000-4000-8000-0000000000a5";
const QUIET = "block:0a1b2c3d-0000-4000-8000-0000000000a6";
const FAILED = "block:0a1b2c3d-0000-4000-8000-0000000000a7";
const HIRE = "block:0a1b2c3d-0000-4000-8000-0000000000a8";
const BROWSER = "block:0a1b2c3d-0000-4000-8000-0000000000a9";
const T = "com.superlogical.terminal";
const id = (block: string) => `rex:${S.slice("session:".length)}/${block.slice("block:".length)}`;

function rexState(): FakeRexState {
  return {
    version: {
      rex_version: "0.0.1793299046-g2307b7",
      platform: "darwin_arm64",
      api_revision: 7,
      api_min_revision: 0,
    },
    sessions: [
      {
        session_id: S,
        label: "work",
        blocks: [
          {
            block_id: AGENT,
            label: "review",
            creator_name: T,
            records: [
              { state: "idle", app: "opencode", msg: Buffer.from("Reviewed x.rs").toString("base64") },
            ],
            foreground: { pid: 4101, name: "opencode", cwd: "file://mac/Users/me/src/api" },
            // The shell printed the owner's own text before the agent started.
            capture: "before=secret\nReviewed x.rs: two bugs",
            screen: "before=secret\nReviewed x.rs: two bugs",
            takes: true,
          },
          {
            block_id: CLAUDE,
            creator_name: T,
            records: [{ state: "idle", app: "claude-code" }],
            foreground: { pid: 4102, name: "claude" },
            capture: "owner shell work\nclaude says hi",
            screen: "claude says hi",
          },
          {
            block_id: WAITING,
            creator_name: T,
            records: [{ state: "blocked", kind: "permission", app: "codex" }],
            foreground: { pid: 4103, name: "codex" },
          },
          {
            block_id: BUSY,
            creator_name: T,
            records: [{ state: "working", app: "opencode" }],
            foreground: { pid: 4104, name: "opencode" },
          },
          // An agent that exited back to its shell keeps its last word; the shell in front says it's gone.
          {
            block_id: SHELL,
            creator_name: T,
            records: [{ state: "done", app: "opencode" }],
            foreground: { pid: 4105, name: "-zsh" },
            capture: "secret=1",
          },
          // A plain program that reports nothing.
          { block_id: QUIET, creator_name: T, records: [], foreground: { pid: 4106, name: "htop" } },
          {
            block_id: FAILED,
            creator_name: T,
            records: [{ state: "error", app: "aider" }],
            foreground: { pid: 4107, name: "aider" },
          },
          {
            block_id: HIRE,
            label: "clankie.seat/rex-1",
            creator_name: T,
            records: [{ state: "done", app: "opencode" }],
            foreground: { pid: 4108, name: "opencode" },
          },
          // A block of another kind is never an agent session.
          { block_id: BROWSER, creator_name: "com.superlogical.browser", records: [{ state: "idle" }] },
        ],
      },
    ],
  };
}

const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((rex) => rex.close()));
});

async function setUp(state: FakeRexState = rexState(), env: NodeJS.ProcessEnv = {}) {
  const rex = await fakeRex(state);
  opened.push(rex);
  const serve = createOperatorService({
    shutdown: new AbortController(),
    deps: {},
    personas: { ready: async () => {} },
    settingsStore: {},
    rex: createRex({
      env: { ...rex.env, ...env },
      confirmMs: 2_000,
      // No owner-started Claude Code session is ever proved here, so its transcript is never found.
      nativeSession: { birth: async () => undefined },
    }),
  } as unknown as CreateOperatorServiceContext);
  const source = createRexSessionSource({ dispatch: (request) => serve(request) }, { localMachine: "mac" });
  return { rex, source, layer: new SessionSources([source]) };
}

/** Another session app, so a missing or refused Rex is seen to leave the rest of the list alone. */
const other: SessionSource = {
  id: "other",
  list: async () => ({ sessions: [{ id: "a", source: "other", machine: "mac", canMessage: true }] }),
  read: async () => ({ id: "a", text: "" }),
  send: async () => ({ id: "a", status: "delivered", detail: "" }),
  open: async () => ({ id: "a", status: "opened", detail: "" }),
};

it("lists only Rex blocks with a live agent in them, in Clankie's states, and never starts or focuses Rex", async () => {
  const { rex, layer } = await setUp();
  const listed = await layer.list();
  expect(listed.notices).toBeUndefined();
  expect(listed.sessions).toEqual([
    {
      id: id(AGENT),
      source: "rex",
      harness: "opencode",
      machine: "mac",
      project: "api",
      workingDirectory: "/Users/me/src/api",
      status: "idle",
      title: "review",
      doing: "Reviewed x.rs",
      canMessage: true,
    },
    expect.objectContaining({
      id: id(CLAUDE),
      harness: "claude-code",
      status: "idle",
      title: "work",
      canMessage: true,
    }),
    expect.objectContaining({ id: id(WAITING), harness: "codex", status: "blocked", canMessage: false }),
    expect.objectContaining({ id: id(BUSY), status: "working", canMessage: true }),
    // An error is blocked on the owner, and says it errored.
    expect.objectContaining({
      id: id(FAILED),
      status: "blocked",
      doing: "Reported an error and stopped.",
      canMessage: false,
    }),
    expect.objectContaining({ id: id(HIRE), status: "done" }),
  ]);
  const calls = await rex.calls();
  // Every call refuses to start a server and names no server, so it reaches only this Mac's socket.
  for (const { argv } of calls) {
    expect(argv.slice(0, 3)).toEqual(["--autostart=false", "--timeout", "5s"]);
    expect(argv).not.toContain("-S");
  }
  // The API revision is checked before anything else; nothing ever runs, splits, focuses or opens.
  expect(calls[0]!.argv.slice(3)).toEqual(["api", "call", "server.version"]);
  const verbs = new Set(calls.map(({ argv }) => argv[3]));
  for (const forbidden of ["run", "split", "new", "focus", "do", "window", "zoom"])
    expect(verbs).not.toContain(forbidden);

  // Open never brings Rex forward, and asks Rex nothing.
  const before = calls.length;
  expect(await layer.open(id(AGENT))).toMatchObject({
    status: "unavailable",
    detail: expect.stringContaining("never brings Rex to the front"),
  });
  expect(await rex.calls()).toHaveLength(before);
});

it("reads only what a live agent showed, never a Claude Code screen, and never a shell", async () => {
  const { rex, layer } = await setUp();
  // The first read holds back everything the block held, the owner's text included (ADR 0307).
  const first = await layer.read(id(AGENT), 50);
  expect(first.text).not.toContain("before=secret");
  expect(first.note).toContain("Earlier screen hidden");
  await rex.update((state) => {
    const block = state.sessions[0]!.blocks[0]!;
    block.capture = `${block.capture}\nFixed both bugs`;
    block.screen = `${block.screen}\nFixed both bugs`;
  });
  const later = await layer.read(id(AGENT), 50);
  expect(later.text).toBe("Fixed both bugs");

  // Claude Code is read from its own transcript or not at all; its screen is never captured.
  await expect(layer.read(id(CLAUDE), 50)).rejects.toThrow(TRANSCRIPT_READ_REFUSED);
  // An agent that exited back to its shell, and a plain program, aren't read.
  await expect(layer.read(id(SHELL), 50)).rejects.toThrow(
    "No coding agent is running in that Rex block now.",
  );
  await expect(layer.read(id(QUIET), 50)).rejects.toThrow(SessionRefusal);
  const captured = (await rex.calls()).filter(({ argv }) => argv[3] === "capture").map(({ argv }) => argv[7]);
  expect(captured).toEqual([AGENT, AGENT]);
  // Anything that isn't a block id from the list is refused before Rex is asked.
  await expect(layer.read("rex:x/../../etc", 50)).rejects.toThrow("isn't a session id from the list");
});

it("sends one paste and Enter, says whether the agent took it, and never types around a failure", async () => {
  const { rex, layer } = await setUp();
  const message = "Fix the second bug.\nThen run the tests.";
  // An idle agent takes it and is seen working on the event stream.
  expect(await layer.send(id(AGENT), message)).toEqual({
    id: id(AGENT),
    status: "delivered",
    detail: "The agent took it and started working.",
  });
  const state = await rex.state();
  const agent = state.sessions[0]!.blocks.find((block) => block.block_id === AGENT)!;
  // Line breaks arrive inside one paste, not as Enters; Enter follows once.
  expect(agent.pasted).toEqual([message]);
  expect(agent.keys).toEqual(["enter"]);
  const calls = await rex.calls();
  const paste = calls.find(({ argv }) => argv.includes("block.event"))!;
  expect(paste.argv.slice(3)).toEqual(["api", "call", "block.event", "-"]);
  // The text goes on stdin, never on a command line another process could read.
  expect(paste.argv.join(" ")).not.toContain("Fix the second bug");
  expect(JSON.parse(paste.stdin)).toEqual({
    session_id: S,
    block_id: AGENT,
    event: { type: "paste", payload: { text: message } },
  });
  expect(calls.some(({ argv }) => argv[3] === "events" && argv.includes(S) && argv.includes("--json"))).toBe(
    true,
  );
  // `rex send` (raw typing) is never used.
  expect(calls.some(({ argv }) => argv[3] === "send")).toBe(false);

  // A working agent holds it until its turn ends.
  expect(await layer.send(id(BUSY), "Also check y.rs")).toMatchObject({ status: "queued" });
  // A prompt it waits on would be answered by text, so nothing goes in.
  const waiting = await layer.send(id(WAITING), "yes");
  expect(waiting).toMatchObject({
    status: "not_delivered",
    detail: expect.stringContaining("permission prompt"),
  });
  expect(await layer.send(id(FAILED), "retry")).toMatchObject({ status: "not_delivered" });
  expect(await layer.send(id(SHELL), "rm -rf /tmp/x")).toMatchObject({ status: "not_delivered" });
  const pastedTo = (await rex.calls())
    .filter(({ argv }) => argv.includes("block.event"))
    .map(({ stdin }) => (JSON.parse(stdin) as { block_id: string }).block_id);
  expect(pastedTo).toEqual([AGENT, BUSY]);

  // When Rex refuses the paste, nothing else is tried: no typing, no Enter.
  await rex.update((next) => {
    next.failPaste = true;
  });
  const keysBefore = (await rex.state()).sessions[0]!.blocks.find((block) => block.block_id === AGENT)!.keys;
  const refused = await layer.send(id(AGENT), "One more thing");
  expect(refused).toMatchObject({
    status: "not_delivered",
    detail: expect.stringContaining("Nothing was sent."),
  });
  const after = await rex.state();
  expect(after.sessions[0]!.blocks.find((block) => block.block_id === AGENT)!.keys).toEqual(keysBefore);
  expect((await rex.calls()).some(({ argv }) => argv[3] === "send")).toBe(false);

  // An agent that stays quiet after the message is unconfirmed, not delivered.
  await rex.update((next) => {
    next.failPaste = false;
    next.sessions[0]!.blocks.find((block) => block.block_id === CLAUDE)!.takes = false;
  });
  expect(await layer.send(id(CLAUDE), "Hello")).toMatchObject({ status: "unconfirmed" });
}, 20_000);

it("presses named keys in Rex's syntax and closes only a finished block Clankie started", async () => {
  const { rex, layer } = await setUp();
  expect(await layer.press(id(WAITING), ["down", "esc", "ctrl+c", "enter"])).toMatchObject({
    status: "pressed",
  });
  const waiting = (await rex.state()).sessions[0]!.blocks.find((block) => block.block_id === WAITING)!;
  expect(waiting.keys).toEqual(["down", "escape", "ctrl+c", "enter"]);
  // Not into a shell.
  expect(await layer.press(id(SHELL), ["enter"])).toMatchObject({ status: "unavailable" });

  // What the owner started in Rex stays open, idle or not.
  expect(await layer.close(id(AGENT))).toMatchObject({
    status: "refused",
    detail: expect.stringContaining("owner started"),
  });
  expect((await rex.calls()).some(({ argv }) => argv[3] === "block" && argv[4] === "close")).toBe(false);
  expect(await layer.close(id(HIRE))).toEqual({
    id: id(HIRE),
    status: "closed",
    detail: "Rex closed the block and the program in it.",
  });
  const close = (await rex.calls()).find(({ argv }) => argv[3] === "block" && argv[4] === "close")!;
  expect(close.argv.slice(3)).toEqual(["block", "close", "-s", S, HIRE]);
  expect((await layer.list()).sessions.map((session) => session.id)).not.toContain(id(HIRE));
});

it("leaves a missing, stopped, unsupported or remote Rex out of the list without failing the rest", async () => {
  // Not installed: no `rex` on PATH at all.
  const missing = createRex({ env: { PATH: "/nonexistent" } });
  expect(await missing.list()).toMatchObject({ status: "unavailable", reason: "missing" });

  // Installed but no server running: Rex exits 4 and Clankie starts nothing.
  const down = await setUp({ ...rexState(), down: true });
  expect((await new SessionSources([other, down.source]).list()).sessions.map((s) => s.id)).toEqual([
    "other:a",
  ]);
  expect((await new SessionSources([other, down.source]).list()).notices).toBeUndefined();

  // A Rex whose API revision this adapter wasn't built for, newer or older, lists nothing and says so.
  for (const version of [
    { rex_version: "0.2.0", api_revision: 9, api_min_revision: 8 },
    { rex_version: "0.0.1", api_revision: 6 },
    // A server from before revisions existed counts as revision 0.
    { rex_version: "0.0.0" },
  ]) {
    const old = await setUp({ ...rexState(), version });
    const listed = await new SessionSources([other, old.source]).list();
    expect(listed.sessions.map((s) => s.id)).toEqual(["other:a"]);
    expect(listed.notices).toEqual([expect.stringContaining("built for revision 7")]);
    // Nothing past the version check is asked, and nothing else goes in.
    expect((await old.rex.calls()).map(({ argv }) => argv.slice(3, 6).join(" "))).toEqual([
      "api call server.version",
    ]);
    expect(await old.layer.send(id(AGENT), "hi")).toMatchObject({ status: "not_delivered" });
  }

  // A Rex pointed at another machine, or at plain HTTP, is refused before Rex is run.
  for (const server of ["https://rex-mini.tail.ts.net", "http://127.0.0.1:7777", "studio"]) {
    const remote = await setUp(rexState(), { REX_SERVER: server });
    const listed = await new SessionSources([other, remote.source]).list();
    expect(listed.sessions.map((s) => s.id)).toEqual(["other:a"]);
    expect(listed.notices).toEqual([expect.stringContaining("only talks to the local Rex server")]);
    expect(await remote.rex.calls()).toEqual([]);
  }
  // This Mac's own socket is followed.
  const local = await setUp(rexState(), { REX_SERVER: "/tmp/rex-test.sock" });
  expect((await local.layer.list()).sessions).toHaveLength(6);
  expect((await local.rex.calls())[0]!.argv.slice(0, 5)).toEqual([
    "--autostart=false",
    "--timeout",
    "5s",
    "-S",
    "unix:///tmp/rex-test.sock",
  ]);
}, 30_000);
