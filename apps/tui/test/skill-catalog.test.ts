import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { discoverClankieSkills } from "../src/skill-catalog.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function skill(directory: string, frontmatter: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\n${frontmatter}\n---\n\n# Instructions\n`);
}

describe("skill catalog", () => {
  it("discovers project and user skills, follows links, and hides non-model skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-skills-"));
    temporaryDirectories.push(root);
    const repo = join(root, "repo");
    const home = join(root, "home");
    const shared = join(root, "shared");

    await skill(
      join(repo, ".agents", "skills", "project"),
      "name: project-skill\ndescription: Project version",
    );
    await skill(shared, "name: linked-skill\ndescription: >-\n  A linked user\n  skill");
    await mkdir(join(home, ".agents", "skills"), { recursive: true });
    await symlink(shared, join(home, ".agents", "skills", "linked-skill"));
    await skill(
      join(home, ".pi", "agent", "skills", "hidden"),
      "name: hidden-skill\ndescription: Hidden\ndisable-model-invocation: true",
    );

    await expect(discoverClankieSkills(repo, { HOME: home })).resolves.toEqual([
      { name: "linked-skill", description: "A linked user skill" },
      { name: "project-skill", description: "Project version" },
    ]);
  });
});
