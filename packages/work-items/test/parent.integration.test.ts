import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseProtocolResponse } from "../../protocol/test/fixtures/response-8d982a93.ts";
import {
  legacyWorkItem,
  WorkItemSchema,
  WorkItemsResultSchema,
  type WorkItem,
} from "@clankie/protocol/work-items";
import { afterEach, expect, it } from "vitest";
import { WorkItemsResultSchema as oldResultSchema } from "../../protocol/test/fixtures/work-items-8d982a93.ts";
import { createFilesBackend } from "../src/backends/files.ts";
import { createGithubBackend, githubRestApi } from "../src/backends/github.ts";
import { createLinearBackend } from "../src/backends/linear.ts";

const fixture = (name: string) => new URL(`./fixtures/parent/${name}`, import.meta.url);
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

// Freeze the client from before VUH-1593. Host and request schemas stay strict;
// the frozen production response reader projects additive host fields for this client.
const result = (items: WorkItem[], backend: "linear" | "github" | "markdown") =>
  WorkItemsResultSchema.parse({
    repo: { id: "parent-fixture", name: "Parent fixture", backend, needsDecision: false },
    items,
  });

it("projects the captured Linear parent into list/get responses and old-client reads", async () => {
  const issue = JSON.parse(await readFile(fixture("linear-issue.json"), "utf8")) as Record<string, unknown>;
  const requestedFields: unknown[] = [];
  const backend = createLinearBackend({
    team: "VUH",
    call: async (tool, args) => {
      if (tool === "get_issue") return issue;
      if (tool === "list_issues") {
        requestedFields.push(args.fields);
        return { issues: [issue, { id: "VUH-older", title: "Older item" }] };
      }
      throw new Error(`Unexpected read tool: ${tool}`);
    },
  });
  const items = await backend.list();
  const wire = JSON.parse(JSON.stringify(result(items, "linear"))) as unknown;
  expect(requestedFields[0]).toContain("parentId");
  expect(items.map(({ id, parent }) => ({ id, parent }))).toEqual([
    { id: "VUH-1593", parent: "VUH-1588" },
    { id: "VUH-older", parent: undefined },
  ]);
  expect(await backend.get("VUH-1593")).toEqual(items[0]);
  expect(WorkItemsResultSchema.parse(wire).items[0]?.parent).toBe("VUH-1588");
  expect(oldResultSchema.safeParse(wire).success).toBe(false);
  const oldRead = parseProtocolResponse(oldResultSchema, result(items.map(legacyWorkItem), "linear"));
  expect(oldRead.items).toEqual(
    items.map(legacyWorkItem).map(({ parent: _parent, priority: _priority, ...item }) => item),
  );
  expect(oldResultSchema.safeParse(wire).success).toBe(false);
  expect(() =>
    parseProtocolResponse(oldResultSchema, {
      ...result(items, "linear"),
      items: [{ ...items[0], status: "future" }],
    }),
  ).toThrow();
  expect(WorkItemSchema.parse(oldRead.items[1])).not.toHaveProperty("parent");
});

it("reads Markdown parent front matter without inventing parents for old or empty items", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-parent-"));
  roots.push(root);
  const directory = join(root, "docs/tasks");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "T-12-child.md"), await readFile(fixture("T-12-child.md"), "utf8"));
  await writeFile(join(directory, "T-13-old.md"), "# Older item\n");
  await writeFile(join(directory, "T-14-empty.md"), "---\nparent:\n---\n# No recorded parent\n");
  const backend = createFilesBackend({ root, directory: "docs/tasks", kind: "markdown" });
  const items = result(await backend.list(), "markdown").items;
  expect(items.map(({ id, parent }) => ({ id, parent }))).toEqual([
    { id: "T-12", parent: "T-10" },
    { id: "T-13", parent: undefined },
    { id: "T-14", parent: undefined },
  ]);
  expect(items[0]?.dependsOn).toEqual(["T-11"]);
  expect(await backend.get("T-12")).toEqual(items[0]);
  const updated = await backend.update("T-12", { status: "done" });
  expect(updated.parent).toBe("T-10");
  expect(await readFile(join(directory, "T-12-child.md"), "utf8")).toContain("parent: T-10");
});

it("reads GitHub's parent endpoint through real HTTP and preserves unknown/error distinctions", async () => {
  const parent = JSON.parse(await readFile(fixture("github-parent.json"), "utf8")) as Record<string, unknown>;
  const issue = (number: number) => ({
    number,
    title: "Sub-issue fixture",
    body: "",
    state: "open",
    labels: [],
    html_url: `https://github.com/octocat/Hello-World/issues/${String(number)}`,
  });
  const seen: string[] = [];
  const foreignRepo = `octocat/${"parent-repo-".repeat(7)}`;
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    seen.push(`${request.method ?? ""} ${path}`);
    response.setHeader("content-type", "application/json");
    if (path === "/repos/octocat/Hello-World/issues?state=all&per_page=100") {
      response.end(JSON.stringify([issue(42), issue(43), issue(46), { ...issue(44), pull_request: {} }]));
    } else if (path.endsWith("/42/parent")) {
      response.end(JSON.stringify(parent));
    } else if (path.endsWith("/43/parent")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
    } else if (path.endsWith("/45/parent")) {
      response.statusCode = 503;
      response.end(JSON.stringify({ message: "Service unavailable" }));
    } else if (path.endsWith("/46/parent")) {
      response.end(
        JSON.stringify({ ...parent, repository_url: `https://api.github.com/repos/${foreignRepo}` }),
      );
    } else if (/\/issues\/(?:42|43|45|46)$/u.test(path)) {
      response.end(JSON.stringify(issue(Number(path.split("/").at(-1)))));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("HTTP fixture did not bind a port");
  const backend = createGithubBackend({
    repo: "octocat/Hello-World",
    api: githubRestApi({ token: "fixture-token", baseUrl: `http://127.0.0.1:${String(address.port)}` }),
  });
  const items = result(await backend.list(), "github").items;
  expect(items.map(({ id, parent }) => ({ id, parent }))).toEqual([
    { id: "#42", parent: "#1347" },
    { id: "#43", parent: undefined },
    { id: "#46", parent: `${foreignRepo}#1347` },
  ]);
  expect(await backend.get("#42")).toEqual(items[0]);
  expect(await backend.get("#43")).toEqual(items[1]);
  expect((await backend.get("#46"))?.parent).toHaveLength(`${foreignRepo}#1347`.length);
  await expect(backend.get("#45")).rejects.toThrow("HTTP 503");
  expect(seen).toContain("GET /repos/octocat/Hello-World/issues/42/parent");
  expect(seen.some((path) => path.includes("/44/parent"))).toBe(false);
  expect(seen.every((path) => path.startsWith("GET "))).toBe(true);
});
