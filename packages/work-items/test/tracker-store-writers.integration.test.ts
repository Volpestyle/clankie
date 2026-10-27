import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createLocalTracker } from "../src/tracker-local.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));
/** A separate Node process that opens the same store and makes one keyed write. */
async function writeFromAnotherProcess(directory: string, title: string): Promise<{ id: string }> {
  const script = `
    const { createLocalTracker } = await import(${JSON.stringify(source)});
    const tracker = createLocalTracker({ directory: ${JSON.stringify(directory)} });
    const issue = await tracker.call("save_issue", { team: "LOCAL", title: ${JSON.stringify(title)} });
    process.stdout.write(JSON.stringify(issue));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
  return JSON.parse(stdout) as { id: string };
}

// LOCAL-VUH-42: a backend keeps its committed store in memory across writes. Another
// process's or another instance's commit must be seen on the next lock acquisition, so no
// write is lost and the sync, event and audit chains stay one sequence.
it("sees commits from another process and another instance before its next write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tracker-store-writers-"));
  roots.push(directory);
  const service = createLocalTracker({ directory });
  const sibling = createLocalTracker({ directory });
  const titles = ["service 1"];
  await service.call("save_issue", { team: "LOCAL", title: "service 1" });
  for (let round = 1; round <= 3; round++) {
    titles.push(`other process ${String(round)}`);
    await writeFromAnotherProcess(directory, `other process ${String(round)}`);
    titles.push(`sibling ${String(round)}`);
    await sibling.call("save_issue", { team: "LOCAL", title: `sibling ${String(round)}` });
    titles.push(`service ${String(round + 1)}`);
    await service.call("save_issue", { team: "LOCAL", title: `service ${String(round + 1)}` });
  }
  const listed = (await service.call("list_issues", { limit: 50 })) as { issues: { title: string }[] };
  expect(listed.issues.map((issue) => issue.title).sort()).toEqual([...titles].sort());
  // A fresh open verifies every chain; one commit per write, in one order.
  const reopened = createLocalTracker({ directory });
  const page = await reopened.sync({
    action: "subscribe",
    projects: ["unprojected"],
    storeId: await reopened.storeId(),
    lastSyncId: 0,
    waitMs: 0,
    limit: 100,
  });
  expect(page).toMatchObject({ outcome: "deltas", lastSyncId: titles.length });
  const created = (
    page as {
      commits: {
        syncId: number;
        deltas: { modelName: string; action: string; data: { title?: string } }[];
      }[];
    }
  ).commits.map(
    (commit) =>
      commit.deltas.find((delta) => delta.modelName === "issue" && delta.action === "insert")?.data.title,
  );
  expect(created).toEqual(titles);
}, 60_000);
