import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
// The records that kept their numbers and the ones renumbered away from them (VUH-2396).
const current = [
  "0098-user-session-watches-discord-shares.md",
  "0189-his-own-linear-activity-does-not-wake-him.md",
  "0191-work-is-tracked-where-the-repo-tracks-it.md",
  "0207-work-records-and-native-agent-delivery.md",
  "0275-the-room-can-type-to-a-playthrough.md",
  "0276-agent-sessions-read-from-their-transcripts.md",
  "0277-a-reply-to-his-post-goes-to-whoever-owns-the-work.md",
  "0278-workers-publish-through-one-clankie-app.md",
];
function fixture(extra: string[]) {
  const root = mkdtempSync(join(tmpdir(), "adr-check-"));
  roots.push(root);
  for (const dir of [
    "scripts",
    "docs/adr",
    ".claude/skills",
    ".codex/skills",
    "integrations/claude-plugin/skills",
  ])
    mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(
    new URL("../../../scripts/check-doc-links.mjs", import.meta.url),
    join(root, "scripts/check-doc-links.mjs"),
  );
  for (const name of [...current, ...extra])
    writeFileSync(join(root, "docs/adr", name), `# ADR ${name.slice(0, 4)}\n`);
  return spawnSync(process.execPath, [join(root, "scripts/check-doc-links.mjs")], { encoding: "utf8" });
}
it("accepts unique new records alongside the renumbered ones", () => {
  const result = fixture(["0253-owner-confirmation.md", "0254-play-kernel.md"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("ADR numbers have no new collisions");
});
it("rejects a new duplicate and names both records", () => {
  const result = fixture(["0253-owner-confirmation.md", "0253-play-kernel.md"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Duplicate ADR 0253: 0253-owner-confirmation.md, 0253-play-kernel.md");
});
it("no longer exempts a former historical pair", () => {
  const result = fixture(["0098-the-room-can-type-to-a-playthrough.md"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "Duplicate ADR 0098: 0098-the-room-can-type-to-a-playthrough.md, 0098-user-session-watches-discord-shares.md",
  );
});
