import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  clankieSlashSkillSuffix,
  discoverClankieSkills,
  resolveClankieSlashSkill,
} from "../src/skill-catalog.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function skill(directory: string, frontmatter: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Instructions\n`);
}

describe("skill catalog", () => {
  it("offers an append-only slash suffix and resolves only exact skill names", () => {
    const skills = [
      { name: "ponytail", description: "" },
      { name: "ponytail-review", description: "" },
    ];

    expect(clankieSlashSkillSuffix("/pony", skills)).toBe("tail");
    expect(clankieSlashSkillSuffix("/ponytail ", skills)).toBeUndefined();
    expect(resolveClankieSlashSkill("/pony fix this", skills)).toBeUndefined();
    expect(resolveClankieSlashSkill("/ponytail fix this", skills)?.name).toBe("ponytail");
    expect(resolveClankieSlashSkill("/skill:ponytail fix this", skills)?.name).toBe("ponytail");
  });

  it("uses Pi discovery while preserving root precedence and hidden-name fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-skills-"));
    temporaryDirectories.push(root);
    const repo = join(root, "repo");
    const home = join(root, "home");
    const shared = join(root, "shared");

    await skill(
      join(repo, ".agents", "skills", "project"),
      "name: project-skill\ndescription: Project version",
    );
    await skill(
      join(repo, ".pi", "skills", "preferred"),
      "name: preferred-skill\ndescription: Project Pi version",
    );
    await skill(shared, "name: linked-skill\ndescription: >-\n  A linked user\n  skill");
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await symlink(shared, join(home, ".agents", "skills", "linked-skill"));
    await skill(
      join(home, ".pi", "agent", "skills", "hidden"),
      "name: linked-skill\ndescription: Hidden duplicate\ndisable-model-invocation: true",
    );
    await skill(
      join(home, ".agents", "skills", "preferred"),
      "name: preferred-skill\ndescription: User version",
    );

    await expect(discoverClankieSkills(repo, { HOME: home })).resolves.toEqual([
      { name: "linked-skill", description: "A linked user skill" },
      { name: "preferred-skill", description: "Project Pi version" },
      { name: "project-skill", description: "Project version" },
    ]);
  });
});
