// #541: an open draft pull request that closes an issue holds it (#318). When that draft
// closes unmerged and nothing else holds the issue, the tracker's In Progress goes back to
// Todo, through the same gated work update as Clankie's own (ADR 0302; Watch, ADR 0308).
// The real work-item service and GitHub backend talk to a local stand-in for GitHub's
// REST API; the real posting gate admits the write.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { writeConvention } from "@clankie/work-items";
import { createTrackerPosting } from "../src/tracker-posting.ts";
import { createWorkItemsService, defaultRun } from "../src/work-items.ts";

const roots: string[] = [];
const scratch = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const IN_PROGRESS = "status: in progress";

it("puts an issue back to Todo when the draft pull request holding it closes unmerged", async () => {
  const root = scratch("clankie-draft-close-");
  const checkout = scratch("clankie-draft-close-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: checkout, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", "https://github.com/fixture/pond.git");
  await writeConvention(checkout, {
    schemaVersion: 1,
    decidedBy: "owner",
    decidedAt: "2026-11-03T00:00:00.000Z",
    backend: "github",
    github: { repo: "fixture/pond" },
  });

  // The stand-in forge: issues the tracker calls in progress, and the drafts closing them.
  const issues = new Map(
    [8, 9, 11, 12, 13].map((number) => [
      number,
      {
        id: 9000 + number,
        number,
        title: `Issue ${String(number)}`,
        body: "",
        state: "open",
        labels: [{ name: IN_PROGRESS }],
        html_url: `https://github.com/fixture/pond/issues/${String(number)}`,
      },
    ]),
  );
  const pulls = new Map(
    [
      // #20 will close unmerged with nobody else on #8.
      { number: 20, body: "Closes #8" },
      // #22 will close unmerged too, but #21 is still a draft on #9.
      { number: 21, body: "Fixes #9" },
      { number: 22, body: "Closes #9" },
      // #23 will merge: GitHub closes #11 itself.
      { number: 23, body: "Closes #11" },
      // #24 will close unmerged while Watch is on.
      { number: 24, body: "Closes #12" },
      // An outsider's draft from a fork names #13: it must never hold it, nor requeue it.
      { number: 25, body: "Closes #13", fork: "outsider/pond", association: "NONE" },
    ].map(({ number, body, fork, association }) => [
      number,
      {
        number,
        body,
        draft: true,
        state: "open",
        merged: false,
        author_association: association ?? "MEMBER",
        head: { repo: { full_name: fork ?? "fixture/pond" } },
        html_url: `https://github.com/fixture/pond/pull/${String(number)}`,
      },
    ]),
  );
  const patches: { issue: number; body: Record<string, unknown> }[] = [];
  const comments: { issue: number; body: string }[] = [];
  const read = async (request: IncomingMessage) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  };
  const github = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      response.setHeader("content-type", "application/json");
      const send = (value: unknown) => response.end(JSON.stringify(value));
      if (request.method === "GET" && path === "/repos/fixture/pond/issues")
        return send([...issues.values()]);
      if (request.method === "GET" && path === "/repos/fixture/pond/pulls")
        return send([...pulls.values()].filter((pull) => pull.state === "open"));
      const pull = /^\/repos\/fixture\/pond\/pulls\/(\d+)$/u.exec(path);
      if (request.method === "GET" && pull) return send(pulls.get(Number(pull[1])));
      const comment = /^\/repos\/fixture\/pond\/issues\/(\d+)\/comments$/u.exec(path);
      if (request.method === "POST" && comment) {
        comments.push({ issue: Number(comment[1]), body: String((await read(request)).body) });
        return send({ id: comments.length });
      }
      const issue = /^\/repos\/fixture\/pond\/issues\/(\d+)$/u.exec(path);
      if (issue && issues.has(Number(issue[1]))) {
        const number = Number(issue[1]);
        if (request.method === "PATCH") {
          const body = await read(request);
          patches.push({ issue: number, body });
          const current = issues.get(number)!;
          issues.set(number, {
            ...current,
            ...(Array.isArray(body.labels)
              ? { labels: (body.labels as string[]).map((name) => ({ name })) }
              : {}),
          });
        }
        return send(issues.get(number));
      }
      response.writeHead(404).end("{}");
    })();
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");

  const settings = new SettingsStore(join(root, "settings.json"));
  const posting = createTrackerPosting({
    statePath: join(root, "posts.json"),
    settings,
    localMachineId: "local",
    leadConversation: async () => undefined,
    requestOwnerAsk: async () => {
      throw new Error("Nothing here asks the owner");
    },
    wakeConversation: async () => false,
  });
  let now = Date.parse("2026-11-03T12:00:00Z");
  const service = () =>
    createWorkItemsService({
      stateDirectory: join(root, "work"),
      workspace: () => root,
      run: defaultRun,
      posting,
      clock: () => new Date(now),
      githubToken: async () => "fixture-github-token",
      githubApiBase: `http://127.0.0.1:${String((github.address() as AddressInfo).port)}`,
      // No live seat holds anything; the drafts are the only holders.
      liveHolders: () => [],
    });
  const status = async (work: ReturnType<typeof service>) => {
    const result = await work.handle({ action: "list", repo: checkout }, true);
    if (!("items" in result)) throw new Error(`Expected a list: ${JSON.stringify(result)}`);
    return Object.fromEntries(result.items.map((item) => [item.title, item.heldBy ?? item.status]));
  };
  try {
    const before = service();
    // A read sees each draft holding its issue.
    expect(await status(before)).toEqual({
      "Issue 8": ["https://github.com/fixture/pond/pull/20"],
      "Issue 9": ["https://github.com/fixture/pond/pull/21", "https://github.com/fixture/pond/pull/22"],
      "Issue 11": ["https://github.com/fixture/pond/pull/23"],
      "Issue 12": ["https://github.com/fixture/pond/pull/24"],
      // The tracker says in progress, but no one with a say in the repo holds it.
      "Issue 13": "todo",
    });
    // Still drafts: a round changes nothing.
    expect(await before.reconcileDraftHolds()).toEqual([]);

    pulls.set(20, { ...pulls.get(20)!, state: "closed" });
    pulls.set(22, { ...pulls.get(22)!, state: "closed" });
    pulls.set(23, { ...pulls.get(23)!, state: "closed", merged: true });
    pulls.set(25, { ...pulls.get(25)!, state: "closed" });
    // GitHub's open-pull listing is read through a one-minute snapshot.
    now += 61_000;

    // The service restarts between the read and the round: what it saw is kept.
    const after = service();
    const settled = await after.reconcileDraftHolds();
    expect(settled).toEqual(
      expect.arrayContaining([
        { pull: "https://github.com/fixture/pond/pull/20", issue: "#8", outcome: "requeued" },
        expect.objectContaining({
          pull: "https://github.com/fixture/pond/pull/22",
          issue: "#9",
          outcome: "unchanged",
        }),
      ]),
    );
    expect(settled).toHaveLength(2);
    // Only #8 was written: its in-progress label is gone, and nothing else changed; the
    // outsider's closed draft was never noted, so #13 is untouched.
    expect(patches.map((patch) => patch.issue)).toEqual([8]);
    expect(patches[0]!.body.labels).not.toContain(IN_PROGRESS);
    // With a comment on the issue saying why, in the same write.
    expect(comments).toEqual([
      {
        issue: 8,
        body: expect.stringContaining(
          "draft pull request that held this issue (https://github.com/fixture/pond/pull/20) closed without merging",
        ),
      },
    ]);
    expect(await status(after)).toMatchObject({
      "Issue 8": "todo",
      "Issue 9": ["https://github.com/fixture/pond/pull/21"],
    });
    // Settled once: another round writes nothing.
    now += 61_000;
    expect(await after.reconcileDraftHolds()).toEqual([]);
    expect(patches).toHaveLength(1);

    // Watch: nothing posts, not even this.
    await settings.update((current) => ({
      ...current,
      autonomy: { ...current.autonomy, watch: true },
    }));
    pulls.set(24, { ...pulls.get(24)!, state: "closed" });
    now += 61_000;
    expect(await after.reconcileDraftHolds()).toEqual([
      expect.objectContaining({
        pull: "https://github.com/fixture/pond/pull/24",
        issue: "#12",
        outcome: "refused",
      }),
    ]);
    expect(patches).toHaveLength(1);
    expect(comments).toHaveLength(1);
  } finally {
    posting.close();
    await new Promise<void>((done) => github.close(() => done()));
  }
}, 30_000);

it("refuses a comment with a work update on a tracker other than GitHub, changing nothing", async () => {
  const root = scratch("clankie-update-comment-");
  const checkout = scratch("clankie-update-comment-repo-");
  const work = createWorkItemsService({
    stateDirectory: join(root, "work"),
    workspace: () => root,
    run: async () => {
      throw new Error("no git here");
    },
  });
  const created = await work.handle(
    { action: "create", repo: checkout, title: "Local", status: "in_progress" },
    true,
  );
  if (!("item" in created)) throw new Error("Expected an item");
  await expect(
    work.handle(
      { action: "update", repo: checkout, id: created.item.id, status: "todo", comment: "Why" },
      true,
    ),
  ).rejects.toMatchObject({ code: "invalid", message: expect.stringContaining("only for GitHub issues") });
  const shown = await work.handle({ action: "show", repo: checkout, id: created.item.id }, true);
  expect(shown).toMatchObject({ item: { status: "in_progress" } });
});
