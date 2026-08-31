import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { codexCatalogSkills, seatComposerCatalog } from "../src/captain/composer-catalog.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function writeSkill(directory: string, name: string, description: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

describe("composer catalog", () => {
  it("discovers only the selected seat's skills and uses its harness syntax", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-composer-"));
    temporaryDirectories.push(root);
    const home = join(root, "home");
    const claudeProject = join(root, "claude-project");
    const piProject = join(root, "pi-project");
    await writeSkill(join(home, ".agents", "skills", "shared"), "shared", "Shared skill");
    await writeSkill(join(claudeProject, ".claude", "skills", "claude-only"), "claude-only", "Claude skill");
    await writeSkill(join(piProject, ".pi", "skills", "pi-only"), "pi-only", "Pi skill");

    expect(
      (await seatComposerCatalog({ harness: "claude", workingDirectory: claudeProject }, home)).skills,
    ).toEqual([
      { name: "claude-only", description: "Claude skill", source: "claude", invocation: "/claude-only" },
      { name: "shared", description: "Shared skill", source: "claude", invocation: "/shared" },
    ]);
    expect((await seatComposerCatalog({ harness: "pi", workingDirectory: piProject }, home)).skills).toEqual([
      { name: "pi-only", description: "Pi skill", source: "pi", invocation: "/skill:pi-only" },
      { name: "shared", description: "Shared skill", source: "pi", invocation: "/skill:shared" },
    ]);
  });

  it("keeps only enabled skills from Codex's authoritative catalog, including plugins", () => {
    expect(
      codexCatalogSkills({
        data: [
          {
            cwd: "/repo",
            errors: [],
            skills: [
              { name: "review", description: "Review work", enabled: true },
              { name: "browser:control-in-app-browser", description: "Control browser", enabled: true },
              { name: "disabled", description: "Hidden", enabled: false },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        name: "browser:control-in-app-browser",
        description: "Control browser",
        source: "codex",
        invocation: "$browser:control-in-app-browser",
      },
      { name: "review", description: "Review work", source: "codex", invocation: "$review" },
    ]);
  });
});
