import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundledSkills } from "@clankie/settings";
// @ts-expect-error -- release assembly is plain ESM.
import { copySkillAssets } from "../../../scripts/release/skills.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("assembles only selected skills in all release projections, with no checkout dependencies", async () => {
  const repo = join(import.meta.dirname, "../../..");
  const release = await mkdtemp(join(tmpdir(), "release-skills-"));
  roots.push(release);
  await copySkillAssets(repo, release);
  await cp(join(repo, "vendor/opinionated-skills.json"), join(release, "vendor/opinionated-skills.json"), {
    recursive: true,
  });
  const selected = bundledSkills(repo).map((skill) => skill.name);
  for (const directory of [
    ".agents/skills",
    "integrations/claude-plugin/skills",
    "integrations/worker-skills/skills",
  ]) {
    const entries = await readdir(join(release, directory), { withFileTypes: true });
    expect(entries.map((entry) => entry.name).sort()).toEqual(selected);
    expect(entries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink())).toBe(true);
    for (const name of [
      "linear-write",
      "update-review-ethos",
      "mr-link",
      "linear-agent-session",
      "repo-evolution-review",
      "work-tracking",
    ])
      expect(selected).not.toContain(name);
    expect(await readFile(join(release, directory, "lead/SKILL.md"), "utf8")).toBe(
      await readFile(join(repo, "vendor/opinionated-skills/agent/lead/SKILL.md"), "utf8"),
    );
  }
  const off = bundledSkills(release, { opinionated: false, exclude: [] });
  expect(off.find((skill) => skill.name === "lead")?.included).toBe(false);
  expect(off.find((skill) => skill.name === "herdr")?.included).toBe(true);
  expect(
    bundledSkills(release, { opinionated: true, exclude: ["reflect"] }).find(
      (skill) => skill.name === "reflect",
    )?.included,
  ).toBe(false);
});
