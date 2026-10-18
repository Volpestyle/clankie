import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalTracker } from "../src/tracker-local.ts";

it("refuses saved-view sync results when the journal is replaced during the final access check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-view-store-fence-"));
  try {
    const tracker = createLocalTracker({ directory });
    const project = (await tracker.call("save_project", { name: "Original", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const scope = { project: project.id, storeId: await tracker.storeId() };
    const view = (await tracker.call("save_issue_view", {
      ...scope,
      schemaVersion: 1,
      name: "All",
      filter: {},
    })) as { id: string };
    const replacementDirectory = join(directory, "replacement");
    const replacement = createLocalTracker({ directory: replacementDirectory });
    await replacement.call("list_teams", {});
    const path = join(directory, "tracker.json");
    const original = await readFile(path);
    const replacementPath = join(replacementDirectory, "tracker.json");
    for (const command of [
      { action: "list_issue_views" as const, ...scope },
      { action: "list_issue_view_issues" as const, ...scope, id: view.id },
    ]) {
      await writeFile(path, original);
      let checks = 0;
      await expect(
        tracker.sync(command, {
          beforeWrite: async () => {
            checks++;
            if (checks === 2) await copyFile(replacementPath, path);
          },
        }),
      ).rejects.toThrow("Saved view tracker store mismatch");
      expect(checks).toBe(2);
      expect(await readFile(path)).toEqual(await readFile(replacementPath));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
