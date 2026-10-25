import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalTracker } from "@clankie/work-items";
import { workRequest } from "../../tui/src/command/work.ts";
import { createWorkItemsService, WorkRequestSchema } from "../src/work-items.ts";

// VUH-2805: `work ready --project P` lists built-in items; show/activity/update/close/attach
// with the same --project must reach them, whatever repo or repo reference the CLI names.
it("routes built-in items by explicit project ahead of every repo reference, local callers only", async () => {
  const root = await mkdtemp(join(tmpdir(), "work-builtin-project-"));
  try {
    const directory = join(root, "tracker");
    const tracker = createLocalTracker({ directory });
    const team = ((await tracker.call("list_teams", {})) as { teams: { id: string }[] }).teams[0]!.id;
    const project = (await tracker.call("save_project", { name: "Clankie Work", addTeams: [team] })) as {
      id: string;
    };
    const other = (await tracker.call("save_project", { name: "Elsewhere", addTeams: [team] })) as {
      id: string;
    };
    const issue = (await tracker.call("save_issue", {
      team,
      project: project.id,
      title: "Built-in target",
      description: "Proof.\n\n## Acceptance Criteria\n\n- [ ] First\n- [ ] Second\n",
    })) as { id: string; identifier: string };
    const outside = (await tracker.call("save_issue", {
      team,
      project: other.id,
      title: "Other project",
    })) as { identifier: string };
    let connectedCalls = 0;
    const service = createWorkItemsService({
      stateDirectory: join(root, "state"),
      globalTrackerDirectory: directory,
      mcpHost: {
        call: async () => {
          connectedCalls += 1;
          throw new Error("No connected tracker call is expected");
        },
      } as never,
    });
    const run = async (args: string[], repo: string, local = true) => {
      try {
        return { result: await service.handle(WorkRequestSchema.parse(workRequest(args, repo)), local) };
      } catch (error) {
        return { error: (error as { code?: string }).code ?? String(error) };
      }
    };
    const scoped = { repo: { id: "builtin", trackerProjectId: project.id, backend: "builtin" } };

    for (const repo of [
      root,
      "some-registered-id",
      "linear-00000000-0000-4000-8000-000000000000",
      `project-${"a".repeat(48)}`,
    ]) {
      for (const [id, selector] of [
        [issue.identifier, project.id],
        [issue.id, "Clankie Work"],
      ] as const) {
        expect(await run(["show", id, "--project", selector], repo)).toMatchObject({
          result: { ...scoped, item: { id: issue.identifier, title: "Built-in target" } },
        });
        expect(await run(["activity", id, "--project", selector], repo)).toMatchObject({
          result: { ...scoped, itemId: id },
        });
      }
      expect(
        await run(["update", issue.identifier, "--project", project.id, "--check", "2"], repo),
      ).toMatchObject({
        result: { ...scoped, item: { criteria: [{ done: false }, { done: true }] } },
      });
      expect(await run(["update", issue.id, "--project", project.id, "--uncheck", "2"], repo)).toMatchObject({
        result: { item: { criteria: [{ done: false }, { done: false }] } },
      });
      expect(
        await run(
          [
            "attach",
            issue.identifier,
            "--project",
            project.id,
            "--url",
            "https://example.com/proof.log",
            "--caption",
            "proof",
          ],
          repo,
        ),
      ).toMatchObject({ result: scoped });
      // Devices never use the explicit selector, whichever repo reference they send.
      for (const args of [
        ["show", issue.identifier, "--project", project.id],
        ["update", issue.identifier, "--project", project.id, "--check", "1"],
      ])
        expect(await run(args, repo, false)).toEqual({ error: "invalid" });
      // Another project's item is not found through this one, and the miss writes nothing.
      const before = await readFile(join(directory, "tracker.json"), "utf8");
      for (const args of [
        ["show", outside.identifier, "--project", project.id],
        ["close", outside.identifier, "--project", project.id],
        ["show", issue.identifier, "--project", "00000000-0000-4000-8000-000000000000"],
      ])
        expect(await run(args, repo)).toEqual({ error: "not_found" });
      expect(await readFile(join(directory, "tracker.json"), "utf8")).toBe(before);
    }

    // Close reaches the item, and the built-in tracker's own Done policy still decides:
    // this route carries no lead-closure authority.
    expect(await run(["close", issue.identifier, "--project", project.id], root)).toEqual({
      error: expect.stringContaining("owner_verification_required"),
    });
    // Without --project, a Linear repo reference keeps its read-only legacy route.
    expect(
      await run(["update", issue.identifier, "--check", "1"], "linear-00000000-0000-4000-8000-000000000000"),
    ).toEqual({ error: "invalid" });
    expect(connectedCalls).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
