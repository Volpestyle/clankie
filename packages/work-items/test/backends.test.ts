import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFilesBackend } from "../src/backends/files.ts";
import { createGithubBackend, githubRestApi, type GhRunner } from "../src/backends/github.ts";
import { createLinearBackend, descriptionPatch, pickLinearState } from "../src/backends/linear.ts";

const clock = () => new Date("2026-09-26T12:00:00.000Z");

describe("the files backend", () => {
  it("creates one file per item, updates in place, and attaches evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "work-files-"));
    let n = 0;
    const backend = createFilesBackend({
      root,
      directory: ".clankie/work",
      kind: "default",
      clock,
      newId: () => `W-test0${String(++n)}`,
    });
    const item = await backend.create({
      title: "Board view in the app",
      summary: "Show work items by status.",
      criteria: ["Renders on iPhone", "Renders on iPad"],
      owner: "app-worker",
    });
    expect(item).toMatchObject({
      id: "W-test01",
      status: "todo",
      owner: "app-worker",
      location: ".clankie/work/W-test01-board-view-in-the-app.md",
    });
    await backend.create({ title: "Second" });
    const updated = await backend.update("w-test01", {
      status: "in_review",
      check: [1],
      addCriteria: ["Renders on Mac"],
    });
    expect(updated.criteria).toEqual([
      { text: "Renders on iPhone", done: true },
      { text: "Renders on iPad", done: false },
      { text: "Renders on Mac", done: false },
    ]);
    const attached = await backend.attach("W-test01", {
      kind: "image",
      url: "https://files.example/board.png",
      caption: "Board on iPhone 17 (sample data)",
    });
    expect(attached.evidence).toHaveLength(1);
    expect((await backend.list({ status: ["in_review"] })).map((entry) => entry.id)).toEqual(["W-test01"]);
    const text = await readFile(join(root, item.location), "utf8");
    expect(text).toMatch(
      /^---\nid: W-test01\ntitle: Board view in the app\nstatus: in_review\nowner: app-worker/u,
    );
    expect(await readdir(join(root, ".clankie/work"))).toHaveLength(2);
    await expect(backend.update("W-nope00", { status: "done" })).rejects.toThrow(/No work item/u);
  });

  it("reads a repo's own item files without front matter, by heading and file name", async () => {
    const root = await mkdtemp(join(tmpdir(), "work-md-"));
    await mkdir(join(root, "docs/tasks"), { recursive: true });
    await writeFile(
      join(root, "docs/tasks/T-12-cache-warmup.md"),
      "# Cache warmup\n\n## Acceptance Criteria\n\n- [x] warm on boot\n",
    );
    await writeFile(join(root, "docs/tasks/README.md"), "# Tasks\n");
    const backend = createFilesBackend({ root, directory: "docs/tasks", kind: "markdown", clock });
    const [item] = await backend.list();
    expect(item).toMatchObject({
      id: "T-12",
      title: "Cache warmup",
      status: "todo",
      criteria: [{ done: true }],
    });
    const done = await backend.update("T-12", { status: "done" });
    expect(done.status).toBe("done");
    expect(await readFile(join(root, "docs/tasks/T-12-cache-warmup.md"), "utf8")).toContain("status: done");
  });

  it("refuses a directory outside the repo", () => {
    expect(() =>
      createFilesBackend({ root: "/tmp/repo", directory: "../elsewhere", kind: "markdown" }),
    ).toThrow();
  });
});

describe("the GitHub backend", () => {
  function fakeGh() {
    const issues = new Map<number, Record<string, unknown>>();
    let next = 40;
    const calls: string[][] = [];
    const gh: GhRunner = async (args, stdin) => {
      calls.push([...args]);
      if (args.includes("--paginate"))
        return JSON.stringify([
          [
            ...issues.values(),
            {
              number: 99,
              title: "a PR",
              body: "",
              state: "open",
              html_url: "x",
              labels: [],
              pull_request: {},
            },
          ],
        ]);
      const method = args[args.indexOf("-X") + 1];
      const path = args[args.indexOf("-X") + 2]!;
      if (path.endsWith("/parent")) throw new Error("gh: Not Found (HTTP 404)");
      const body = stdin === undefined ? {} : (JSON.parse(stdin) as Record<string, unknown>);
      const number = Number(/issues\/(\d+)/u.exec(path)?.[1]);
      if (method === "POST") {
        const issue = {
          number: ++next,
          state: "open",
          html_url: `https://github.com/o/r/issues/${String(next)}`,
          labels: [],
          ...body,
        };
        issues.set(next, issue);
        return JSON.stringify(issue);
      }
      const issue = issues.get(number);
      if (issue === undefined) throw new Error("gh: Not Found (HTTP 404)");
      if (method === "PATCH") Object.assign(issue, body);
      return JSON.stringify(issue);
    };
    return { gh, issues, calls };
  }

  it("maps statuses onto open, closed with a reason, and a status label", async () => {
    const { gh, issues } = fakeGh();
    const backend = createGithubBackend({ repo: "o/r", gh });
    const created = await backend.create({
      title: "Evidence gallery",
      criteria: ["Shows images"],
      owner: "codex-2",
    });
    expect(created).toMatchObject({
      id: "#41",
      status: "todo",
      owner: "codex-2",
      criteria: [{ text: "Shows images", done: false }],
    });
    expect(await backend.update("41", { status: "in_progress" })).toMatchObject({ status: "in_progress" });
    expect(issues.get(41)).toMatchObject({ state: "open", labels: ["status: in progress"] });
    expect(await backend.update("#41", { status: "canceled" })).toMatchObject({ status: "canceled" });
    expect(issues.get(41)).toMatchObject({ state: "closed", state_reason: "not_planned", labels: [] });
    expect(await backend.update("#41", { status: "done", check: [1] })).toMatchObject({
      status: "done",
      criteria: [{ done: true }],
    });
  });

  it("lists issues but never pull requests, and reports a missing issue as absent", async () => {
    const { gh } = fakeGh();
    const backend = createGithubBackend({ repo: "o/r", gh });
    await backend.create({ title: "One" });
    expect((await backend.list()).map((item) => item.id)).toEqual(["#41"]);
    expect(await backend.get("#7")).toBeUndefined();
    expect(await backend.get("not-a-number")).toBeUndefined();
  });

  it("appends evidence to the issue body", async () => {
    const { gh, issues } = fakeGh();
    const backend = createGithubBackend({ repo: "o/r", gh });
    await backend.create({ title: "One", summary: "Owner text stays." });
    await backend.attach("#41", {
      kind: "video",
      url: "https://x/demo.mp4",
      caption: "Wake demo (real device)",
    });
    expect(issues.get(41)!.body).toContain("Owner text stays.");
    expect(issues.get(41)!.body).toContain("- video: [Wake demo (real device)](https://x/demo.mp4)");
  });
});

describe("the Linear backend", () => {
  const statuses = [
    { name: "Backlog", type: "backlog" },
    { name: "Todo", type: "unstarted" },
    { name: "In Progress", type: "started" },
    { name: "In Review", type: "started" },
    { name: "Done", type: "completed" },
    { name: "Canceled", type: "canceled" },
  ];

  it("picks the conventional team state for each status", () => {
    expect(pickLinearState(statuses, "todo")).toBe("Todo");
    expect(pickLinearState(statuses, "in_progress")).toBe("In Progress");
    expect(pickLinearState(statuses, "in_review")).toBe("In Review");
    expect(pickLinearState(statuses, "done")).toBe("Done");
    expect(pickLinearState(statuses, "canceled")).toBe("Canceled");
  });

  it("creates, projects Linear state types, and edits the description sections", async () => {
    const saved: Record<string, unknown>[] = [];
    const store = new Map<string, Record<string, unknown>>();
    const call = async (tool: string, args: Record<string, unknown>) => {
      if (tool === "list_issue_statuses") return statuses;
      if (tool === "save_issue") {
        saved.push(args);
        const id = (args.id as string | undefined) ?? "VUH-900";
        const current = store.get(id) ?? {
          id,
          identifier: id,
          url: `https://linear.app/x/issue/${id}`,
          status: "Backlog",
          statusType: "backlog",
        };
        const state = args.state as string | undefined;
        const next = {
          ...current,
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(state === undefined
            ? {}
            : { status: state, statusType: statuses.find((entry) => entry.name === state)!.type }),
        };
        store.set(id, next);
        return next;
      }
      if (tool === "get_issue") {
        const issue = store.get(args.id as string);
        if (issue === undefined) throw new Error("Entity not found: Issue");
        return issue;
      }
      if (tool === "list_issues") return { issues: [...store.values()] };
      throw new Error(`unexpected ${tool}`);
    };
    const backend = createLinearBackend({ team: "VUH", project: "Clankie", call });
    const created = await backend.create({
      title: "Board",
      criteria: ["iPhone", "iPad"],
      status: "in_progress",
    });
    expect(created).toMatchObject({
      id: "VUH-900",
      status: "in_progress",
      criteria: [{ text: "iPhone" }, { text: "iPad" }],
    });
    expect(saved[0]).toMatchObject({ team: "VUH", project: "Clankie", state: "In Progress" });
    expect(await backend.update("VUH-900", { status: "in_review", check: [2] })).toMatchObject({
      status: "in_review",
      criteria: [{ done: false }, { done: true }],
    });
    expect(await backend.list({ status: ["in_review"] })).toHaveLength(1);
    expect(await backend.get("VUH-1")).toBeUndefined();
  });

  it("edits a description holding uploads section by section instead of rewriting it", () => {
    const before =
      "Intro ![shot](https://uploads.linear.app/a/b?signature=x)\n\n## Acceptance Criteria\n\n- [ ] one\n";
    const after =
      "Intro ![shot](https://uploads.linear.app/a/b?signature=x)\n\n## Acceptance Criteria\n\n- [x] one\n\n## Evidence\n\n- link: [run](https://x)\n";
    expect(descriptionPatch(before, after)).toEqual([
      {
        op: "replace",
        old_string: "## Acceptance Criteria\n\n- [ ] one",
        new_string: "## Acceptance Criteria\n\n- [x] one",
      },
      { op: "append", text: "\n\n## Evidence\n\n- link: [run](https://x)" },
    ]);
  });
});

describe("the GitHub REST client", () => {
  it("pages through the API origin only, and errors carry no token", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(`${url} ${new Headers(init?.headers).get("authorization") ?? ""}`);
      if (url.endsWith("/fail")) return new Response("secret-token echoed", { status: 500 });
      const page = url.includes("page=2") ? 2 : 1;
      return Response.json([{ page }], {
        headers: {
          link:
            page === 1
              ? '<https://api.github.test/repos/o/r/issues?page=2>; rel="next"'
              : '<https://evil.example/steal?page=3>; rel="next"',
        },
      });
    };
    const api = githubRestApi({
      token: "secret-token",
      baseUrl: "https://api.github.test",
      fetch: fetchImpl,
    });
    expect(await api.list("repos/o/r/issues")).toEqual([{ page: 1 }, { page: 2 }]);
    expect(seen).toEqual([
      "https://api.github.test/repos/o/r/issues Bearer secret-token",
      "https://api.github.test/repos/o/r/issues?page=2 Bearer secret-token",
    ]);
    const failure = await api.request("GET", "fail").catch((error: unknown) => String(error));
    expect(failure).toBe("Error: GitHub GET /fail: HTTP 500");
  });
});

describe("work item labels (ADR 0208)", () => {
  it("reads Markdown front matter labels in flow, comma and block form, and filters case-insensitively", async () => {
    const root = await mkdtemp(join(tmpdir(), "work-labels-"));
    await mkdir(join(root, "docs/tasks"), { recursive: true });
    await writeFile(join(root, "docs/tasks/T-1-a.md"), '---\nlabels: [Designer, "ui polish"]\n---\n# A\n');
    await writeFile(join(root, "docs/tasks/T-2-b.md"), "---\nlabels: builder, infra\nowner:\n---\n# B\n");
    await writeFile(
      join(root, "docs/tasks/T-3-c.md"),
      "---\nlabels:\n  - designer\n  - research\nstatus: todo\n---\n# C\n",
    );
    await writeFile(join(root, "docs/tasks/T-4-d.md"), "# D\n");
    const backend = createFilesBackend({ root, directory: "docs/tasks", kind: "markdown", clock });
    const items = await backend.list();
    expect(items.map((item) => item.labels)).toEqual([
      ["Designer", "ui polish"],
      ["builder", "infra"],
      ["designer", "research"],
      undefined,
    ]);
    expect(items[1]).not.toHaveProperty("owner");
    expect((await backend.list({ label: "DESIGNER" })).map((item) => item.id)).toEqual(["T-1", "T-3"]);
    // An update rewrites front matter without losing the list.
    await backend.update("T-3", { status: "done" });
    expect((await backend.get("T-3"))?.labels).toEqual(["designer", "research"]);
  });

  it("reads GitHub labels without the status labels the backend writes", async () => {
    const issue = {
      number: 5,
      title: "Station art",
      body: "",
      state: "open",
      html_url: "https://github.com/o/r/issues/5",
      labels: [{ name: "Designer" }, "status: in progress", { name: "" }, "art"],
    };
    const gh: GhRunner = async (args) => {
      if (args.some((arg) => arg.endsWith("/parent"))) throw new Error("gh: Not Found (HTTP 404)");
      return JSON.stringify([[issue]]);
    };
    const backend = createGithubBackend({ repo: "o/r", gh });
    const [item] = await backend.list({ label: "designer" });
    expect(item).toMatchObject({ status: "in_progress", labels: ["Designer", "art"] });
    expect(await backend.list({ label: "tester" })).toEqual([]);
  });

  it("asks Linear for labels and bounds them to the item contract", async () => {
    const asked: Record<string, unknown>[] = [];
    const backend = createLinearBackend({
      team: "VUH",
      call: async (tool, args) => {
        asked.push({ tool, ...args });
        return {
          issues: [
            {
              id: "u1",
              identifier: "VUH-1",
              title: "Many labels",
              labels: Array.from({ length: 25 }, (_, index) => `L${String(index)}${"x".repeat(80)}`),
            },
            { id: "u2", identifier: "VUH-2", title: "Builder work", labels: ["Builder", "Bug"] },
            { id: "u3", identifier: "VUH-3", title: "Nested", labels: { nodes: [{ name: "builder" }] } },
          ],
        };
      },
    });
    const all = await backend.list();
    expect(asked[0]?.fields).toContain("labels");
    expect(all[0]?.labels).toHaveLength(20);
    expect(all[0]?.labels?.[0]).toHaveLength(64);
    expect((await backend.list({ label: "builder" })).map((item) => item.id)).toEqual(["VUH-2", "VUH-3"]);
  });
});
