import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Every skill authored in `.agents/skills` ships with this body and is always on. */
export function bundledSkills(repoRoot: string): { readonly name: string; readonly path: string }[] {
  const root = join(repoRoot, ".agents", "skills");
  return (existsSync(root) ? readdirSync(root) : [])
    .filter((name) => existsSync(join(root, name, "SKILL.md")))
    .sort()
    .map((name) => ({ name, path: resolve(root, name) }));
}

/** Fresh per-launch projections cannot change a running session's catalog. */
async function projectSkillDirectory(
  stateDir: string,
  skills: readonly { name: string; path: string }[],
): Promise<string> {
  const parent = join(stateDir, "skill-projections");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(parent, "launch-")));
  await mkdir(join(root, "skills"));
  for (const skill of skills) await symlink(skill.path, join(root, "skills", skill.name));
  return root;
}

/** A plugin cannot filter at runtime. Project its components and only the given skills. */
export async function projectSkillPlugin(
  source: string,
  stateDir: string,
  skills: readonly { name: string; path: string }[],
): Promise<string> {
  const root = await projectSkillDirectory(stateDir, skills);
  for (const name of await readdir(source)) {
    if (name !== "skills") await symlink(resolve(source, name), join(root, name));
  }
  return root;
}
