import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  OperatorConversationServiceResultSchema,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService } from "../src/work-items.ts";

const clock = () => new Date("2026-09-26T12:00:00.000Z");
const noGit = async () => {
  throw new Error("no git here");
};

async function fixture(repoFiles: Record<string, string> = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "work-state-"));
  const repo = await mkdtemp(join(tmpdir(), "work-repo-"));
  for (const [path, text] of Object.entries(repoFiles)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  const workspace = await mkdtemp(join(tmpdir(), "work-workspace-"));
  const service = createWorkItemsService({ stateDirectory, workspace: () => workspace, run: noGit, clock });
  return { service, repo, workspace, stateDirectory };
}

describe("the work-items service", () => {
  it("lists the working directory as workspace and registers repos a local caller names", async () => {
    const { service, repo, workspace } = await fixture();
    const before = await service.handle({ action: "repos" }, true);
    expect(before).toEqual({ repos: [expect.objectContaining({ id: "workspace", needsDecision: true })] });
    const created = await service.handle(
      { action: "create", repo, title: "Board view", criteria: ["iPhone"] },
      true,
    );
    expect(created).toMatchObject({ item: { status: "todo", criteria: [{ text: "iPhone", done: false }] } });
    const repos = await service.handle({ action: "repos" }, true);
    const registered = "repos" in repos ? repos.repos.find((entry) => entry.id !== "workspace") : undefined;
    expect(registered).toMatchObject({ backend: "default", needsDecision: false, root: repo });
    // The root is what joins a repo's work to the directory a seat works in.
    expect("repos" in before ? before.repos[0]?.root : undefined).toBe(resolve(workspace));
    const listed = await service.handle({ action: "list", repo: registered!.id }, false);
    expect("items" in listed ? listed.items.map((item) => item.title) : []).toEqual(["Board view"]);
    expect(JSON.parse(await readFile(join(repo, ".clankie/tracking.json"), "utf8"))).toMatchObject({
      backend: "default",
      decidedBy: "discovery",
    });
  });

  it("never lets a device name a path or write", async () => {
    const { service, repo } = await fixture();
    await expect(service.handle({ action: "list", repo }, false)).rejects.toMatchObject({
      code: "unknown_repo",
    });
    await expect(
      service.handle({ action: "create", repo: "workspace", title: "x" }, false),
    ).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      service.handle({ action: "init", repo: "workspace", backend: "default" }, false),
    ).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("returns the owner's question instead of choosing, then follows the recorded answer", async () => {
    const { service, repo } = await fixture({ "TODO.md": "- a", "docs/tasks/T-1-first.md": "# First" });
    // One item directory plus a TODO.md is unambiguous: the directory wins.
    expect(await service.handle({ action: "discover", repo }, true)).toMatchObject({
      signals: expect.any(Array),
    });
    const ambiguous = await fixture({ "TODO.md": "- a" });
    await expect(
      service.handle({ action: "create", repo: ambiguous.repo, title: "x" }, true),
    ).rejects.toMatchObject({
      code: "needs_decision",
      question: expect.stringMatching(/single task list/u),
    });
    await service.handle(
      { action: "init", repo: ambiguous.repo, backend: "markdown", directory: "docs/work" },
      true,
    );
    const created = await service.handle(
      { action: "create", repo: ambiguous.repo, title: "Agent task" },
      true,
    );
    expect(created).toMatchObject({ item: { location: expect.stringMatching(/^docs\/work\//u) } });
    expect(existsSync(join(ambiguous.repo, ".clankie/work"))).toBe(false);
  });

  it("persists a Linear-shaped local fallback in the saved repo scope when Linear is disconnected", async () => {
    const { service, repo, stateDirectory, workspace } = await fixture();
    await service.handle(
      {
        action: "init",
        repo,
        backend: "linear",
        linearTeam: "VUH",
        linearProject: "Clankie",
        linearLabel: "repo-board",
      },
      true,
    );
    const created = await service.handle(
      { action: "create", repo, title: "Offline task", priority: 2 },
      true,
    );
    expect(created).toMatchObject({ item: { id: "LOCAL-VUH-1", priority: 2, labels: ["repo-board"] } });
    if (!("item" in created)) throw new Error("Expected an issue");
    const reopened = createWorkItemsService({
      stateDirectory,
      workspace: () => workspace,
      run: noGit,
      clock,
    });
    expect(await reopened.handle({ action: "show", repo, id: created.item.id }, true)).toMatchObject({
      item: { id: created.item.id, title: "Offline task", priority: 2 },
    });
    expect(await reopened.handle({ action: "list", repo }, true)).toMatchObject({
      items: [{ id: created.item.id }],
    });
    expect(existsSync(join(repo, ".clankie/work"))).toBe(false);
  });
});

describe("the work routes", () => {
  it("serves the CLI contract to the operator and read-only ops to devices", async () => {
    const { service, workspace } = await fixture();
    await service.handle({ action: "create", repo: "workspace", title: "Seen from the phone" }, true);
    const { app } = await createClankieApp({
      captain: createStubCaptain(),
      workItems: service,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
      authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
    });
    const post = (path: string, body: unknown, token = "owner") =>
      app.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post("/v1/work", { action: "repos" }, "nobody")).status).toBe(401);
    expect((await post("/v1/work", { action: "explode" })).status).toBe(400);
    expect((await post("/v1/work", { action: "show", repo: "workspace", id: "W-none00" })).status).toBe(404);
    const listed = (await (await post("/v1/work", { action: "list", repo: workspace })).json()) as {
      items: { title: string }[];
    };
    expect(listed.items.map((item) => item.title)).toEqual(["Seen from the phone"]);

    const repos = (await (
      await post(OPERATOR_CONVERSATION_DISPATCH_PATH, { op: "work_repos", schemaVersion: 1 })
    ).json()) as {
      repos: { id: string }[];
    };
    expect(repos.repos.map((repo) => repo.id)).toContain("workspace");
    const items = (await (
      await post(OPERATOR_CONVERSATION_DISPATCH_PATH, {
        op: "work_items",
        schemaVersion: 1,
        repoId: "workspace",
      })
    ).json()) as { result: { outcome: string; items: { title: string }[] } };
    expect(items.result).toMatchObject({ outcome: "ready", items: [{ title: "Seen from the phone" }] });
    const unknown = (await (
      await post(OPERATOR_CONVERSATION_DISPATCH_PATH, {
        op: "work_items",
        schemaVersion: 1,
        repoId: "nope-12345678",
      })
    ).json()) as { result: { outcome: string } };
    expect(unknown.result.outcome).toBe("unavailable");

    // A role station reads its backlog by label (ADR 0208).
    const [file] = readdirSync(join(workspace, ".clankie/work"));
    const path = join(workspace, ".clankie/work", file!);
    writeFileSync(path, readFileSync(path, "utf8").replace(/^---\n/u, "---\nlabels: [Designer]\n"));
    const station = async (label: string) =>
      (
        (await (
          await post(OPERATOR_CONVERSATION_DISPATCH_PATH, {
            op: "work_items",
            schemaVersion: 1,
            repoId: "workspace",
            label,
          })
        ).json()) as { result: { items: { title: string; labels?: string[] }[] } }
      ).result.items;
    expect(await station("designer")).toMatchObject([{ title: "Seen from the phone", labels: ["Designer"] }]);
    expect(await station("builder")).toEqual([]);
    const cli = (await (
      await post("/v1/work", { action: "list", repo: workspace, label: "DESIGNER" })
    ).json()) as { items: unknown[] };
    expect(cli.items).toHaveLength(1);
  });
});

it("negotiates backlog at the device boundary and exposes project facts over the authenticated API", async () => {
  const { service, workspace } = await fixture();
  await service.handle(
    {
      action: "init",
      repo: "workspace",
      backend: "default",
      releaseSource: "milestones",
      releaseLane: "mobile",
    },
    true,
  );
  await service.handle(
    { action: "create", repo: "workspace", title: "Later work", status: "backlog", priority: 2 },
    true,
  );
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    workItems: service,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const dispatch = async (body: unknown) => {
    const response = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  expect(await dispatch({ op: "work_items", schemaVersion: 1, repoId: "workspace" })).toMatchObject({
    result: { items: [{ status: "todo" }] },
  });
  expect(
    await dispatch({ op: "work_items", schemaVersion: 1, repoId: "workspace", statusVersion: 2 }),
  ).toMatchObject({ result: { items: [{ status: "backlog", priority: 2 }] } });
  expect(await dispatch({ op: "work_project", schemaVersion: 1, repoId: "workspace" })).toMatchObject({
    result: {
      outcome: "ready",
      releaseSource: "milestones",
      planned: [],
      shipped: [],
      goals: [],
      unavailable: [{ read: "planned" }],
    },
  });
  expect(await dispatch({ op: "work_project", schemaVersion: 1, repoId: "unknown" })).toMatchObject({
    result: { outcome: "unavailable" },
  });
  await expect(service.handle({ action: "project", repo: workspace }, false)).rejects.toMatchObject({
    code: "unknown_repo",
  });
});
