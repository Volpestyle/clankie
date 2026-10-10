import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { createAccounts } from "../src/accounts.ts";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { SeatIssueKeeper } from "../src/captain/seat-issue-status.ts";
import { createLinearApiProvider, TEAM_ID } from "./fixtures/linear-api-provider.ts";

/**
 * VUH-1990 across the real Linear API tracker adapter: a leaving seat's issue
 * moves to its next status by name, degrades while Verifying and Paused are
 * missing, and the daily check lists In Progress issues no live seat owns.
 */
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "seat-issue-status-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const provider = await createLinearApiProvider({ issueCount: 3 });
  cleanups.push(provider.close);
  const store = new FileCredentialStore(join(directory, "credentials.json"));
  const accounts = createAccounts({
    store,
    apps: async () => ({
      github: {},
      linear: {
        clientId: "registered-client",
        redirectUri: "https://gateway.test/account/connections/callback",
      },
    }),
    fetch: provider.fetch,
  });
  const start = await accounts.startLinear();
  if (!start.ok) throw new Error("Missing registered flow");
  if (!(await accounts.completeLinear(start.flowId, "good-code")).ok) throw new Error("Missing connection");
  const host = createMcpHost({
    credentials: store,
    settings: new SettingsStore(join(directory, "settings.json")),
    localTracker: createLocalTracker({ directory: join(directory, "tracker") }),
    linearApiTracker: createLinearApiTracker({ credentials: store, fetch: provider.fetch }),
    linearFetch: provider.fetch,
    logger: { info() {}, warn() {} },
  });
  cleanups.push(() => host.close());
  const team = { id: TEAM_ID, name: "Clankie", key: "VUH" };
  const state = (id: number, name: string, type: string) => ({
    id: `00000000-0000-4000-8000-0000000001${String(id).padStart(2, "0")}`,
    name,
    type,
    team,
  });
  const states = provider.rows.workflowStates!;
  states.push(state(1, "Todo", "unstarted"), state(2, "In Progress", "started"));
  const inProgress = states[2]!;
  for (const issue of provider.rows.issues!) issue.state = inProgress;
  let now = Date.parse("2026-10-09T12:00:00Z");
  const keeper = new SeatIssueKeeper(host, join(directory, "seat-issue-status.json"), {
    now: () => now,
    exitGraceMs: 60_000,
  });
  const issue = (key: string) => provider.rows.issues!.find((row) => row.identifier === key)!;
  const comments = (key: string) =>
    provider.rows.comments!.filter((row) => row.issueId === issue(key).id).map((row) => String(row.body));
  return {
    keeper,
    provider,
    issue,
    status: (key: string) => (issue(key).state as { name: string }).name,
    comments,
    addStates: () => states.push(state(3, "Verifying", "started"), state(4, "Paused", "started")),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const seat = (seatId: string, title: string, deliverable: string) => ({
  seatId,
  title,
  keys: [deliverable, undefined],
});

it("degrades to In Progress or Todo, naming the intended status, until Verifying and Paused exist", async () => {
  const { keeper, status, comments, addStates, provider } = await setup();
  await keeper.observe([seat("s1", "Ada", "VUH-1383"), seat("s2", "Bo", "VUH-1384")]);

  expect(
    await keeper.closed({ seatId: "s1", reason: "core change landed", outcome: "verifying" }),
  ).toMatchObject({ outcome: "updated", issue: "VUH-1383", intended: "Verifying", status: "In Progress" });
  expect(status("VUH-1383")).toBe("In Progress");
  expect(comments("VUH-1383")).toEqual([
    "Ada left: core change landed. Status: In Progress (intended Verifying; that status does not exist yet).",
  ]);

  expect(await keeper.closed({ seatId: "s2", reason: "hit its context limit" })).toMatchObject({
    intended: "Paused",
    status: "Todo",
  });
  expect(status("VUH-1384")).toBe("Todo");
  expect(comments("VUH-1384")[0]).toContain("intended Paused");

  // Once the owner adds the statuses, they are used by name.
  addStates();
  await keeper.observe([seat("s3", "Cy", "VUH-1385"), seat("s4", "Di", "VUH-1383")]);
  expect(await keeper.closed({ seatId: "s3", reason: "waiting on a device capture" })).toMatchObject({
    status: "Paused",
  });
  expect(status("VUH-1385")).toBe("Paused");
  expect(await keeper.closed({ seatId: "s4", reason: "proof pending", outcome: "verifying" })).toMatchObject({
    status: "Verifying",
  });
  expect(status("VUH-1383")).toBe("Verifying");
  expect(comments("VUH-1383").at(-1)).toBe("Di left: proof pending. Status: Verifying.");
  expect(provider.validationErrors).toEqual([]);
});

it("closes Done only with evidence and keeps In Progress for a named successor", async () => {
  const { keeper, status, comments } = await setup();
  await keeper.observe([seat("s1", "Ada", "VUH-1383"), seat("s2", "Bo", "VUH-1383 handoff")]);

  expect(await keeper.closed({ seatId: "s1", reason: "context limit, Bo continues" })).toMatchObject({
    intended: "In Progress",
    status: "In Progress",
  });
  expect(comments("VUH-1383")).toEqual([
    "Handed from Ada to Bo: context limit, Bo continues. Status: In Progress.",
  ]);

  expect(await keeper.closed({ seatId: "s2", reason: "landed", outcome: "done" })).toMatchObject({
    intended: "Verifying",
  });
  await keeper.observe([seat("s5", "Cy", "VUH-1383")]);
  expect(
    await keeper.closed({
      seatId: "s5",
      reason: "landed",
      outcome: "done",
      evidence: "abc1234, check:landing green",
    }),
  ).toMatchObject({ intended: "Done", status: "Done" });
  expect(status("VUH-1383")).toBe("Done");
  expect(comments("VUH-1383").at(-1)).toBe(
    "Cy left: landed. Evidence: abc1234, check:landing green. Status: Done.",
  );

  // A closed issue is never reopened by a later seat leaving.
  await keeper.observe([seat("s6", "Di", "VUH-1383")]);
  expect(await keeper.closed({ seatId: "s6", reason: "stray" })).toMatchObject({ outcome: "skipped" });
  expect(status("VUH-1383")).toBe("Done");
});

it("pauses an exited seat's issue after the grace period and resumes it when a seat returns", async () => {
  const { keeper, status, comments, advance } = await setup();
  await keeper.observe([seat("s1", "Ada", "VUH-1383")]);
  expect(await keeper.observe([])).toEqual([]);
  expect(status("VUH-1383")).toBe("In Progress");
  advance(61_000);
  expect(await keeper.observe([])).toMatchObject([{ outcome: "updated", issue: "VUH-1383", status: "Todo" }]);
  expect(comments("VUH-1383")[0]).toMatch(/^Ada left: its seat exited without a close\./u);

  expect(await keeper.observe([seat("s9", "Ada", "VUH-1383")])).toMatchObject([
    { outcome: "updated", status: "In Progress" },
  ]);
  expect(status("VUH-1383")).toBe("In Progress");
  expect(comments("VUH-1383").at(-1)).toBe("Ada is working on it again. Status: In Progress.");
});

it("lists In Progress issues with no live owning seat once a day", async () => {
  const { keeper, issue, provider, advance } = await setup();
  issue("VUH-1385").state = provider.rows.workflowStates!.find((row) => row.name === "Todo");
  await keeper.observe([seat("s1", "Ada", "VUH-1383")]);

  const text = await keeper.dailyCheck();
  expect(text).toContain("1 In Progress issue with no live owning seat");
  expect(text).toContain("- VUH-1384: Work item 2");
  expect(text).not.toContain("VUH-1383");
  expect(text).not.toContain("VUH-1385");
  expect(await keeper.dailyCheck()).toBeUndefined();
  advance(24 * 60 * 60 * 1000);
  expect(await keeper.dailyCheck()).toContain("VUH-1384");
});
