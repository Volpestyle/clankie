import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundledSkills, projectSkillPlugin } from "../src/bundled-skills.ts";
import { clankieSkillRoots } from "../src/skill-roots.ts";
import { emptySettings, SkillsSettingsSchema } from "../src/schema.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const repo = join(import.meta.dirname, "../../..");

it("defaults on, validates selection, and classifies leadership as optional", () => {
  expect(emptySettings().skills).toEqual({ opinionated: true, exclude: [] });
  expect(() => SkillsSettingsSchema.parse({ opinionated: "off" })).toThrow();
  expect(() => SkillsSettingsSchema.parse({ exclude: ["../lead"] })).toThrow();
  const catalog = bundledSkills(repo);
  expect(catalog.every((skill) => skill.included)).toBe(true);
  for (const name of ["lead", "swarm-lead", "herdr-lead", "reflect"])
    expect(catalog.find((skill) => skill.name === name)?.class).toBe("opinionated");
  for (const name of [
    "this-machine",
    "trace-clankie",
    "work-items",
    "research-team",
    "computer-use-delegation",
    "desktop-control",
    "swarm-mcp",
    "herdr",
    "trip-planning",
  ])
    expect(catalog.find((skill) => skill.name === name)?.class).toBe("product");
});

it.each([
  { opinionated: true, exclude: [], lead: true, reflect: true },
  { opinionated: false, exclude: [], lead: false, reflect: false },
  { opinionated: true, exclude: ["lead", "this-machine"], lead: false, reflect: true },
])("projects a plugin with only the selected skills: %j", async (selection) => {
  const state = await mkdtemp(join(tmpdir(), "skill-plugin-"));
  roots.push(state);
  const catalog = bundledSkills(repo, selection);
  const plugin = await projectSkillPlugin(join(repo, "integrations/claude-plugin"), state, catalog);
  const names = await readdir(join(plugin, "skills"));
  expect(names.includes("lead")).toBe(selection.lead);
  expect(names.includes("reflect")).toBe(selection.reflect);
  expect(names).toContain("this-machine");
  expect(await readFile(join(plugin, "hooks/hooks.json"), "utf8")).toContain("seat-sync");
  expect(await readFile(join(plugin, "output-styles/clankie.md"), "utf8")).toContain("# Identity");
  expect(await readFile(join(plugin, ".mcp.json"), "utf8")).toContain('"clankie"');
});

it("filtered Pi roots cannot recover a disabled name from another root", async () => {
  const home = await mkdtemp(join(tmpdir(), "skill-roots-"));
  roots.push(home);
  for (const name of ["lead", "personal-tool"]) {
    await mkdir(join(home, ".agents/skills", name), { recursive: true });
    await writeFile(join(home, ".agents/skills", name, "SKILL.md"), "test");
  }
  const paths = clankieSkillRoots({
    repoRoot: repo,
    agentDir: join(home, ".pi"),
    home,
    cwd: repo,
    skills: { opinionated: false, exclude: [] },
  });
  expect(paths).toContain(join(home, ".agents/skills/personal-tool"));
  expect(paths.some((path) => path.endsWith("/lead") || path === join(repo, ".agents/skills"))).toBe(false);
  expect(paths).toContain(join(repo, ".agents/skills/this-machine"));
});
