import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FleetCapacitySchema } from "@clankie/protocol";
import type { TrackerRequestBudgetReport } from "@clankie/protocol/tracker-request-budget";
import {
  createFleetCapacityReader,
  projectFleetCapacity,
  type FleetCapacityAccountSource,
} from "../src/app/fleet-capacity.ts";
import { UsageHistory } from "../src/app/usage-burn.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";

const SECRET_HOME = "/Users/james/.codex-secret";
const SECRET_EMAIL = "james@example.com";
const SECRET_KEY = "acct_live_secret";
const SECRET_CHATGPT = "chatgpt-secret";
const SECRET_BIN = "/opt/secret/heavy-bin";

const codex: FleetCapacityAccountSource = {
  harness: "codex",
  label: "volpestyle",
  home: SECRET_HOME,
  identity: SECRET_EMAIL,
  accountKey: SECRET_KEY,
  displayName: SECRET_EMAIL,
  chatgptAccountId: SECRET_CHATGPT,
  plan: "pro",
  tier: "plus",
  signedIn: true,
  headroom: 0.42,
  resetsAt: "2026-11-01T00:00:00.000Z",
  usable: true,
  usage: {
    source: "codex-rate-limits",
    observedAt: "2026-10-31T12:00:00.000Z",
    windows: [
      { id: "session", label: "Session", usedPercent: 58, resetsAt: "2026-10-31T17:00:00.000Z" },
      { id: "week", label: "Week", usedPercent: 10 },
    ],
  },
};

const claude: FleetCapacityAccountSource = {
  harness: "claude",
  label: "default",
  home: "/Users/james/.claude",
  signedIn: null,
  headroom: null,
  usable: false,
};

const prime: FleetCapacityAccountSource = {
  harness: "prime",
  label: "prime",
  signedIn: true,
  headroom: null,
  usable: true,
  spend: { today: { costUsd: 1.5, tokens: 100 }, week: { costUsd: 4, tokens: 900 } },
  sharesLimitsWith: { harness: "codex", label: "volpestyle" },
};

const tracker: TrackerRequestBudgetReport = {
  schemaVersion: 1,
  requestWindowMs: 3_600_000,
  writeWindowMs: 60_000,
  observedAt: 1,
  actors: [
    {
      actorId: "worker-1",
      name: "Ada",
      role: "worker",
      interactive: { requests: 2, requestLimit: 10, writes: 1, writeLimit: 4, retryAt: 50 },
      background: { requests: 0, requestLimit: 10, writes: 0, writeLimit: 4 },
      refusals: { role_not_allowed: 0, tracker_request_budget: 0 },
    },
  ],
};

it("reports known capacity and unknown where Clankie has no number, and drops secrets", () => {
  const capacity = projectFleetCapacity({
    observedAt: "2026-10-31T22:00:00.000Z",
    machines: [
      {
        machine: "local",
        accounts: [codex, claude, prime],
        unavailable: { pi: "Pi isn't installed" },
        allocation: {
          accounts: [
            { harness: "codex", label: "volpestyle", sparePerDay: 1.2 },
            { harness: "claude", label: "default", sparePerDay: null },
          ],
        },
      },
      { machine: "pc1", unread: true },
    ],
    leadSeatId: "term-lead",
    seats: [
      {
        seatId: "term-claude",
        harness: "claude",
        title: "Google stock price",
        machine: "Work Mac",
        account: { label: "default", home: SECRET_HOME },
        owner: { hired: true },
        efficiency: { contextTokens: 120_000 },
      },
      {
        seatId: "term-lead",
        harness: "codex",
        title: "lead",
        machine: "Work Mac",
        efficiency: { contextTokens: 0, contextPercent: 4 },
      },
      { seatId: "term-grok", harness: "grok", title: "grok" },
    ],
    heavy: {
      schemaVersion: 1,
      policy: {
        heavySlots: null,
        simulatorSlots: null,
        simulatorIdleMs: 600_000,
        maxLoadRatio: 1.5,
        minAvailableMemoryMb: 4096,
        minFreeDiskGb: 20,
        warnFreeDiskGb: 200,
        warnFreeDiskPercent: 10,
      },
      capacity: { heavySlots: 2, simulatorSlots: 1, used: 1 },
      pressure: { sampledAtMs: 1, loadRatio: 0.4, availableMemoryMb: 8000, healthy: true },
      leases: [
        {
          id: "lease-1",
          kind: "heavy",
          state: "running",
          pid: 4242,
          executable: SECRET_BIN,
          createdAtMs: 1,
          lastUsedAtMs: 1,
        },
      ],
      queue: [{ id: "q1", kind: "heavy", queuedAtMs: 1, executable: SECRET_BIN }],
    },
    tracker,
  });
  expect(FleetCapacitySchema.parse(capacity)).toEqual(capacity);
  expect(capacity.accounts.map((account) => account.account)).toEqual(["volpestyle", "default", "prime"]);
  expect(capacity.accounts[0]).toMatchObject({
    harness: "codex",
    plan: "pro",
    tier: "plus",
    signedIn: true,
    remaining: 0.42,
    resetsAt: "2026-11-01T00:00:00.000Z",
    sparePerDay: 1.2,
    usage: {
      source: "codex-rate-limits",
      windows: [
        { id: "session", usedPercent: 58, resetsAt: "2026-10-31T17:00:00.000Z" },
        { id: "week", usedPercent: 10, resetsAt: "unknown" },
      ],
    },
    spend: "unknown",
  });
  expect(capacity.accounts[1]).toMatchObject({
    signedIn: "unknown",
    remaining: "unknown",
    resetsAt: "unknown",
    sparePerDay: "unknown",
    usage: "unknown",
    spend: "unknown",
    usable: false,
  });
  expect(capacity.accounts[2]).toMatchObject({
    remaining: "unknown",
    spend: { todayCostUsd: 1.5, todayTokens: 100, weekCostUsd: 4, weekTokens: 900 },
    sharesLimitsWith: { harness: "codex", label: "volpestyle" },
  });
  expect(capacity.panes).toEqual([
    {
      agent: "term-claude",
      machine: "Work Mac",
      harness: "claude",
      account: "default",
      title: "Google stock price",
      contextTokens: 120_000,
      contextPercentOfWindow: "unknown",
      reviewBudgetTokens: 300_000,
    },
    {
      agent: "term-lead",
      machine: "Work Mac",
      harness: "codex",
      account: "unknown",
      title: "lead",
      contextTokens: 0,
      contextPercentOfWindow: 4,
      reviewBudgetTokens: 250_000,
    },
    {
      agent: "term-grok",
      machine: "unknown",
      harness: "grok",
      account: "unknown",
      title: "grok",
      contextTokens: "unknown",
      contextPercentOfWindow: "unknown",
      reviewBudgetTokens: "unknown",
    },
  ]);
  expect(capacity.heavy).toMatchObject({
    slots: 2,
    used: 1,
    remaining: 1,
    queued: 1,
    lightSlots: "unknown",
    lightUsed: "unknown",
    healthy: true,
    pressureReason: "unknown",
  });
  expect(capacity.tracker).toMatchObject({
    actors: [
      {
        actor: "Ada",
        role: "worker",
        interactive: { requests: 2, requestLimit: 10, refusing: true, retryAt: 50 },
        background: { requests: 0, refusing: false },
      },
    ],
  });
  expect(capacity.notices).toEqual(["pi on local: Pi isn't installed", "Accounts on pc1 couldn't be read."]);
  const json = JSON.stringify(capacity);
  for (const secret of [SECRET_HOME, SECRET_EMAIL, SECRET_KEY, SECRET_CHATGPT, SECRET_BIN, "4242"])
    expect(json).not.toContain(secret);
  expect(capacity.accounts.some((account) => account.harness === "grok")).toBe(false);
});

it("leaves heavy permits and tracker budgets unknown when Clankie has no snapshot", () => {
  const capacity = projectFleetCapacity({
    observedAt: "2026-10-31T22:00:00.000Z",
    machines: [],
    seats: [],
    heavy: { schemaVersion: 1, leaked: SECRET_KEY },
  });
  expect(capacity.heavy).toBe("unknown");
  expect(capacity.tracker).toBe("unknown");
  expect(capacity.reviewBudgets).toEqual({ leadTokens: 250_000, workerTokens: 300_000 });
  expect(JSON.stringify(capacity)).not.toContain(SECRET_KEY);
});

it("reports each account's burn rate from Clankie's own readings and this Mac's Claude transcripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-burn-"));
  try {
    const home = join(root, ".claude-james");
    const project = join(home, "projects", "-Users-james-dev-clankie");
    const worker = "11111111-2222-4333-8444-555555555555";
    const stranger = "99999999-8888-4777-8666-555555555555";
    const now = Date.now();
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const assistant = (id: string, minutesAgo: number, usage: Record<string, number>, sessionId = worker) =>
      JSON.stringify({
        type: "assistant",
        sessionId,
        timestamp: at(minutesAgo),
        uuid: `${id}-${minutesAgo}`,
        message: { id, model: "claude-opus", usage },
      });
    await mkdir(join(project, worker, "subagents"), { recursive: true });
    await writeFile(
      join(project, `${worker}.jsonl`),
      [
        JSON.stringify({ type: "user", sessionId: worker, timestamp: at(130), message: { content: "go" } }),
        // Older than an hour: not counted.
        assistant("msg_old", 90, { input_tokens: 999, output_tokens: 999 }),
        // One native message written as two content blocks counts once.
        assistant("msg_a", 40, {
          input_tokens: 10,
          output_tokens: 200,
          cache_creation_input_tokens: 3_000,
          cache_read_input_tokens: 50_000,
        }),
        assistant("msg_a", 40, {
          input_tokens: 10,
          output_tokens: 200,
          cache_creation_input_tokens: 3_000,
          cache_read_input_tokens: 50_000,
        }),
        assistant("msg_b", 5, { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 60_000 }),
        "not json",
      ].join("\n") + "\n",
    );
    await writeFile(
      join(project, worker, "subagents", "agent-a1.jsonl"),
      assistant("msg_sub", 10, { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 1_000 }) + "\n",
    );
    await writeFile(
      join(project, `${stranger}.jsonl`),
      assistant("msg_s", 20, { input_tokens: 2, output_tokens: 30 }, stranger) + "\n",
    );

    const historyPath = join(root, "state", "usage-history.json");
    let percent = 20;
    let observedAt = at(60);
    const account = (): FleetCapacityAccountSource => ({
      harness: "claude",
      label: "account-abc",
      home,
      identity: SECRET_EMAIL,
      tier: "default_claude_max_20x",
      plan: "max",
      signedIn: true,
      headroom: (100 - percent) / 100,
      usable: true,
      usage: {
        source: "claude-usage",
        observedAt,
        windows: [
          {
            id: "week",
            label: "Current week (all models)",
            usedPercent: percent,
            windowMinutes: 10_080,
            resetsAt: new Date(now + 48 * 3_600_000).toISOString(),
          },
        ],
      },
    });
    const read = (clock: number) =>
      createFleetCapacityReader({
        now: () => clock,
        settings: async () => ({
          execution: {
            connections: [{ id: "pc", enabled: true, ssh: { host: "pc" } }],
          },
        }),
        accounts: async (fleetId) => ({
          machine: fleetId ?? "local",
          // The same account read on a linked machine is one burn row.
          accounts: [account()],
        }),
        seats: async () => [
          {
            seatId: "herdr-core/t7",
            occupantId: occupantIdForHerdrSession({ source: "herdr:claude", kind: "id", value: worker }),
            harness: "claude",
            title: "Tamsin",
          },
        ],
        leadSeatId: () => undefined,
        heavy: () => undefined,
        tracker: () => undefined,
        history: new UsageHistory(historyPath),
      })();

    // The first reading has no earlier one to compare, so only the window's average is known.
    const first = await read(now - 60 * 60_000);
    expect(first.burn?.[0]?.windows[0]?.percentPerHour.recent).toBe("unknown");

    // An hour later, in a new process, the saved reading gives the recent pace.
    percent = 26;
    observedAt = at(0);
    const capacity = await read(now);
    expect(FleetCapacitySchema.parse(capacity)).toEqual(capacity);
    expect(capacity.burn).toHaveLength(1);
    const row = capacity.burn![0]!;
    expect(row).toMatchObject({
      harness: "claude",
      account: "account-abc",
      plan: "default_claude_max_20x",
      machines: ["local", "pc"],
    });
    const week = row.windows[0]!;
    expect(week.usedPercent).toBe(26);
    expect(week.percentPerHour.recent).toBe(6);
    expect(week.percentPerHour.recentOverMinutes).toBe(60);
    // 26% over the 120 hours the week has run is about 0.217%/h.
    expect(week.percentPerHour.windowAverage).toBeCloseTo(26 / 120, 2);
    // 74% left over 48 hours spends it all at 1.542%/h.
    expect(week.percentPerHour.toUseAllByReset).toBeCloseTo(74 / 48, 2);
    // At 6%/h the 74% left lasts about 12.3 hours, before the reset.
    expect(week.projectedUsedAtReset).toBeCloseTo(26 + 6 * 48, 0);
    expect(Date.parse(week.runsOutAt as string) - now).toBeCloseTo((74 / 6) * 3_600_000, -4);

    expect(row.lastHour).not.toBe("unknown");
    const lastHour = row.lastHour as Exclude<typeof row.lastHour, "unknown">;
    expect(lastHour.sessions).toBe(2);
    expect(lastHour.tokens).toEqual({ input: 18, output: 380, cacheWrite: 3_000, cacheRead: 111_000 });
    expect(lastHour.bySession).toEqual([
      {
        agent: "herdr-core/t7",
        title: "Tamsin",
        lastActiveAt: at(5),
        tokens: { input: 16, output: 350, cacheWrite: 3_000, cacheRead: 111_000 },
      },
      {
        agent: "unknown",
        lastActiveAt: at(20),
        tokens: { input: 2, output: 30, cacheWrite: 0, cacheRead: 0 },
      },
    ]);
    const json = JSON.stringify(capacity);
    for (const secret of [home, SECRET_EMAIL, worker, stranger]) expect(json).not.toContain(secret);
    expect(await readFile(historyPath, "utf8")).not.toContain(SECRET_EMAIL);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
