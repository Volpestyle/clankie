import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { initializeConvention, readConvention, writeConvention } from "../src/convention.ts";
import { githubRestApi } from "../src/backends/github.ts";
import { trackerToolsFor } from "../src/tracker.ts";

const issueAt = (number: number) => ({
  number,
  state: "open",
  labels: [] as string[],
  html_url: `https://github.com/Volpestyle/clankie/issues/${String(number)}`,
});

// #81: a repo moving off Linear reads both trackers and files every new issue on GitHub.
it("lists and works Linear's open issues in place while every new issue goes to GitHub", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-previous-tracker-"));
  const githubIssues = [{ ...issueAt(81), id: 9081, title: "Read two trackers", body: "" }];
  const linearIssues: Record<string, Record<string, unknown>> = {
    "VUH-2954": { id: "VUH-2954", identifier: "VUH-2954", title: "Still in Linear", status: "Todo" },
  };
  const githubWrites: { method: string; path: string; body: unknown }[] = [];
  const linearCalls: { tool: string; args: Record<string, unknown> }[] = [];
  // Both providers over a real HTTP boundary: GitHub's REST shapes, Linear's connected-tool shapes.
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    const url = new URL(request.url ?? "/", "http://fixture");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/linear") {
      const { tool, args } = JSON.parse(text) as { tool: string; args: Record<string, unknown> };
      linearCalls.push({ tool, args });
      if (tool === "list_issues")
        return response.end(JSON.stringify({ issues: Object.values(linearIssues), hasNextPage: false }));
      if (tool === "get_issue") return response.end(JSON.stringify(linearIssues[String(args.id)] ?? null));
      if (tool === "save_issue" && typeof args.id === "string") {
        Object.assign(linearIssues[args.id]!, { title: args.title });
        return response.end(JSON.stringify(linearIssues[args.id]));
      }
      response.statusCode = 400;
      return response.end(JSON.stringify({ error: `Unexpected Linear tool ${tool}` }));
    }
    const base = "/repos/Volpestyle/clankie/issues";
    if (request.method === "GET" && url.pathname === base) return response.end(JSON.stringify(githubIssues));
    const number = Number(/\/issues\/(\d+)$/u.exec(url.pathname)?.[1]);
    if (request.method === "GET" && url.pathname.endsWith("/parent")) {
      response.statusCode = 404;
      return response.end(JSON.stringify({ message: "Not Found" }));
    }
    if (request.method === "GET" && Number.isSafeInteger(number)) {
      const issue = githubIssues.find((entry) => entry.number === number);
      if (issue === undefined) response.statusCode = 404;
      return response.end(JSON.stringify(issue ?? { message: "Not Found" }));
    }
    if (request.method === "POST" && url.pathname === base) {
      const body = JSON.parse(text) as { title: string; body: string };
      githubWrites.push({ method: "POST", path: url.pathname, body });
      const issue = { ...issueAt(82), id: 9082, title: body.title, body: body.body };
      githubIssues.push(issue);
      return response.end(JSON.stringify(issue));
    }
    response.statusCode = 400;
    response.end(JSON.stringify({ message: `Unexpected GitHub ${request.method} ${url.pathname}` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No fixture address");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeConvention(root, {
      schemaVersion: 1,
      backend: "linear",
      linear: { team: "VUH", project: "clankie-7f2de0de4a75" },
      decidedBy: "discovery",
      decidedAt: "2026-09-26T18:24:50.522Z",
    });
    // The owner's switch: the recorded Linear scope is carried as the previous tracker.
    const convention = await initializeConvention(root, {
      backend: "github",
      githubRepo: "Volpestyle/clankie",
      previous: "linear",
    });
    expect(convention).toMatchObject({
      backend: "github",
      github: { repo: "Volpestyle/clankie" },
      linear: { team: "VUH", project: "clankie-7f2de0de4a75" },
      previous: "linear",
    });
    expect(await readConvention(root)).toEqual(convention);

    const tools = trackerToolsFor(root, convention, {
      github: githubRestApi({ token: "fixture-token", baseUrl: origin }),
      linear: async (tool, args) => {
        const response = await fetch(`${origin}/linear`, {
          method: "POST",
          body: JSON.stringify({ tool, args }),
        });
        if (!response.ok) throw new Error(`Linear fixture HTTP ${String(response.status)}`);
        return response.json();
      },
      trackerDirectory: join(root, ".local", "tracker"),
    });

    const listed = (await tools.call("list_issues", {})) as {
      issues: { id?: string; identifier?: string }[];
    };
    expect(listed.issues.map((issue) => issue.identifier ?? issue.id)).toEqual(["#81", "VUH-2954"]);
    // Linear's read stays inside its own saved scope.
    expect(linearCalls.at(-1)).toMatchObject({
      tool: "list_issues",
      args: { team: "VUH", project: "clankie-7f2de0de4a75" },
    });

    const created = (await tools.call("save_issue", {
      team: "VUH",
      title: "Filed after the move",
    })) as { identifier?: string };
    // Even naming the Linear team, a new issue lands on GitHub.
    expect(created.identifier).toBe("#82");
    expect(githubWrites).toHaveLength(1);
    expect(linearCalls.some((call) => call.tool === "save_issue" && call.args.id === undefined)).toBe(false);

    // An existing Linear issue keeps being worked where it lives.
    await tools.call("save_issue", { id: "VUH-2954", title: "Still in Linear, updated" });
    expect(linearCalls.at(-1)).toMatchObject({ tool: "save_issue", args: { id: "VUH-2954" } });
    expect(await tools.call("get_issue", { id: "VUH-2954" })).toMatchObject({
      title: "Still in Linear, updated",
    });
    expect(await tools.call("get_issue", { id: "#82" })).toMatchObject({ title: "Filed after the move" });
    expect(githubWrites).toHaveLength(1);

    // Once Linear's open issues are gone the owner drops it, and only GitHub remains.
    const settled = await initializeConvention(root, { previous: "none" });
    expect(settled.previous).toBeUndefined();
    expect(settled.backend).toBe("github");
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
