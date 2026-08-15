import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { ClankieAutocompleteSkill } from "./face/clankie-autocomplete.ts";

export async function discoverClankieSkills(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly ClankieAutocompleteSkill[]> {
  const home = env.HOME?.trim() || homedir();
  const piAgentDir = env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  const skills = new Map<string, ClankieAutocompleteSkill>();
  const visitedDirectories = new Set<string>();
  const visitedFiles = new Set<string>();

  for (const root of [
    join(repoRoot, ".pi", "skills"),
    join(repoRoot, ".agents", "skills"),
    join(piAgentDir, "skills"),
    join(home, ".agents", "skills"),
  ]) {
    await visitSkillDirectory(root, skills, visitedDirectories, visitedFiles);
  }

  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function visitSkillDirectory(
  directory: string,
  skills: Map<string, ClankieAutocompleteSkill>,
  visitedDirectories: Set<string>,
  visitedFiles: Set<string>,
): Promise<void> {
  let canonicalDirectory: string;
  let entries;
  try {
    canonicalDirectory = await realpath(directory);
    if (visitedDirectories.has(canonicalDirectory)) return;
    visitedDirectories.add(canonicalDirectory);
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  const skillFile = entries.find((entry) => entry.name === "SKILL.md");
  if (skillFile !== undefined) {
    await addSkill(join(directory, skillFile.name), skills, visitedFiles);
    return;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isFile()) {
      if (entry.name.endsWith(".md")) await addSkill(path, skills, visitedFiles);
      continue;
    }
    if (entry.isDirectory()) {
      await visitSkillDirectory(path, skills, visitedDirectories, visitedFiles);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    try {
      const target = await stat(path);
      if (target.isDirectory()) await visitSkillDirectory(path, skills, visitedDirectories, visitedFiles);
      else if (target.isFile() && entry.name.endsWith(".md")) await addSkill(path, skills, visitedFiles);
    } catch {
      // A broken skill link is simply unavailable.
    }
  }
}

async function addSkill(
  path: string,
  skills: Map<string, ClankieAutocompleteSkill>,
  visitedFiles: Set<string>,
): Promise<void> {
  try {
    const canonicalPath = await realpath(path);
    if (visitedFiles.has(canonicalPath)) return;
    visitedFiles.add(canonicalPath);
    const content = await readFile(path, "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
    if (frontmatter === undefined) return;
    const metadata = parse(frontmatter) as unknown;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return;
    const fields = metadata as Record<string, unknown>;
    if (fields["disable-model-invocation"] === true) return;
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(name) || skills.has(name)) return;
    const description =
      typeof fields.description === "string" ? fields.description.replace(/\s+/gu, " ").trim() : "";
    skills.set(name, { name, description });
  } catch {
    // Invalid or unreadable skills do not belong in typeahead.
  }
}
