import { join, sep } from "node:path";
import { existsSync } from "node:fs";
import { clankieSkillRoots } from "@clankie/settings";
import {
  DefaultResourceLoader,
  loadProjectContextFiles,
  loadSkills,
  type InlineExtension,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolJson } from "./tools.ts";

const SKILL_SEARCH = "skill_search";

type CaptainResourceOptions = NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]> &
  Parameters<typeof clankieSkillRoots>[0] & { quieted: Set<string> };

export class CaptainResourceLoader extends DefaultResourceLoader {
  private readonly discovery: CaptainResourceOptions;

  constructor(discovery: CaptainResourceOptions) {
    super(discovery);
    this.discovery = discovery;
  }

  override getSkills() {
    const base = loadSkills({
      cwd: this.discovery.cwd,
      agentDir: this.discovery.agentDir,
      skillPaths: clankieSkillRoots(this.discovery).filter(existsSync),
      includeDefaults: false,
    });
    return {
      ...base,
      skills: quietMachineSkills(
        base.skills,
        listedSkillRoots(this.discovery.repoRoot, this.discovery.cwd),
        this.discovery.quieted,
      ),
    };
  }

  override getAgentsFiles() {
    return { agentsFiles: loadProjectContextFiles(this.discovery) };
  }
}

/**
 * The roots whose skills the prompt lists: the ones shipped with this body and
 * the workspace's own. Every other root (the owner's machine-wide skills, Pi's
 * agent directory) stays loadable but unlisted.
 */
export function listedSkillRoots(repoRoot: string, cwd: string): readonly string[] {
  return [
    join(repoRoot, ".pi", "skills"),
    join(repoRoot, ".agents", "skills"),
    join(repoRoot, ".agents", "dev-skills"),
    join(cwd, ".agents", "skills"),
  ];
}

/**
 * Pi lists every model-invocable skill on every turn. The machine-wide roots
 * hold dozens of skills for other work (about 13k tokens on the owner's Mac),
 * so those are left out of the listing (Pi's `disableModelInvocation`) and
 * recorded in `quieted`: an owner's `/name` still expands them, and
 * `skill_search` finds them by task. A skill its author marked explicit-only
 * keeps that meaning and is not recorded.
 */
export function quietMachineSkills(
  skills: readonly Skill[],
  listedRoots: readonly string[],
  quieted: Set<string>,
): Skill[] {
  const listed = (path: string) => listedRoots.some((root) => path.startsWith(`${root}${sep}`));
  quieted.clear();
  return skills.map((skill) => {
    if (skill.disableModelInvocation || listed(skill.filePath)) return skill;
    quieted.add(skill.name);
    return { ...skill, disableModelInvocation: true };
  });
}

/** What an owner's `/name` may expand: listed skills plus the quieted ones. */
export function invocableSkills(skills: readonly Skill[], quieted: ReadonlySet<string>): Skill[] {
  return skills.map((skill) =>
    quieted.has(skill.name) ? { ...skill, disableModelInvocation: false } : skill,
  );
}

/** Find unlisted skills by task; the result names the file to read. */
export function skillSearchExtension(
  skills: () => readonly Skill[],
  quieted: ReadonlySet<string>,
): InlineExtension {
  return {
    name: "captain-skill-search",
    hidden: true,
    factory(pi) {
      pi.registerTool({
        name: SKILL_SEARCH,
        label: "Find skills",
        description:
          "Find skills on this machine beyond the listed ones, such as the owner's skills for other tools and " +
          "projects. Search by task; read a match's file before following it. Use this before saying no skill covers a task.",
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 200 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          const terms = params.query
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean);
          const matches = skills()
            .filter((skill) => quieted.has(skill.name))
            .map((skill) => {
              const haystack = `${skill.name} ${skill.description}`.toLowerCase();
              return { skill, hits: terms.filter((term) => haystack.includes(term)).length };
            })
            .filter((entry) => entry.hits > 0)
            .sort((left, right) => right.hits - left.hits || left.skill.name.localeCompare(right.skill.name))
            .slice(0, params.limit ?? 5)
            .map(({ skill }) => ({
              name: skill.name,
              description: skill.description,
              location: skill.filePath,
            }));
          return toolJson({ matches });
        },
      });
      pi.on("session_start", () => {
        const active = pi.getActiveTools();
        if (!active.includes(SKILL_SEARCH)) pi.setActiveTools([...active, SKILL_SEARCH]);
      });
    },
  };
}
