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
import { OperatorFleetSeatSchema } from "@clankie/protocol";
import { SeatEfficiencyStore } from "../src/captain/seat-efficiency.ts";
import {
  SeatIssueKeeper,
  liveSeatIssue,
  type SeatIssueTrackerScope,
} from "../src/captain/seat-issue-status.ts";
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

async function setup(
  humanOwners?: () => Promise<{ ownerUserIds: readonly string[]; ownerUserEmails: readonly string[] }>,
  requireAttribution = false,
) {
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
    requireAttribution,
    exitGraceMs: 60_000,
    ...(humanOwners ? { humanOwners } : {}),
  });
  const issue = (key: string) => provider.rows.issues!.find((row) => row.identifier === key)!;
  const comments = (key: string) =>
    provider.rows.comments!.filter((row) => row.issueId === issue(key).id).map((row) => String(row.body));
  return {
    keeper,
    host,
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

it("counts explicit human-owner assignments without a seat, preserving unknown and agent flags", async () => {
  const ownerId = "00000000-0000-4000-8000-000000000099";
  const { keeper, issue, provider } = await setup(async () => ({
    ownerUserIds: [ownerId],
    ownerUserEmails: ["owner@example.test"],
  }));
  issue("VUH-1383").assignee = { id: ownerId, name: "James Volpe", email: null };
  issue("VUH-1384").assignee = {
    id: "different-provider-id",
    name: "James Volpe",
    email: "OWNER@example.test",
  };
  // Matching a display name alone must not invent human ownership for Clankie or a worker.
  issue("VUH-1385").assignee = null;
  provider.rows.issues!.push({
    ...issue("VUH-1385"),
    id: "00000000-0000-4000-8000-000000000098",
    identifier: "VUH-1386",
    assignee: { id: "agent-id", name: "James Volpe", email: null },
  });
  const result = await keeper.dailyCheck(true);
  expect(result).toContain("- VUH-1385:");
  expect(result).toContain("- VUH-1386:");
  expect(result).not.toMatch(/- VUH-138[34]:/u);
  expect(provider.validationErrors).toEqual([]);
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

  expect(
    await keeper.closed({ seatId: "s2", reason: "hit its context limit", outcome: "paused" }),
  ).toMatchObject({
    intended: "Paused",
    status: "Todo",
  });
  expect(status("VUH-1384")).toBe("Todo");
  expect(comments("VUH-1384")[0]).toContain("intended Paused");

  // Once the owner adds the statuses, they are used by name.
  addStates();
  await keeper.observe([seat("s3", "Cy", "VUH-1385"), seat("s4", "Di", "VUH-1383")]);
  expect(
    await keeper.closed({ seatId: "s3", reason: "waiting on a device capture", outcome: "paused" }),
  ).toMatchObject({
    status: "Paused",
  });
  expect(status("VUH-1385")).toBe("Paused");
  expect(await keeper.closed({ seatId: "s4", reason: "proof pending", outcome: "verifying" })).toMatchObject({
    status: "Verifying",
  });
  expect(status("VUH-1383")).toBe("Verifying");
  expect(comments("VUH-1383").at(-1)).toBe("Di left: proof pending. Status: Verifying.");
  // A later pause never pulls an item back out of review (VUH-2920).
  await keeper.observe([seat("s5", "Ed", "VUH-1383")]);
  expect(await keeper.closed({ seatId: "s5", reason: "stopped", outcome: "paused" })).toMatchObject({
    intended: "Paused",
    status: "Verifying",
  });
  expect(status("VUH-1383")).toBe("Verifying");
  expect(comments("VUH-1383").at(-1)).toBe(
    "Ed left: stopped. Status kept: Verifying (asked Paused; it doesn't move an item back out of review).",
  );
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

it("uses current work, evidence-backed lead follow-ups and live native children across leads", async () => {
  const { keeper, advance, status } = await setup();
  const directory = await mkdtemp(join(tmpdir(), "issue-ownership-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new SeatEfficiencyStore(join(directory, "efficiency.json"));
  const owner = { conversationId: "remote-work-lead" };
  store.assign("remote-native-session", { owner, deliverable: "VUH-1383" });
  store.observe({ occupantId: "remote-native-session", seatId: "remote/seat", owner });
  const efficiency = store.review({
    occupantId: "remote-native-session",
    owner,
    deliverable: "VUH-1384",
    ownedIssues: ["VUH-1385"],
    evidence: "Lead assigned VUH-1384 as a follow-up and reports its child live on VUH-1385",
  });
  const remote = OperatorFleetSeatSchema.parse({
    seatId: "remote/seat",
    occupantId: "remote-native-session",
    personaId: "remote-worker",
    harness: "codex",
    title: "Remote worker",
    status: "working",
    fleet: "remote",
    efficiency,
  });
  await keeper.observe([
    liveSeatIssue({ ...remote, workerReportRouting: { source: "refused", reason: "authority_unavailable" } }),
  ]);
  expect(await keeper.dailyCheck(true)).toMatch(/- VUH-138[45]:/u);
  const oldNative = {
    objective: "Old assignment",
    issue: { repoId: "clankie", itemId: "VUH-1383" },
    updatedAt: "2026-10-09T12:00:00.000Z",
  };
  expect(liveSeatIssue({ ...remote, assignment: oldNative }).keys).toEqual(["VUH-1384"]);
  const assignedAt = efficiency.deliverableAssignedAt;
  store.assign("remote-native-session", { owner });
  expect(
    store.observe({ occupantId: "remote-native-session", seatId: "remote/seat", owner })
      .deliverableAssignedAt,
  ).toBe(assignedAt);
  await keeper.observe([liveSeatIssue(remote)]);
  expect(await keeper.dailyCheck(true)).toContain("- VUH-1383:");
  expect(await keeper.dailyCheck(true)).not.toMatch(/- VUH-138[45]:/u);

  // A native assignment supersedes a historical hire, without needing a captain adoption.
  expect(
    new SeatEfficiencyStore(join(directory, "efficiency.json")).observe({
      occupantId: "remote-native-session",
      seatId: "remote/seat",
      owner,
    }).ownedIssues,
  ).toEqual(["VUH-1385"]);
  store.review({ occupantId: "remote-native-session", owner, ownedIssues: [], evidence: "Child finished" });
  expect(
    store.observe({ occupantId: "remote-native-session", seatId: "remote/seat", owner }).ownedIssues,
  ).toEqual([]);
  expect(
    store.observe({
      occupantId: "remote-native-session",
      seatId: "remote/seat",
      owner: { conversationId: "new-lead" },
    }).ownedIssues,
  ).toBeUndefined();

  const native = OperatorFleetSeatSchema.parse({
    ...remote,
    efficiency: { ...efficiency, assignedDeliverable: "VUH-1383", ownedIssues: [] },
    assignment: {
      objective: "Deliver VUH-1384",
      issue: { repoId: "clankie", itemId: "VUH-1384" },
      updatedAt: new Date().toISOString(),
    },
    subagents: { running: 1, recent: [{ label: "Fix VUH-1385", status: "running" }] },
  });
  await keeper.observe([liveSeatIssue(native)]);
  expect(await keeper.dailyCheck(true)).not.toMatch(/- VUH-138[45]:/u);

  // Completion and ambiguous labels confer no ownership; ordinary mentions do not either.
  native.subagents = {
    running: 1,
    recent: [
      { label: "Fix VUH-1385", status: "done" },
      { label: "Compare VUH-1383 and VUH-1385", status: "running" },
    ],
  };
  native.summary = "Read about VUH-1385";
  await keeper.observe([liveSeatIssue(native)]);
  expect(await keeper.dailyCheck(true)).toContain("- VUH-1385:");

  await keeper.observe([]);
  advance(61_000);
  await keeper.observe([]);
  expect(status("VUH-1384")).toBe("Todo");
  expect(await keeper.dailyCheck(true)).toContain("- VUH-1385:");
  // Daily-only child ownership never authorizes changing that child's tracker status.
  expect(status("VUH-1385")).toBe("In Progress");
});

it.each([false, true])(
  "rechecks a live shared-issue successor before retirement during backoff (still unavailable=%s)",
  async (stillUnavailable) => {
    const f = await setup(undefined, true);
    let unavailable = false;
    let resolutions = 0;
    const scope: SeatIssueTrackerScope = {
      identity: "shared-proof-scope",
      backend: "linear",
      call: async (tool, args, requestPriority) => {
        const result = await f.host.call({
          lane: "operator",
          server: "linear",
          tool,
          arguments: args,
          resultMode: "data",
          requestPriority,
        });
        if (result.outcome !== "ok" || result.isError) throw Error("Fixture tracker refused");
        return JSON.parse(result.content);
      },
    };
    const a = {
      seatId: "a",
      occupantId: "occupant-a",
      title: "A",
      keys: ["VUH-1383"],
      attribution: { resolve: async () => scope },
    };
    const b = {
      seatId: "b",
      occupantId: "occupant-b",
      title: "B still working",
      keys: ["VUH-1383"],
      attribution: {
        resolve: async () => {
          resolutions++;
          if (unavailable) throw Error("Temporary attribution read failed");
          return scope;
        },
      },
    };
    expect(await f.keeper.observe([a, b])).toEqual([]);
    unavailable = true;
    expect(await f.keeper.observe([a, b])).toMatchObject([{ outcome: "failed" }]);
    unavailable = stillUnavailable;
    for (let tick = 0; tick < 100; tick++) {
      f.advance(200);
      expect(await f.keeper.observe([a, b])).toEqual([]);
    }
    expect(resolutions).toBe(2);
    // A failed/backed-off assignment cannot establish daily orphan absence.
    const dailyDuringBackoff = await f.keeper.dailyCheck(true);
    expect(resolutions).toBe(2);
    const result = await f.keeper.closed({
      seatId: "a",
      reason: "A finished; B continues",
      outcome: "done",
      evidence: "fixture completed proof",
    });
    expect(f.status("VUH-1383")).toBe("In Progress");
    expect(resolutions).toBe(3); // Retirement checks fresh despite roster backoff.
    expect(dailyDuringBackoff).toBeUndefined();
    if (stillUnavailable) {
      expect(result).toMatchObject({
        outcome: "failed",
        detail: expect.stringContaining("Temporary attribution"),
      });
      expect(f.comments("VUH-1383")).toEqual([]);
    } else {
      expect(result).toMatchObject({ outcome: "updated", intended: "In Progress", status: "In Progress" });
      expect(f.comments("VUH-1383")[0]).toContain("B still working");
    }
    unavailable = false;
    f.advance(10_000);
    expect(await f.keeper.observe([b])).toEqual([]);
    expect(resolutions).toBe(4);
    expect(f.status("VUH-1383")).toBe("In Progress");
    expect(await f.keeper.dailyCheck(true)).not.toContain("- VUH-1383:");
    // Recovery does not leave a stale conservative owner or block a real close.
    expect(
      await f.keeper.closed({
        seatId: "b",
        reason: "B also finished",
        outcome: "done",
        evidence: "fixture final proof",
      }),
    ).toMatchObject({ outcome: "updated", intended: "Done", status: "Done" });
    expect(f.status("VUH-1383")).toBe("Done");
    expect(f.provider.validationErrors).toEqual([]);
  },
);
