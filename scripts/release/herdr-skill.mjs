import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Release copies are dereferenced; write each projection after installing Herdr.
const skillPaths = [
  ".agents/skills/herdr/SKILL.md",
  "integrations/claude-plugin/skills/herdr/SKILL.md",
  "integrations/worker-skills/skills/herdr/SKILL.md",
];

export async function bundleHerdrSkill(root, binary, version, check = false) {
  const actual = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  if (actual !== `herdr ${version}`) {
    throw new Error(`Herdr skill version mismatch: expected herdr ${version}, got ${actual}`);
  }
  const skill = execFileSync(binary, ["--skill"]);
  if (!skill.toString("utf8").startsWith("---\nname: herdr\n")) {
    throw new Error("Herdr --skill did not produce a skill document");
  }
  for (const path of skillPaths) {
    const destination = join(root, path);
    if (check) {
      const current = await readFile(destination);
      if (!skill.equals(current)) {
        throw new Error(`Herdr skill drift: ${path}; run pnpm herdr:skill`);
      }
    } else {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, skill);
    }
  }
  process.stdout.write(`Herdr ${version} skill ${check ? "verified" : "generated"} in all bundled roots\n`);
}
