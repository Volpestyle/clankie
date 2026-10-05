import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captainComposerCatalog,
  composerCatalogResponse,
  codexCatalogSkills,
  seatComposerCatalog,
} from "../src/captain/composer-catalog.ts";

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

it("publishes a skill's validated quick-action declaration through Clankie and native seat catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-quick-action-"));
  temporaryDirectories.push(root);
  const skillPath = join(root, ".agents", "skills", "tidy");
  await mkdir(skillPath, { recursive: true });
  const filePath = join(skillPath, "SKILL.md");
  await writeFile(
    filePath,
    "---\nname: tidy\ndescription: Tidy finished worker panes\nquick-action:\n  name: Tidy up\n  icon: broom\n  selectionArg: selection\n---\nJudge the work, then close with a reason.\n",
  );
  const declaration = { name: "Tidy up", icon: "broom", selectionArg: "selection" };
  const catalog = captainComposerCatalog({ cwd: root, repoRoot: root });
  expect(
    composerCatalogResponse(catalog).skills.find((skill) => skill.name === "tidy")?.quickAction,
  ).toBeUndefined();
  expect(
    composerCatalogResponse(catalog, true).skills.find((skill) => skill.name === "tidy")?.quickAction,
  ).toEqual(declaration);
  expect(
    captainComposerCatalog({ cwd: root, repoRoot: root }).skills.find((skill) => skill.name === "tidy"),
  ).toMatchObject({ quickAction: declaration });
  expect(
    (await seatComposerCatalog({ harness: "claude", workingDirectory: root }, join(root, "home"))).skills,
  ).toMatchObject([{ name: "tidy", quickAction: declaration }]);
  expect(
    codexCatalogSkills({
      data: [
        { skills: [{ name: "tidy", description: "Tidy finished panes", enabled: true, path: filePath }] },
      ],
    }),
  ).toMatchObject([{ name: "tidy", quickAction: declaration }]);
  await writeFile(
    filePath,
    "---\nname: tidy\ndescription: Tidy finished worker panes\nquick-action:\n  name: Tidy up\n  icon: ../unsafe\n---\nJudge the work.\n",
  );
  const invalid = (
    await seatComposerCatalog({ harness: "claude", workingDirectory: root }, join(root, "home"))
  ).skills[0]!;
  expect(invalid.name).toBe("tidy");
  expect(invalid.quickAction).toBeUndefined();
});
