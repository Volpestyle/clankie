import { cp, mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { bundledSkills } from "../../packages/settings/src/bundled-skills.ts";

/** Ship the selected bundle, independent of the build machine's owner settings. */
export async function copySkillAssets(repoRoot, targetRoot) {
  const skills = bundledSkills(repoRoot);
  for (const plugin of ["claude-plugin", "worker-skills"]) {
    const source = join(repoRoot, "integrations", plugin);
    await cp(source, join(targetRoot, "integrations", plugin), {
      recursive: true,
      dereference: true,
      filter: (path) => path !== join(source, "skills") && basename(path) !== ".DS_Store",
    });
  }
  for (const directory of [
    ".agents/skills",
    "integrations/claude-plugin/skills",
    "integrations/worker-skills/skills",
  ]) {
    await mkdir(join(targetRoot, directory), { recursive: true });
    for (const skill of skills) {
      await cp(skill.path, join(targetRoot, directory, skill.name), {
        recursive: true,
        dereference: true,
        filter: (path) => basename(path) !== ".DS_Store",
      });
    }
  }
}
