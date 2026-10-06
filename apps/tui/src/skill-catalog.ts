import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SkillQuickActionSchema } from "@clankie/protocol";
import { loadSkills, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { clankieSkillRoots } from "@clankie/settings";
import type { ClankieAutocompleteSkill } from "./face/clankie-autocomplete.ts";

/** Complete only the appendable part of a leading slash skill token. */
export function clankieSlashSkillSuffix(
  text: string,
  skills: readonly ClankieAutocompleteSkill[],
): string | undefined {
  if (!text.startsWith("/") || /\s/u.test(text)) return undefined;
  const token = text.slice(1).toLowerCase();
  const prefix = token.startsWith("skill:") ? token.slice("skill:".length) : token;
  if (!/^[a-z0-9-]*$/u.test(prefix)) return undefined;
  const names = skills.map((skill) => skill.name).filter((name) => name.startsWith(prefix));
  const first = names[0];
  if (first === undefined) return undefined;
  let common = first;
  for (const name of names.slice(1)) {
    while (!name.startsWith(common)) common = common.slice(0, -1);
  }
  return common.slice(prefix.length);
}

/** Resolve an exact slash skill invocation; arguments remain model prompt text. */
export function resolveClankieSlashSkill(
  text: string,
  skills: readonly ClankieAutocompleteSkill[],
): ClankieAutocompleteSkill | undefined {
  const token = /^\/(\S+)(?:\s|$)/u.exec(text)?.[1]?.toLowerCase();
  if (token === undefined) return undefined;
  const name = token.startsWith("skill:") ? token.slice("skill:".length) : token;
  return skills.find((skill) => skill.name === name);
}

export async function discoverClankieSkills(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly ClankieAutocompleteSkill[]> {
  const home = env.HOME?.trim() || homedir();
  const piAgentDir = env.PI_CODING_AGENT_DIR?.trim() || join(home, ".pi", "agent");
  const skills = new Map<string, ClankieAutocompleteSkill>();

  for (const root of clankieSkillRoots({ repoRoot, agentDir: piAgentDir, home })) {
    const loaded = loadSkills({
      cwd: repoRoot,
      agentDir: piAgentDir,
      skillPaths: [root],
      includeDefaults: false,
    });
    for (const skill of loaded.skills) {
      if (!skill.disableModelInvocation && !skills.has(skill.name)) {
        let quickAction: ClankieAutocompleteSkill["quickAction"];
        try {
          const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
            readFileSync(skill.filePath, "utf8"),
          );
          const parsed = SkillQuickActionSchema.safeParse(frontmatter["quick-action"]);
          if (parsed.success) quickAction = parsed.data;
        } catch {
          /* Keep the skill loadable without inventing a quick action. */
        }
        skills.set(skill.name, {
          name: skill.name,
          description: skill.description,
          ...(quickAction ? { quickAction } : {}),
        });
      }
    }
  }

  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}
