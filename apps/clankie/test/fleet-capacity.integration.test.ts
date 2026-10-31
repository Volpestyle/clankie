import { expect, it } from "vitest";
import { FleetCapacitySchema } from "@clankie/protocol";
import type { TrackerRequestBudgetReport } from "@clankie/protocol/tracker-request-budget";
import { projectFleetCapacity, type FleetCapacityAccountSource } from "../src/app/fleet-capacity.ts";

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
