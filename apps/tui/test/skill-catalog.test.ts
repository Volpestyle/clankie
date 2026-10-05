import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

    await expect(
      discoverClankieSkills(repo, { HOME: home, XDG_CONFIG_HOME: join(root, "config") }),
    ).resolves.toEqual([
      { name: "linked-skill", description: "A linked user skill" },
      { name: "preferred-skill", description: "Project Pi version" },
      { name: "project-skill", description: "Project version" },
    ]);
  });

  it("discovers checkout-only skills from .agents/dev-skills without hiding product skills", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-dev-skills-"));
    temporaryDirectories.push(root);
    const repo = join(root, "repo");
    const home = join(root, "home");
    await skill(
      join(repo, ".agents", "skills", "this-machine"),
      "name: this-machine\ndescription: Product install map",
    );
    await skill(
      join(repo, ".agents", "dev-skills", "verify-clankie"),
      "name: verify-clankie\ndescription: Checkout proof ladder",
    );

    await expect(
      discoverClankieSkills(repo, { HOME: home, XDG_CONFIG_HOME: join(root, "config") }),
    ).resolves.toEqual([
      { name: "this-machine", description: "Product install map" },
      { name: "verify-clankie", description: "Checkout proof ladder" },
    ]);
  });
});

it("discovers the shipped tidy declaration and submits /tidy as a visible stoppable turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tidy-skill-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo"),
    home = join(root, "home");
  const file = await readFile(
    new URL("../../../vendor/opinionated-skills/agent/tidy/SKILL.md", import.meta.url),
    "utf8",
  );
  await mkdir(join(repo, ".agents", "skills", "tidy"), { recursive: true });
  await writeFile(join(repo, ".agents", "skills", "tidy", "SKILL.md"), file);
  const skills = await discoverClankieSkills(repo, { HOME: home, XDG_CONFIG_HOME: join(root, "config") });
  expect(skills).toMatchObject([
    { name: "tidy", quickAction: { name: "Tidy up", icon: "broom", selectionArg: "selection" } },
  ]);
  const { ClankieFaceShell } = await import("../src/shell/shell.ts");
  let text: string | undefined, signal: AbortSignal | undefined;
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const shell = new ClankieFaceShell({
    commands: [],
    cwd: repo,
    env: {},
    skills,
    bannerFields: { title: "Clankie" },
    onPrompt: async (prompt, active, abort) => {
      text = prompt;
      signal = abort;
      active.insertAssistantMarkdown("Inspecting Pip's saved report");
      started();
      await new Promise<void>((resolve) => abort.addEventListener("abort", () => resolve(), { once: true }));
    },
  });
  const internals = shell as unknown as {
    handleSlashPrompt(prompt: string, delivery: "steer"): Promise<void>;
    routeInput(data: string): unknown;
    chat: { render(width: number): string[] };
  };
  const turn = internals.handleSlashPrompt("/tidy selection=w1:p1", "steer");
  await admitted;
  expect(text).toBe("/tidy selection=w1:p1");
  expect(internals.chat.render(80).join("\n")).toContain("Inspecting Pip");
  internals.routeInput("\x1b");
  await turn;
  expect(signal?.aborted).toBe(true);
});
