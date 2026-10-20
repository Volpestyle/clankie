import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The shipped skill is a loader for `herdr --skill`; release copies are dereferenced.
const skillPaths = [
  ".agents/skills/herdr/SKILL.md",
  "integrations/claude-plugin/skills/herdr/SKILL.md",
  "integrations/worker-skills/skills/herdr/SKILL.md",
];

/** Prove the pinned binary serves its skill and every bundled root ships the same loader. */
export async function bundleHerdrSkill(root, binary, version, check = false) {
  const actual = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  if (actual !== `herdr ${version}`) {
    throw new Error(`Herdr skill version mismatch: expected herdr ${version}, got ${actual}`);
  }
  const skill = execFileSync(binary, ["--skill"], { encoding: "utf8" });
  if (!skill.startsWith("---\nname: herdr\n")) {
    throw new Error("Herdr --skill did not produce a skill document");
  }
  let loader;
  for (const path of skillPaths) {
    const current = await readFile(join(root, path), "utf8");
    if (!current.startsWith("---\nname: herdr\n") || !current.includes("herdr --skill")) {
      throw new Error(`Herdr skill ${path} is not the herdr --skill loader`);
    }
    loader ??= current;
    if (current !== loader) throw new Error(`Herdr skill drift: ${path} differs from ${skillPaths[0]}`);
  }
  process.stdout.write(
    `Herdr ${version} skill loader ${check ? "checked" : "verified"} in all bundled roots\n`,
  );
}
