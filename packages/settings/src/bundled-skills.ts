import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SkillsSettings } from "./schema.ts";

/** The manifest survives release dereferencing: classification never depends on symlinks. */
export function bundledSkills(
  repoRoot: string,
  settings: SkillsSettings = { opinionated: true, exclude: [] },
) {
  const manifestPath = join(repoRoot, "vendor", "opinionated-skills.json");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { skills: Record<string, string> })
    : { skills: {} };
  const root = join(repoRoot, ".agents", "skills");
  return (existsSync(root) ? readdirSync(root) : [])
    .filter((name) => existsSync(join(root, name, "SKILL.md")))
    .sort()
    .map((name) => {
      const skillClass = Object.hasOwn(manifest.skills, name) ? "opinionated" : "product";
      return {
        name,
        class: skillClass,
        path: resolve(root, name),
        included: skillClass === "product" || (settings.opinionated && !settings.exclude.includes(name)),
      };
    });
}

/** Fresh per-launch projections cannot change a running session's catalog. */
async function projectSkillDirectory(
  stateDir: string,
  skills: readonly { name: string; path: string; included: boolean }[],
): Promise<string> {
  const parent = join(stateDir, "skill-projections");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(parent, "launch-")));
  await mkdir(join(root, "skills"));
  for (const skill of skills) {
    if (skill.included) await symlink(skill.path, join(root, "skills", skill.name));
  }
  return root;
}

/** A plugin cannot filter at runtime. Project its components and only selected skills. */
export async function projectSkillPlugin(
  source: string,
  stateDir: string,
  skills: readonly { name: string; path: string; included: boolean }[],
): Promise<string> {
  const root = await projectSkillDirectory(stateDir, skills);
  for (const name of await readdir(source)) {
    if (name !== "skills") await symlink(resolve(source, name), join(root, name));
  }
  return root;
}
