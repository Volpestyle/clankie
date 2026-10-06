import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundledSkills } from "@clankie/settings";
import { runSkillsCommand } from "../src/command/skills.ts";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import { discoverClankieSkills } from "../src/skill-catalog.ts";
import { captainSkills } from "../../clankie/src/captain/composer-catalog.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const repoRoot = join(import.meta.dirname, "../../..");

it("lists every shipped skill read-only", async () => {
  const listed = await runSkillsCommand([], { repoRoot });
  expect(listed.catalog).toEqual(bundledSkills(repoRoot));
  expect(listed.catalog.map((skill) => skill.name)).toEqual(expect.arrayContaining(["lead", "this-machine"]));
  await expect(runSkillsCommand(["opinionated", "off"], { repoRoot })).rejects.toThrow("Usage");
  await expect(runSkillsCommand(["exclude", "lead"], { repoRoot })).rejects.toThrow("Usage");
  let output = "";
  expect(
    await runHeadlessCaptainCommand(["skills"], {
      repoRoot,
      stdout: {
        write: (value) => {
          output += value;
        },
      },
    }),
  ).toBe(0);
  expect(JSON.parse(output).catalog).toContainEqual(expect.objectContaining({ name: "lead" }));
  expect(buildConsoleCommands({ repoRoot }).find((command) => command.name === "skills")).toBeDefined();
});

it("agrees between Pi session paths and both composer catalogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-catalog-selection-"));
  roots.push(root);
  const tui = await discoverClankieSkills(repoRoot, { HOME: root });
  const pi = captainSkills({ cwd: root, repoRoot });
  for (const catalog of [tui, pi]) {
    expect(catalog.some((skill) => skill.name === "lead")).toBe(true);
    expect(catalog.some((skill) => skill.name === "this-machine")).toBe(true);
  }
});
