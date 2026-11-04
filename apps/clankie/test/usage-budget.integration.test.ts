import { mintOperatorToken } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runAccountsCommand } from "../../tui/src/command/accounts.ts";
import type { OperatorFleetSeat } from "@clankie/protocol";
import { AccountBudgetNotices } from "../src/captain/account-allocation.ts";
import { budgetNoticeText } from "../src/captain/captain-fleet-rounds.ts";
import { createWorkerAccountsReader } from "../src/captain/harness-accounts.ts";
import { hireAdmissionChoice, hireAdmissionReport } from "../src/captain/hire-admission.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import { createWorkerAccountBudgetsRoutes } from "../src/worker-account-budgets-routes.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "pc.invalid", shell: "posix" } };
const WEEK = 10_080;

/** A fake usage source: the linked machine's account probe, answering whatever the plan reads now. */
function usageSource() {
  const plan = { usedPercent: 0, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86_400 };
  const shell = async () =>
    JSON.stringify({
      schemaVersion: 1,
      accounts: [
        {
          harness: "codex",
          label: "default",
          home: "/home/owner/.codex",
          nativeDefault: true,
          signedIn: true,
          identity: "owner@example.com",
          identityId: "user-owner",
          plan: "pro",
          limits: {
            primary: { used_percent: plan.usedPercent, window_minutes: WEEK, resets_at: plan.resetsAt },
            secondary: null,
            rate_limit_reached_type: null,
          },
        },
      ],
    });
  return { plan, shell };
}

it("a budget crossed mid-run warns, stops new hires, names the pause, and lifts with the plan window (#603)", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-usage-budget-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    execution: {
      connections: [
        { id: "pc", kind: "herdr", session: "default", ssh: pc.ssh, enabled: true, capabilities: ["code"] },
      ],
    },
  }));
  // The owner sets the budget through the CLI, against the real owner-only route.
  const token = mintOperatorToken();
  const routes = createWorkerAccountBudgetsRoutes(
    async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? true : "authentication_required",
    settings,
  );
  const client = {
    settings,
    env: { CLANKIE_OPERATOR_TOKEN: token },
    host: "http://clankie.test",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
      routes.fetch(new Request(String(url), init))) as typeof fetch,
  };
  expect(
    await runAccountsCommand(["budget", "codex", "default", "80%", "--machine", "pc"], client),
  ).toMatchObject({
    budgets: [{ machine: "pc", harness: "codex", label: "default", stopAtPercent: 80 }],
  });
  expect(
    (await routes.request("/v1/worker-accounts/budgets", { headers: { authorization: "Bearer other" } }))
      .status,
  ).toBe(401);
  await expect(
    runAccountsCommand(["budget", "codex", "default", "101", "--machine", "pc"], client),
  ).rejects.toThrow("Usage:");

  const usage = usageSource();
  const read = createWorkerAccountsReader({
    settings: () => settings.load(),
    fleet: async (id) => (id === "pc" ? pc : undefined),
    shell: () => usage.shell,
  });
  const notices = new AccountBudgetNotices();
  const round = async () => {
    const report = await read("pc", ["codex"]);
    const fresh = notices.pending(report);
    notices.delivered(fresh);
    const hire = (override = false) =>
      hireAdmissionChoice(
        hireAdmissionReport(report, undefined, [], Date.now(), override),
        "codex",
        undefined,
      );
    return { report, fresh, hire };
  };

  usage.plan.usedPercent = 60;
  let now = await round();
  expect(now.report.accounts[0]).toMatchObject({ budget: { stopAtPercent: 80 }, usable: true });
  expect(now.fresh).toEqual([]);
  expect(now.hire().account.aliases).toContain("default");

  // Ten points before the budget: one warning, hires still admitted.
  usage.plan.usedPercent = 72;
  now = await round();
  expect(now.fresh.map((notice) => notice.stage)).toEqual(["approaching"]);
  expect(now.fresh[0]!.text).toMatch(
    /Usage budget warning: Codex account default .* on pc is at 72%.*at 80%/u,
  );
  expect(now.hire().account.aliases).toContain("default");
  expect((await round()).fresh).toEqual([]);

  // Crossed mid-run: hires refuse (below the fixed 90% reserve), the lead is told to pause.
  usage.plan.usedPercent = 81;
  now = await round();
  expect(now.fresh.map((notice) => notice.stage)).toEqual(["reached"]);
  expect(now.fresh[0]!.text).toContain("stop at its next safe point");
  expect(now.fresh[0]!.text).toContain("report blocked, budget reached");
  expect(() => now.hire()).toThrow("usage budget reached (81% used; the owner stops new hires at 80%)");
  expect(now.hire(true).account.aliases).toContain("default");
  // The lead's wake names its seats on that account, which record the home label.
  const seat = (seatId: string, label: string, fleet = "pc") =>
    ({
      seatId,
      title: `work ${seatId}`,
      harness: "codex",
      fleet,
      account: { label, home: "/h" },
    }) as OperatorFleetSeat;
  const wake = budgetNoticeText(now.fresh[0]!, [
    seat("w1", "default"),
    seat("w2", "other"),
    seat("w3", "default", "box"),
  ]);
  expect(wake).toContain('Your seats on it: w1 (titled "work w1").');
  expect(budgetNoticeText(now.fresh[0]!, [seat("w2", "other")])).toContain("None of your seats run on it.");
  expect((await round()).fresh).toEqual([]);

  // The plan window resets: one resume notice, and hires are admitted again.
  usage.plan.usedPercent = 3;
  usage.plan.resetsAt += 7 * 86_400;
  now = await round();
  expect(now.fresh.map((notice) => notice.stage)).toEqual(["resumed"]);
  expect(now.fresh[0]!.text).toContain("work paused for its budget can resume");
  expect(now.hire().account.aliases).toContain("default");

  // Clearing the budget returns the account to the fixed reserve.
  await runAccountsCommand(["budget", "codex", "default", "off", "--machine", "pc"], client);
  expect((await settings.load()).workerAccountBudgets).toEqual([]);
  usage.plan.usedPercent = 85;
  now = await round();
  expect(now.report.accounts[0]!.budget).toBeUndefined();
  expect(now.hire().account.aliases).toContain("default");
});
