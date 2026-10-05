import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CredentialStore } from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";
import { WorkConventionSchema } from "@clankie/protocol/work-items";
import { readConvention } from "@clankie/work-items";
import { workRequest } from "../../tui/src/command/work.ts";
import { createMcpHost, type McpHost } from "../src/mcp-host.ts";
import { createWorkItemsService, WorkRequestSchema } from "../src/work-items.ts";

interface Issue {
  id: string;
  title: string;
  description: string;
  status: { name: string; type: string };
  labels: string[];
}
const roots: string[] = [];
const hosts: McpHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "linear-scope-"));
  roots.push(root);
  const repo = join(root, "repo-a");
  const broad = join(root, "repo-broad");
  await Promise.all([mkdir(repo), mkdir(broad)]);
  const issues: Issue[] = Array.from({ length: 64 }, (_, i) => ({
    id: `VUH-${i + 1}`,
    title: `Item ${i + 1}`,
    description: `**Owner:** ${i === 61 ? "someone-else" : "James"}\n\nSummary\n\n## Acceptance Criteria\n\n- [ ] Keep media`,
    status: { name: i === 60 ? "Done" : "In Progress", type: i === 60 ? "completed" : "started" },
    // Both filters live beyond the public item's 20-label projection.
    labels: [
      ...Array.from({ length: 20 }, (_, n) => `extra-${n}`),
      "repo-a",
      i < 60 ? "other-role" : "worker",
    ],
  }));
  issues.push({ ...issues[63]!, id: "VUH-OTHER", title: "Other repo", labels: ["repo-b", "worker"] });
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const host = createMcpHost({
    credentials: { get: async () => undefined } as unknown as CredentialStore,
    settings: { load: async () => ({ mcp: { servers: [] } }) } as unknown as SettingsStore,
    curated: [
      {
        id: "linear",
        transport: "stdio",
        command: "fake",
        args: [],
        lane: "operator",
        initialTools: [],
        enabled: true,
      },
    ],
    logger: { info: () => undefined, warn: () => undefined },
    connect: async () => ({
      listTools: async () => [],
      callTool: async (tool, args) => {
        calls.push({ tool, args });
        let value: unknown;
        if (tool === "list_issues") {
          const filtered = issues.filter(
            (issue) => args.label === undefined || issue.labels.includes(String(args.label)),
          );
          const start = Number(args.cursor ?? 0);
          const end = start + Number(args.limit);
          value = {
            issues: filtered.slice(start, end),
            hasNextPage: end < filtered.length,
            cursor: String(end),
          };
        } else if (tool === "get_issue") {
          value = issues.find((issue) => issue.id === args.id);
        } else if (tool === "list_issue_statuses") {
          value = [
            { name: "In Progress", type: "started" },
            { name: "Done", type: "completed" },
          ];
        } else if (tool === "save_issue") {
          const labels = args.labels as string[] | undefined;
          if (labels?.some((label) => label !== "repo-a")) throw new Error("Unknown label");
          let issue = issues.find((candidate) => candidate.id === args.id);
          if (issue === undefined) {
            issue = {
              id: "VUH-NEW",
              title: String(args.title),
              description: String(args.description),
              status: { name: "In Progress", type: "started" },
              labels: labels ?? [],
            };
            issues.push(issue);
          } else {
            if (labels !== undefined) issue.labels = labels;
            if (args.title !== undefined) issue.title = String(args.title);
            if (args.state !== undefined)
              issue.status = {
                name: String(args.state),
                type: args.state === "Done" ? "completed" : "started",
              };
            if (args.description !== undefined) issue.description = String(args.description);
            for (const patch of (args.patch ?? []) as {
              op: string;
              old_string?: string;
              new_string?: string;
              text?: string;
            }[]) {
              issue.description =
                patch.op === "replace"
                  ? issue.description.replace(patch.old_string!, patch.new_string!)
                  : issue.description + patch.text;
            }
          }
          value = issue;
        } else throw new Error(`Unexpected provider tool ${tool}`);
        return { content: JSON.stringify(value), isError: false };
      },
      close: async () => undefined,
    }),
  });
  hosts.push(host);
  const service = createWorkItemsService({
    stateDirectory: join(root, "state"),
    workspace: () => repo,
    mcpHost: host,
  });
  const cli = async (args: string[], path = repo) =>
    service.handle(WorkRequestSchema.parse(workRequest(args, path)), true);
  const init = (label?: string, path = repo) =>
    cli(
      [
        "init",
        "--backend",
        "linear",
        "--linear-team",
        "VUH",
        "--linear-project",
        "Shared project",
        ...(label === undefined ? [] : ["--linear-label", label]),
      ],
      path,
    );
  return { repo, broad, service, cli, init, issues, calls };
}

it("saves the CLI board scope and intersects role/status/owner across provider pages before label projection", async () => {
  const f = await fixture();
  await f.init(" repo-a ");
  expect(await readConvention(f.repo)).toHaveProperty("linear.label", "repo-a");
  const result = await f.cli(["list", "--label", " WoRkEr ", "--status", "in_progress", "--owner", "James"]);
  expect(result).toHaveProperty("items");
  if (!("items" in result)) throw new Error("Missing board");
  expect(result.items.map((item) => item.id)).toEqual(["VUH-63", "VUH-64"]);
  expect(result.items.every((item) => item.labels?.length === 20)).toBe(true);
  const pages = f.calls.filter((call) => call.tool === "list_issues");
  expect(pages).toHaveLength(2);
  expect(pages.map(({ args }) => args.cursor)).toEqual([undefined, "50"]);
  for (const { args } of pages) {
    expect(args).toMatchObject({ team: "VUH", project: "Shared project", label: "repo-a", limit: 50 });
    expect(args.fields).toContain("labels");
  }
});

it("scopes the board but leaves direct known-item reads and unlabeled project boards unchanged", async () => {
  const f = await fixture();
  await f.init("repo-a");
  const board = await f.cli(["list"]);
  expect(board).toHaveProperty("items.length", 64);
  expect(await f.cli(["show", "VUH-OTHER"])).toHaveProperty("item.id", "VUH-OTHER");
  await f.init(undefined, f.broad);
  const broad = await f.cli(["list"], f.broad);
  expect(broad).toHaveProperty("items.length", 65);
  const last = f.calls.filter((call) => call.tool === "list_issues").at(-1)!;
  expect(last.args).not.toHaveProperty("label");
  expect(await readConvention(f.broad)).not.toHaveProperty("linear.label");
});

it("creates with the existing board label; edits, close and attachment preserve every label and uploaded media", async () => {
  const f = await fixture();
  await f.init("repo-a");
  await f.cli(["create", "Scoped task"]);
  expect(f.calls.find((call) => call.tool === "save_issue")?.args).toMatchObject({ labels: ["repo-a"] });
  const issue = f.issues[0]!;
  const originalLabels = [...issue.labels];
  const media = "![demo.mp4](https://uploads.linear.app/demo?signature=read-only)";
  issue.description += `\n\n## Evidence\n\n${media}`;
  await f.cli(["update", issue.id, "--check", "1"]);
  await f.cli(["close", issue.id]);
  await f.cli(["attach", issue.id, "--url", "https://example.test/log.txt", "--caption", "Scoped proof"]);
  const edits = f.calls.filter((call) => call.tool === "save_issue" && call.args.id === issue.id);
  expect(edits).toHaveLength(3);
  for (const { args } of edits) {
    expect(args).not.toHaveProperty("labels");
    expect(args).not.toHaveProperty("description");
    expect(JSON.stringify(args)).not.toContain(media);
  }
  expect(issue.labels).toEqual(originalLabels);
  expect(issue.description).toContain(media);
  expect(issue.description).toContain("[x] Keep media");
  expect(issue.description).toContain("Scoped proof");
  expect(issue.status.name).toBe("Done");
});

it("does not create an unknown saved label or fall back when the provider rejects it", async () => {
  const f = await fixture();
  await f.init("missing-label");
  await expect(f.cli(["create", "Rejected task"])).rejects.toThrow("Unknown label");
  expect(f.calls.map((call) => call.tool)).toEqual(["save_issue"]);
  expect(f.issues).toHaveLength(65);
});

it("appends a new Evidence section when uploaded media has no evidence heading", async () => {
  const f = await fixture();
  await f.init("repo-a");
  const issue = f.issues[0]!;
  const media = "![demo.mp4](https://uploads.linear.app/demo?signature=read-only)";
  issue.description += `\n\n## Demo\n\n${media}`;
  await f.cli(["attach", issue.id, "--url", "https://example.test/log.txt", "--caption", "New proof"]);
  expect(issue.description).toContain(media);
  expect(issue.description.match(/^## Evidence$/gmu)).toHaveLength(1);
  expect(f.calls.find((call) => call.tool === "save_issue")?.args).toEqual({
    id: issue.id,
    patch: [{ op: "append", text: "\n\n## Evidence\n\n- log: [New proof](https://example.test/log.txt)" }],
  });
});

it.each(["## Evidence\n\nSecond section", "```md\n## Evidence\n```"])(
  "refuses an ambiguous media insertion anchor (%s)",
  async (extra) => {
    const f = await fixture();
    await f.init("repo-a");
    const issue = f.issues[0]!;
    issue.description += `\n\n## Evidence\n\n![demo.mp4](https://uploads.linear.app/demo)\n\n${extra}`;
    const before = issue.description;
    await expect(
      f.cli(["attach", issue.id, "--url", "https://example.test/log.txt", "--caption", "New proof"]),
    ).rejects.toThrow("ambiguous");
    expect(issue.description).toBe(before);
    expect(f.calls.filter((call) => call.tool === "save_issue")).toEqual([]);
  },
);

it.each(["", "   ", "x".repeat(65), "repo-a\nrepo-b"])(
  "refuses invalid CLI label %j without overwriting a convention",
  async (label) => {
    const f = await fixture();
    await f.init();
    const path = join(f.repo, ".clankie", "tracking.json");
    const before = await readFile(path, "utf8");
    await expect(f.init(label)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(f.calls).toEqual([]);
  },
);

it.each(["default", "markdown", "github"])(
  "refuses a Linear label on %s initialization rather than discarding it",
  async (backend) => {
    const f = await fixture();
    await f.init();
    const before = await readConvention(f.repo);
    await expect(f.cli(["init", "--backend", backend, "--linear-label", "repo-a"])).rejects.toThrow();
    expect(await readConvention(f.repo)).toEqual(before);
    expect(
      WorkConventionSchema.safeParse({ ...before, backend, linear: { team: "VUH", label: "repo-a" } })
        .success,
    ).toBe(false);
  },
);

it("refuses a saved label without a Linear team and rejects the init flag on other CLI actions", async () => {
  const f = await fixture();
  await expect(f.cli(["init", "--backend", "linear", "--linear-label", "repo-a"])).rejects.toThrow();
  expect(await readConvention(f.repo)).toBeUndefined();
  expect(() => workRequest(["list", "--linear-label", "repo-a"], f.repo)).toThrow();
});

it("applies the label to a discovered Linear convention and refuses a discovered file backend", async () => {
  const f = await fixture();
  await writeFile(
    join(f.repo, "AGENTS.md"),
    "Work is in Linear: https://linear.app/example/issue/VUH-1 and https://linear.app/example/project/shared-project",
  );
  await f.cli(["init", "--linear-label", "repo-a"]);
  expect(await readConvention(f.repo)).toMatchObject({
    decidedBy: "discovery",
    linear: { team: "VUH", project: "shared-project", label: "repo-a" },
  });
  await expect(f.cli(["init", "--linear-label", "repo-a"], f.broad)).rejects.toThrow();
  expect(await readConvention(f.broad)).toBeUndefined();
});

it("forwards the compatibility CLI init label through service validation into the same saved board", async () => {
  const f = await fixture();
  const result = await f.cli([
    "init",
    "--backend",
    "linear",
    "--linear-team",
    "VUH",
    "--linear-project",
    "Shared project",
    "--linear-label",
    "repo-a",
  ]);
  expect(result).toHaveProperty("convention.linear.label", "repo-a");
  expect(await readConvention(f.repo)).toHaveProperty("linear.label", "repo-a");
  expect(await f.cli(["list"])).toHaveProperty("items.length", 64);
});
