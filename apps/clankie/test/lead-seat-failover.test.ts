import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { MachineWorkerAccounts, WorkerAccountStatus } from "../src/captain/harness-accounts.ts";
import { createLeadSeatFailover } from "../src/captain/lead-seat-failover.ts";
import type {
  LeadSeatLaunch,
  RelaunchLeadSeatInput,
  RelaunchLeadSeatResult,
} from "../src/captain/lead-seat-relaunch.ts";

// VUH-2273: on 2026-10-13 the lead seat sat on its weekly limit for 2.5 hours
// while another Claude account and Codex had room. A limited seat now moves to
// the account with the most headroom and back after the reset. The launcher
// (ADR 0271, tested on its own) is recorded here; the account records are
// shaped like this machine's report.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function account(overrides: Partial<WorkerAccountStatus> & Pick<WorkerAccountStatus, "harness" | "label">) {
  return {
    home: `/Users/james/.${overrides.harness}-${overrides.label}`,
    signedIn: true,
    headroom: 0.5,
    usable: true,
    ...overrides,
  } as WorkerAccountStatus;
}

function fixture(
  accounts: WorkerAccountStatus[],
  launch: LeadSeatLaunch | undefined = { harness: "claude" },
) {
  const root = mkdtempSync(join(tmpdir(), "lead-failover-"));
  roots.push(root);
  let now = Date.parse("2026-10-13T22:26:30Z");
  const calls: RelaunchLeadSeatInput[] = [];
  const results: RelaunchLeadSeatResult[] = [];
  const notices: string[] = [];
  const released: string[] = [];
  const report: MachineWorkerAccounts = {
    machine: "local",
    shell: "posix",
    observedAt: new Date(now).toISOString(),
    accounts,
  };
  const failover = createLeadSeatFailover({
    statePath: join(root, "lead-seat-failover.json"),
    launcher: {
      relaunchLeadSeat: async (input) => {
        calls.push(input);
        return (
          results.shift() ?? {
            outcome: "relaunched",
            receiptId: `receipt-${String(calls.length)}`,
            seatId: "term_lead",
            sessionId: `session-${String(calls.length)}`,
            launch: { harness: input.harness, ...(input.account ? { account: input.account } : {}) },
          }
        );
      },
      leadSeatLaunch: async () => launch,
    },
    accounts: async () => report,
    released: (id) => released.push(id),
    notice: (_id, text) => notices.push(text),
    now: () => now,
  });
  return {
    failover,
    calls,
    results,
    notices,
    released,
    root,
    setNow: (iso: string) => {
      now = Date.parse(iso);
    },
  };
}

const weekly = { window: "weekly" as const, until: Date.parse("2026-10-14T01:00:00Z") };

it("moves a limited lead seat to the other Claude account with the most room, then back after the reset", async () => {
  const f = fixture([
    account({ harness: "claude", label: "default", nativeDefault: true, headroom: 0 }),
    account({ harness: "claude", label: "cc", headroom: 0.2 }),
    account({ harness: "claude", label: "james", headroom: 0.9 }),
    account({ harness: "codex", label: "james", headroom: 1 }),
  ]);
  await f.failover.limited("global-default", weekly);
  expect(f.calls).toEqual([
    {
      conversationId: "global-default",
      harness: "claude",
      account: "james",
      home: "/Users/james/.claude-james",
      reason: "usage_limit",
      guards: { requireNoDraft: true, quietOwnerMs: 0, requireIdle: false },
    },
  ]);
  expect(f.released).toEqual(["global-default"]);
  expect(f.notices.at(-1)).toContain("moved it to claude (james) in the same pane");
  expect(f.failover.status("global-default")).toEqual({
    from: "claude",
    to: "claude (james)",
    window: "weekly",
    until: "2026-10-14T01:00:00.000Z",
  });

  // Not before the reset.
  await f.failover.failBack();
  expect(f.calls).toHaveLength(1);

  // After it: back to the original launch, waiting for a quiet owner and an idle seat.
  f.setNow("2026-10-14T01:05:00Z");
  f.results.push({ outcome: "refused", reason: "owner_active" });
  await f.failover.failBack();
  expect(f.calls.at(-1)).toEqual({
    conversationId: "global-default",
    harness: "claude",
    reason: "usage_limit_reset",
    guards: { requireNoDraft: true, quietOwnerMs: 15 * 60_000, requireIdle: true },
  });
  expect(f.failover.status("global-default")).toBeDefined();
  // A refused return tries again on the next check.
  await f.failover.failBack();
  expect(f.calls).toHaveLength(3);
  expect(f.failover.status("global-default")).toBeUndefined();
  expect(f.notices.at(-1)).toContain("moved your native seat back from claude (james) to claude");
});

it("moves to Codex when no other Claude account has room", async () => {
  const f = fixture(
    [
      account({ harness: "claude", label: "james", headroom: 0 }),
      account({ harness: "claude", label: "cc", signedIn: false }),
      account({ harness: "codex", label: "clankie-live", headroom: 0.4 }),
    ],
    { harness: "claude", account: "claude2", home: "/Users/james/.claude-james" },
  );
  await f.failover.limited("global-default", weekly);
  expect(f.calls[0]).toMatchObject({ harness: "codex", account: "clankie-live" });
});

it("leaves the conversation on the service lane when no account has room or the move is refused", async () => {
  const empty = fixture([account({ harness: "claude", label: "default", nativeDefault: true, headroom: 0 })]);
  await empty.failover.limited("global-default", weekly);
  expect(empty.calls).toEqual([]);
  expect(empty.notices.at(-1)).toContain("service lane runs this conversation");

  const refused = fixture([account({ harness: "claude", label: "james", headroom: 0.9 })]);
  refused.results.push({ outcome: "refused", reason: "draft" });
  await refused.failover.limited("global-default", weekly);
  expect(refused.released).toEqual([]);
  expect(refused.notices.at(-1)).toContain("couldn't move your native seat to claude (james) (draft)");
  expect(refused.failover.status("global-default")).toBeUndefined();
});

it("never retries an unconfirmed move", async () => {
  const f = fixture([account({ harness: "claude", label: "james", headroom: 0.9 })]);
  f.results.push({ outcome: "uncertain", receiptId: "relaunch-1", detail: "The new session did not bind." });
  await f.failover.limited("global-default", weekly);
  expect(f.failover.status("global-default")).toMatchObject({ uncertain: "relaunch-1" });
  await f.failover.limited("global-default", weekly);
  f.setNow("2026-10-14T02:00:00Z");
  await f.failover.failBack();
  expect(f.calls).toHaveLength(1);
  expect(f.notices.at(-1)).toContain("never retried automatically");
});
