// #318: "in progress" means a live agent holds the issue now. The real captain (its Herdr
// census stood in, as in agent-work.test.ts), its real `state_work`, and the real work-item
// service over a real file tracker: the reads behind list_issues, the app's views and
// `clankie work list`, and `clankie metrics --issues`.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { WorkItem } from "@clankie/protocol";
import { writeConvention } from "@clankie/work-items";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import * as census from "../src/captain/herdr-census.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { createWorkItemsService, defaultRun } from "../src/work-items.ts";

const roots: string[] = [];
const scratch = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("counts an issue in progress only while a live agent holds it, and drops it when that agent closes", async () => {
  const root = scratch("clankie-in-progress-");
  const checkout = scratch("clankie-in-progress-repo-");
  const occupant = "019a0000-0000-7000-8000-000000000318";
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(census, "readSeatIdForHerdrPane").mockResolvedValue("seat");
  const worker = {
    seatId: "seat",
    paneId: "w1:p1",
    occupantId: occupant,
    subject: "seat",
    harness: "codex",
    status: "working",
    title: "Juniper",
    session: { kind: "id" as const, source: "herdr:codex", value: occupant },
  };
  const observed = vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [worker] });
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  const refresh = async () => {
    const result = await captain.serveOperatorConversation({
      op: "fleet",
      schemaVersion: 1,
      includeWork: true,
    });
    if (result.op !== "fleet") throw new Error("Expected a fleet");
    return result.snapshot;
  };
  const work = createWorkItemsService({
    stateDirectory: join(root, "work"),
    workspace: () => root,
    run: async () => {
      throw new Error("no git here");
    },
    liveHolders: () => captain.issueHolders!(),
  });
  const list = async (status?: WorkItem["status"][]) => {
    const result = await work.handle(
      { action: "list", repo: checkout, ...(status === undefined ? {} : { status }) },
      true,
    );
    if (!("items" in result)) throw new Error("Expected a list");
    return Object.fromEntries(result.items.map((item) => [item.title, item]));
  };
  const create = async (title: string, status: WorkItem["status"]) => {
    const result = await work.handle({ action: "create", repo: checkout, title, status }, true);
    if (!("item" in result)) throw new Error("Expected an item");
    return { repoId: result.repo.id, item: result.item };
  };
  const inProgress = async () => (await captain.readIssueMetrics({})).summary?.current.inProgressCount;
  try {
    await refresh();
    // The tracker says one issue is in progress, but nobody is working on it.
    const stale = await create("Claimed long ago", "in_progress");
    const { repoId, item: held } = await create("Being worked now", "todo");
    expect(await list()).toMatchObject({
      "Claimed long ago": { status: "todo", trackerStatus: "in_progress" },
      "Being worked now": { status: "todo" },
    });
    expect(await list()).not.toHaveProperty(["Claimed long ago", "heldBy"]);
    expect(await list(["in_progress"])).toEqual({});
    expect(await inProgress()).toBe(0);

    // A live worker states it is working on one issue.
    await captain.serveOperatorConversation({
      op: "state_work",
      schemaVersion: 1,
      work: {
        herdrPaneId: "w1:p1",
        assignment: { objective: "Ship it", issue: { repoId, itemId: held.id } },
      },
    });
    await refresh();
    expect(await list()).toMatchObject({
      "Claimed long ago": { status: "todo", trackerStatus: "in_progress" },
      "Being worked now": { status: "in_progress", trackerStatus: "todo", heldBy: ["seat"] },
    });
    expect(Object.keys(await list(["in_progress"]))).toEqual(["Being worked now"]);
    expect(Object.keys(await list(["todo"])).sort()).toEqual(["Claimed long ago"]);
    const shown = await work.handle({ action: "show", repo: checkout, id: held.id }, true);
    expect(shown).toMatchObject({ item: { status: "in_progress", heldBy: ["seat"] } });
    expect(await inProgress()).toBe(1);

    // The worker closes without a merge: its pane is gone from the fleet.
    observed.mockResolvedValue({ seats: [] });
    // Fleet reads are fresh for about a second; read again once that window has passed.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await refresh()).seats).toEqual([]);
    expect(await list()).toMatchObject({ "Being worked now": { status: "todo" } });
    expect(await list()).not.toHaveProperty(["Being worked now", "heldBy"]);
    expect(await list(["in_progress"])).toEqual({});
    expect(await inProgress()).toBe(0);
    expect(stale.item.status).toBe("in_progress");
  } finally {
    await captain.close();
  }
}, 30_000);

it("a hire whose brief closes an issue, and an open draft pull request that closes one, both hold it", async () => {
  const root = scratch("clankie-adoption-");
  // The hire's checkout: GitHub issues on fixture/pond, with that repo as its origin.
  const checkout = scratch("clankie-adoption-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/fixture/pond.git");
  await writeConvention(checkout, {
    schemaVersion: 1,
    decidedBy: "owner",
    decidedAt: "2026-11-02T00:00:00.000Z",
    backend: "github",
    github: { repo: "fixture/pond" },
  });
  // A local stand-in for GitHub's REST API: four open issues and three open pull requests.
  const issue = (number: number) => ({
    id: 9000 + number,
    number,
    title: `Issue ${String(number)}`,
    body: "",
    state: "open",
    labels: [],
    html_url: `https://github.com/fixture/pond/issues/${String(number)}`,
  });
  const pull = (number: number, draft: boolean, body: string) => ({
    number,
    draft,
    body,
    html_url: `https://github.com/fixture/pond/pull/${String(number)}`,
  });
  const github = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/repos/fixture/pond/issues")
      return void response.end(JSON.stringify([7, 8, 9, 10].map(issue)));
    if (request.method === "GET" && path === "/repos/fixture/pond/pulls")
      return void response.end(
        JSON.stringify([
          pull(20, true, "Before: it crashed.\n\nCloses #8"),
          pull(21, false, "Fixes #9"),
          pull(22, true, "Mentions #10 without closing it."),
        ]),
      );
    response.writeHead(404).end("{}");
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");

  const occupant = "019a0000-0000-7000-8000-000000000319";
  const worker = {
    seatId: "seat",
    paneId: "w1:p1",
    occupantId: occupant,
    subject: "seat",
    harness: "codex",
    status: "working",
    title: "Juniper",
    workingDirectory: checkout,
    session: { kind: "id" as const, source: "herdr:codex", value: occupant },
  } as const;
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(census, "readSeatIdForHerdrPane").mockResolvedValue("seat");
  const observed = vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  // The native launch is stood in; everything the captain records about the hire is real.
  vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(
    async (_seat, _subject, _brief, _resume, authority, adopt, flushAdoption) => {
      // As a real hire does, the native seat records the conversation that hired it.
      vi.spyOn(HerdrWatchStore.prototype, "nativeOwner").mockReturnValue(authority!.owner);
      const result = { outcome: "spawned", seat: worker } as const;
      adopt?.(result);
      await flushAdoption?.().catch(() => {});
      return result;
    },
  );
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  const work = createWorkItemsService({
    stateDirectory: join(root, "work"),
    workspace: () => root,
    run: defaultRun,
    githubToken: async () => "fixture-github-token",
    githubApiBase: `http://127.0.0.1:${String((github.address() as AddressInfo).port)}`,
    liveHolders: () => captain.issueHolders!(),
  });
  const list = async () => {
    const result = await work.handle({ action: "list", repo: checkout }, true);
    if (!("items" in result)) throw new Error(`Expected a list: ${JSON.stringify(result)}`);
    return Object.fromEntries(result.items.map((item) => [item.title, item]));
  };
  try {
    const hired = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "spawn_seat",
      conversationId: "global-default",
      seat: {
        schemaVersion: 1,
        harness: "codex",
        title: "Juniper",
        workingDirectory: checkout,
        readOnly: true,
      },
      brief: "The app crashes on launch. Find out why and fix it.\n\nCloses #7",
    });
    if (hired.op !== "spawn_seat" || hired.result.outcome !== "spawned")
      throw new Error(`hire failed: ${JSON.stringify(hired)}`);
    observed.mockResolvedValue({ seats: [worker] });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1, includeWork: true });

    expect(await list()).toMatchObject({
      // The hire never ran work-on: its brief named the issue, so it holds it.
      "Issue 7": { status: "in_progress", trackerStatus: "todo", heldBy: ["seat"] },
      // An open draft pull request closes it.
      "Issue 8": {
        status: "in_progress",
        trackerStatus: "todo",
        heldBy: ["https://github.com/fixture/pond/pull/20"],
      },
      // A ready pull request is in review, not being worked; a mention isn't a close.
      "Issue 9": { status: "todo" },
      "Issue 10": { status: "todo" },
    });
    expect(await list()).not.toHaveProperty(["Issue 9", "heldBy"]);
    expect(await list()).not.toHaveProperty(["Issue 10", "heldBy"]);
    expect((await captain.readIssueMetrics({})).summary?.current.inProgressCount).toBe(1);
  } finally {
    await captain.close();
    await new Promise<void>((done) => github.close(() => done()));
  }
}, 30_000);
