import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
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

it("changes only the skill selection, reports classes, and refuses product exclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "skills-command-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const options = { repoRoot, settings };
  expect((await runSkillsCommand([], options)).skills).toEqual({ opinionated: true, exclude: [] });
  await settings.update((current) => ({ ...current, fleet: { ...current.fleet, notes: "preserve me" } }));
  const off = await runSkillsCommand(["opinionated", "off"], options);
  expect(off.catalog.filter((skill) => skill.class === "opinionated").every((skill) => !skill.included)).toBe(
    true,
  );
  expect(off.catalog.filter((skill) => skill.class === "product").every((skill) => skill.included)).toBe(
    true,
  );
  await runSkillsCommand(["exclude", "lead"], options);
  await runSkillsCommand(["exclude", "lead"], options);
  expect((await runSkillsCommand(["opinionated", "on"], options)).skills.exclude).toEqual(["lead"]);
  expect(
    (await runSkillsCommand(["include", "lead"], options)).catalog.find((skill) => skill.name === "lead")
      ?.included,
  ).toBe(true);
  await expect(runSkillsCommand(["exclude", "this-machine"], options)).rejects.toThrow("always on");
  await expect(runSkillsCommand(["exclude", "unknown-skill"], options)).rejects.toThrow("Unknown");
  await expect(runSkillsCommand(["opinionated", "nope"], options)).rejects.toThrow("Usage");
  expect((await settings.load()).fleet.notes).toBe("preserve me");
  let output = "";
  expect(
    await runHeadlessCaptainCommand(["skills"], {
      repoRoot,
      env: { CLANKIE_SETTINGS_FILE: settings.path },
      stdout: {
        write: (value) => {
          output += value;
        },
      },
    }),
  ).toBe(0);
  expect(JSON.parse(output).catalog).toContainEqual(
    expect.objectContaining({ name: "lead", class: "opinionated", included: true }),
  );
  expect(buildConsoleCommands(options).find((command) => command.name === "skills")).toBeDefined();
});

it.each([
  { opinionated: true, exclude: [], lead: true },
  { opinionated: false, exclude: [], lead: false },
  { opinionated: true, exclude: ["lead"], lead: false },
])("agrees between Pi session paths and both composer catalogs: %j", async (selection) => {
  const root = await mkdtemp(join(tmpdir(), "skill-catalog-selection-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    skills: { opinionated: selection.opinionated, exclude: selection.exclude },
  }));
  const tui = await discoverClankieSkills(repoRoot, { HOME: root, CLANKIE_SETTINGS_FILE: settings.path });
  const pi = captainSkills({ cwd: root, repoRoot, skills: selection });
  for (const catalog of [tui, pi]) {
    expect(catalog.some((skill) => skill.name === "lead")).toBe(selection.lead);
    expect(catalog.some((skill) => skill.name === "this-machine")).toBe(true);
  }
});

it("the TUI picker persists both the class toggle and an exclusion", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-picker-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const command = buildConsoleCommands({ repoRoot, settings }).find((entry) => entry.name === "skills")!;
  const choices = ["opinionated", "reflect", "done"];
  let ended = false;
  await command.run("", {
    setupFlow: {
      begin: () => {},
      readSelect: async () => choices.shift(),
      end: () => {
        ended = true;
      },
    },
  } as never);
  expect((await settings.load()).skills).toEqual({ opinionated: false, exclude: ["reflect"] });
  expect(ended).toBe(true);
});
