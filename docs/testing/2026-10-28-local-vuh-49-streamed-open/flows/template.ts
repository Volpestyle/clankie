// Synthetic replacement for the deleted LOCAL-VUH-46/47 seed; never reads owner state.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createLocalTracker, exportTrackerStore } from "../../../../packages/work-items/src/index.ts";
const root = resolve(process.argv[2]!);
if (!root.includes("/.local/vuh49/")) throw new Error("Scratch root required");
await mkdir(root, { recursive: true });
const directory = join(root, "template-store");
const tracker = createLocalTracker({ directory });
const ids: string[] = [];
for (let i = 0; i < 966; i++) {
  const key = i < 687 ? { idempotencyKey: `synthetic-${i}` } : {};
  if (i < 90)
    ids.push(
      (
        (await tracker.call("save_issue", {
          team: "LOCAL",
          title: `Synthetic fleet issue ${i}`,
          ...key,
        })) as { id: string }
      ).id,
    );
  else if (i < 416)
    await tracker.call("save_comment", {
      issueId: ids[i % 90],
      body: `Evidence ${i} é 😺 \\"\n` + "x".repeat(6000),
      ...key,
    });
  else
    await tracker.call("save_issue", {
      id: ids[i % 90],
      priority: (i % 4) + 1,
      title: `Synthetic fleet update ${i}`,
      ...key,
    });
}
await exportTrackerStore(directory, join(root, "template.json"));
await writeFile(
  join(root, "mix.json"),
  JSON.stringify(
    {
      commits: 966,
      issues: 90,
      comments: 326,
      keyed: 687,
      commentBodyBytes: 6000,
      boundary:
        "Fully synthetic; same commit/issue/comment/receipt mix as LOCAL-VUH-42, different payloads and event proportions.",
    },
    null,
    2,
  ),
);
