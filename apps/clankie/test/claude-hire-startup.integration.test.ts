import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createClaudeWorkerSeatAdapter, SeatHookLog } from "../src/captain/claude-worker-seat.ts";
import {
  createHerdrWatchRunner,
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";

const roots: string[] = [];
const stores: HerdrWatchStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Exercise the real adapter, native transcript parser and durable hire/owner journals.
// Native process discovery and startup are supplied at the existing runner seam;
// the separate manual native proof exercises the actual Claude TUI.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-hire-startup-"));
  roots.push(root);
  const sessionId = randomUUID();
  const path = join(root, `${sessionId}.jsonl`);
  await writeFile(path, "");
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_startup",
    agent: "claude",
    status: "idle",
    title: "worker",
    workingDirectory: root,
    session: { source: "herdr:claude", kind: "path", value: path },
  };
  const transcript = () => createHerdrWatchRunner().transcript!(agent);
  const hooks = new SeatHookLog(join(root, "hooks.json"));
  let sends = 0;
  const adapter = createClaudeWorkerSeatAdapter({
    consent: async () => ({ approved: true }),
    hooks,
    agent: async () => agent,
    transcript,
    mailbox: {
      bound: () => true,
      deliver: async () => {
        sends++;
        // Exact bridge ACK, but no native queue or user record: Marek/Juno's failure.
        return {
          outcome: "accepted",
          deliveryStage: "delivered",
          messageId: "seat-stdout-only",
          state: "queued",
        };
      },
    },
    trackerDeny: () => [],
    timing: { readyMs: 30, receiptMs: 30, pollMs: 1, firstTurnMs: 1 },
  });
  return { root, path, agent, sessionId, hooks, adapter, transcript, sends: () => sends };
}

it("does not convert an early bridge stdout ACK into a consumed native prompt, and never resends the brief", async () => {
  const f = await fixture();
  const started = await f.adapter.start(
    { harness: "claude", cwd: f.root, resumeSessionId: f.sessionId, brief: "resume brief" },
    {
      paneId: f.agent.paneId,
      run: async () => {
        throw new Error("No terminal fallback");
      },
      start: async () => {},
    },
  );
  expect(started).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("brief_delivery_unverified"),
  });
  expect(f.sends()).toBe(1);
  expect((await f.transcript())?.entries).toEqual([]);
});

it("takes the fresh brief through native startup once, even when the channel is already polling before a prompt receiver exists", async () => {
  const f = await fixture();
  const brief = "Native first prompt\nwith the whole body";
  let launches = 0;
  const result = await f.adapter.start(
    { harness: "claude", cwd: f.root, brief },
    {
      paneId: f.agent.paneId,
      run: async () => {
        throw new Error("No terminal fallback");
      },
      start: async (_harness, argv) => {
        launches++;
        // Native CLI startup owns prompt scheduling, rather than an early MCP notification.
        expect(argv.slice(-2)).toEqual(["--", brief]);
        await writeFile(
          f.path,
          JSON.stringify({
            type: "user",
            uuid: randomUUID(),
            parentUuid: null,
            timestamp: new Date().toISOString(),
            message: { role: "user", content: brief },
          }) + "\n",
        );
      },
    },
  );
  expect(result.outcome).toBe("started");
  expect(launches).toBe(1);
  expect(f.sends()).toBe(0);
  expect(
    (await f.transcript())?.entries.filter((entry) => entry.type === "message" && entry.role === "operator"),
  ).toHaveLength(1);
});

it.each([false, true])(
  "keeps a failed first turn owned, flags its hiring conversation and retains it across service replacement (launcher timeout: %s)",
  async (launchTimedOut) => {
    const f = await fixture();
    const owner = { conversationId: "hiring-lead" };
    const watchPath = join(f.root, "watch.json");
    const notices: { owner: unknown; pane: string; detail: string }[] = [];
    let launches = 0;
    let nativeBrief = "";
    const runner: HerdrWatchRunner = {
      createTab: async () => f.agent.paneId,
      startAgent: async ({ args }) => {
        launches++;
        nativeBrief = args!.at(-1)!;
        if (launchTimedOut) throw new Error("Native startup wait timed out after launch");
      },
      runInPane: async () => {
        throw new Error("No fallback");
      },
      get: async () => f.agent,
      resolveTerminal: async () => f.agent,
      list: async () => [f.agent],
      wait: () => new Promise(() => {}),
      transcript: f.transcript,
    };
    const open = () => {
      const store = new HerdrWatchStore(watchPath, {
        runner,
        seatAdapters: [f.adapter],
        validateOwner: async () => true,
        workerAccountsReport: async () => ({
          machine: "local",
          shell: "posix",
          observedAt: new Date().toISOString(),
          accounts: [
            {
              harness: "claude",
              label: "fixture",
              home: f.root,
              signedIn: true,
              usable: true,
              plan: "pro",
              headroom: 0.8,
              usage: {
                source: "claude-usage",
                observedAt: new Date().toISOString(),
                windows: [{ id: "week", label: "Week", usedPercent: 20 }],
              },
            },
          ],
        }),
      });
      stores.push(store);
      store.start(async (conversationId, detail) => {
        notices.push({ owner: { conversationId }, pane: f.agent.paneId, detail });
      });
      return store;
    };
    const store = open();
    const request = {
      schemaVersion: 1 as const,
      harness: "claude" as const,
      title: "Worker",
      workingDirectory: f.root,
      effort: "medium" as const,
      effortReason: "Verify native startup receipt and ownership boundaries.",
    };
    const result = await store.spawnSeat(request, undefined, "first brief", undefined, {
      owner,
      current: () => true,
      authorize: async () => true,
    });
    expect(result).toMatchObject({ outcome: "failed", deliveryStage: "uncertain" });
    expect(store.seatClaim(f.agent)).toEqual({ owner, hired: true });
    expect(notices).toMatchObject([
      { owner, pane: f.agent.paneId, detail: expect.stringContaining("first turn") },
    ]);
    const disk = JSON.parse(await readFile(`${watchPath}.owners.json`, "utf8"));
    expect(disk.hires).toHaveLength(1);
    expect(disk.hires[0]).toMatchObject({ seatId: f.agent.terminalId, startupFailure: expect.any(String) });
    store.close();
    const restored = open();
    expect(restored.seatClaim(f.agent)).toEqual({ owner, hired: true });
    expect(
      new HireOwners(`${watchPath}.owners.json`).startupFailure(
        f.agent.paneId,
        f.agent.terminalId,
        disk.hires[0].occupantId,
      ),
    ).toContain("first turn");
    const [shown] = await restored.withNativeStatus(
      [
        {
          seatId: f.agent.terminalId,
          occupantId: disk.hires[0].occupantId,
          personaId: `agent-${randomUUID()}`,
          harness: "claude",
          status: "idle",
          title: "worker",
        },
      ],
      [
        {
          seatId: f.agent.terminalId,
          occupantId: disk.hires[0].occupantId,
          paneId: f.agent.paneId,
          subject: "worker",
          harness: "claude",
          status: "idle",
          title: "worker",
          session: f.agent.session!,
        },
      ],
    );
    expect(shown?.summary).toContain("first turn");
    // Reconciliation reads the original. It must not start another native process or send a channel replacement.
    expect(
      await restored.spawnSeat(request, undefined, "first brief", undefined, {
        owner,
        current: () => true,
        authorize: async () => true,
      }),
    ).toMatchObject({ outcome: "failed", deliveryStage: "uncertain" });
    expect(f.sends()).toBe(0);
    expect(launches).toBe(1);
    // Slow native persistence weakens the receipt; it never authorizes a replay.
    await writeFile(
      f.path,
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        parentUuid: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: nativeBrief },
      }) + "\n",
    );
    expect(
      await restored.spawnSeat(request, undefined, "first brief", undefined, {
        owner,
        current: () => true,
        authorize: async () => true,
      }),
    ).toMatchObject({ outcome: "spawned", deliveryStage: "consumed" });
    expect(launches).toBe(1);
    expect(f.sends()).toBe(0);
    expect(
      new HireOwners(`${watchPath}.owners.json`).startupFailure(
        f.agent.paneId,
        f.agent.terminalId,
        disk.hires[0].occupantId,
      ),
    ).toBeUndefined();
    expect(
      restored.seatClaim({
        ...f.agent,
        session: { ...f.agent.session!, value: join(f.root, `${randomUUID()}.jsonl`) },
      }),
    ).toBeUndefined();
  },
);
