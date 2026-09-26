import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
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
    const { service, repo } = await fixture();
    const before = await service.handle({ action: "repos" }, true);
    expect(before).toEqual({ repos: [expect.objectContaining({ id: "workspace", needsDecision: true })] });
    const created = await service.handle(
      { action: "create", repo, title: "Board view", criteria: ["iPhone"] },
      true,
    );
    expect(created).toMatchObject({ item: { status: "todo", criteria: [{ text: "iPhone", done: false }] } });
    const repos = await service.handle({ action: "repos" }, true);
    const registered = "repos" in repos ? repos.repos.find((entry) => entry.id !== "workspace") : undefined;
    expect(registered).toMatchObject({ backend: "default", needsDecision: false });
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

  it("names the recorded backend when it cannot be reached rather than falling back to files", async () => {
    const { service, repo } = await fixture();
    await service.handle({ action: "init", repo, backend: "linear", linearTeam: "VUH" }, true);
    await expect(service.handle({ action: "list", repo }, true)).rejects.toMatchObject({
      code: "backend_unavailable",
      message: expect.stringMatching(/Linear \(VUH\)/u),
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
  });
});
