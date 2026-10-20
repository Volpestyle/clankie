import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
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

async function nativeBriefRecords(prompt: string) {
  const path = prompt.split("@").at(-1)!;
  const content = await readFile(path, "utf8");
  const userId = randomUUID();
  return [
    { type: "user", uuid: userId, parentUuid: null, message: { role: "user", content: prompt } },
    {
      type: "attachment",
      uuid: randomUUID(),
      parentUuid: userId,
      attachment: {
        type: "file",
        filename: path,
        content: {
          type: "text",
          file: {
            filePath: path,
            content,
            numLines: 1,
            startLine: 1,
            totalLines: 1,
          },
        },
      },
    },
  ];
}

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
  const brief = "Native first prompt\nwith `backticks`, \"quotes\", 'quotes', $HOME, → 🙂\n".repeat(120);
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
        expect(argv.at(-1)).not.toContain(brief);
        expect(argv.at(-1)).not.toMatch(/[\p{Cc}]/u);
        const path = argv.at(-1)!.split("@").at(-1)!;
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ clankieBrief: brief });
        await writeFile(
          f.path,
          (await nativeBriefRecords(argv.at(-1)!)).map((row) => JSON.stringify(row)).join("\n") + "\n",
        );
      },
    },
  );
  expect(result.outcome).toBe("started");
  expect(launches).toBe(1);
  expect(f.sends()).toBe(0);
  expect(
    (await f.transcript())?.entries.filter(
      (entry) => entry.type === "message" && entry.role === "operator" && entry.text === brief,
    ),
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
    let absent = false;
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
      get: async () => {
        if (absent) throw new Error("pane absent");
        return f.agent;
      },
      resolveTerminal: async () => (absent ? undefined : f.agent),
      list: async () => (absent ? [] : [f.agent]),
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
    expect(result).toMatchObject({
      outcome: "failed",
      deliveryStage: "uncertain",
      receiptId: expect.any(String),
    });
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
    absent = true;
    expect(
      await restored.spawnSeat(request, undefined, "first brief", undefined, {
        owner,
        current: () => true,
        authorize: async () => true,
      }),
    ).toMatchObject({
      outcome: "failed",
      deliveryStage: "uncertain",
      receiptId: result.outcome === "failed" ? result.receiptId : undefined,
    });
    expect(launches).toBe(1);
    absent = false;
    // Slow native persistence weakens the receipt; it never authorizes a replay.
    await writeFile(
      f.path,
      (await nativeBriefRecords(nativeBrief)).map((row) => JSON.stringify(row)).join("\n") + "\n",
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

it("does not count a startup file reference, a truncated file or changed contents as brief acceptance", async () => {
  for (const kind of ["reference-only", "truncated", "changed"] as const) {
    const f = await fixture();
    let launches = 0;
    const result = await f.adapter.start(
      { harness: "claude", cwd: f.root, brief: "expected\n`$→`" },
      {
        paneId: f.agent.paneId,
        run: async () => {
          throw new Error("No fallback");
        },
        start: async (_, argv) => {
          launches++;
          const rows = await nativeBriefRecords(argv.at(-1)!);
          if (kind === "reference-only") rows.pop();
          else {
            const file = rows[1]!.attachment!.content.file;
            if (kind === "truncated") file.totalLines = 2;
            else file.content = JSON.stringify({ clankieBrief: "different brief" });
          }
          await writeFile(f.path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
        },
      },
    );
    expect(result).toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("brief_delivery_unverified"),
    });
    expect(launches).toBe(1);
    expect(f.sends()).toBe(0);
  }
});

it("settles a legacy pane-absent failed start by allocation ID and releases it without replay", async () => {
  const { DeliveryFence, deliveryFingerprint } = await import("../src/captain/delivery-fence.ts");
  const { ProjectHires } = await import("../src/captain/project-hires.ts");
  const { ProjectsSettingsSchema } = await import("@clankie/protocol/projects");
  const f = await fixture();
  const path = join(f.root, "recovery-watch.json");
  const ledger = new ProjectHires(`${path}.project-hires.json`);
  const settings = ProjectsSettingsSchema.parse({ projects: [{ id: "clankie", name: "Clankie" }] });
  const allocation = ledger.reserve(settings, "clankie", {
    schemaVersion: 1,
    harness: "claude",
    title: "Legacy refused launch",
    workingDirectory: f.root,
  });
  ledger.launch(allocation.id, settings);
  ledger.pane(allocation.id, f.agent.paneId);
  const key = JSON.stringify(["local", "claude", f.root, "new"]);
  const original = new DeliveryFence(`${path}.hire-receipts.json`).begin(key, {
    fingerprint: deliveryFingerprint("old brief"),
    paneId: f.agent.paneId,
    beforeIds: [],
  });
  let inventory: HerdrAgentSnapshot[] = [f.agent];
  let censuses = 0;
  const open = () => {
    const store = new HerdrWatchStore(path, {
      runner: {
        get: async () => {
          throw new Error("pane absent");
        },
        resolveTerminal: async () => undefined,
        wait: async () => {
          throw new Error("pane absent");
        },
        list: async () => {
          censuses++;
          return inventory;
        },
        paneShell: async () => {
          throw new Error("Absent panes need no process fallback");
        },
      },
    });
    stores.push(store);
    return store;
  };
  const store = open();
  expect(await store.settleHireReceipt(allocation.id, async () => {}, "release-allocation")).toMatchObject({
    state: "refused",
  });
  expect(await store.settleHireReceipt(allocation.id, async () => {}, "abandoned")).toMatchObject({
    state: "refused",
  });
  inventory = [];
  expect(await store.settleHireReceipt(allocation.id, async () => {}, "abandoned")).toMatchObject({
    state: "abandoned",
    receiptId: original.messageId,
    evidence: { journal: "local-host-inventory", pane: { paneId: f.agent.paneId, present: false } },
  });
  store.close();
  const restored = open();
  expect(await restored.settleHireReceipt(original.messageId, async () => {}, "abandoned")).toMatchObject({
    state: "abandoned",
  });
  expect(await restored.settleHireReceipt(allocation.id, async () => {}, "release-allocation")).toMatchObject(
    { state: "allocation-released" },
  );
  expect(censuses).toBeGreaterThanOrEqual(4);
  expect(new ProjectHires(`${path}.project-hires.json`).recoveryCandidate(allocation.id)).toMatchObject({
    gone: true,
    operatorRelease: expect.any(Object),
  });
});
