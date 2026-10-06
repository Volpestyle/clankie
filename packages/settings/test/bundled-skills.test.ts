import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundledSkills, projectSkillPlugin } from "../src/bundled-skills.ts";
import { clankieSkillRoots } from "../src/skill-roots.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const repo = join(import.meta.dirname, "../../..");

it("ships every repo-owned skill, leadership included, without retired names", () => {
  const names = bundledSkills(repo).map((skill) => skill.name);
  expect(names).not.toContain("swarm-lead");
  expect(names).not.toContain("herdr-lead");
  for (const name of [
    "lead",
    "reflect",
    "tidy",
    "this-machine",
    "trace-clankie",
    "work-items",
    "research-team",
    "computer-use-delegation",
    "desktop-control",
    "herdr",
    "trip-planning",
  ])
    expect(names).toContain(name);
});

it("projects a plugin with exactly the given skills and its components", async () => {
  const state = await mkdtemp(join(tmpdir(), "skill-plugin-"));
  roots.push(state);
  const catalog = bundledSkills(repo).filter((skill) => skill.name !== "lead");
  const plugin = await projectSkillPlugin(join(repo, "integrations/claude-plugin"), state, catalog);
  const names = await readdir(join(plugin, "skills"));
  expect(names).not.toContain("lead");
  expect(names).toContain("reflect");
  expect(names).toContain("this-machine");
  expect(await readFile(join(plugin, "hooks/hooks.json"), "utf8")).toContain("seat-sync");
  expect(await readFile(join(plugin, "output-styles/clankie.md"), "utf8")).toContain("# Identity");
  expect(await readFile(join(plugin, ".mcp.json"), "utf8")).toContain('"clankie"');
});

it("Pi roots exclude merged names and keep every other skill", async () => {
  const home = await mkdtemp(join(tmpdir(), "skill-roots-"));
  roots.push(home);
  for (const name of ["lead", "swarm-lead", "herdr-lead", "personal-tool"]) {
    await mkdir(join(home, ".agents/skills", name), { recursive: true });
    await writeFile(join(home, ".agents/skills", name, "SKILL.md"), "test");
  }
  const paths = clankieSkillRoots({ repoRoot: repo, agentDir: join(home, ".pi"), home, cwd: repo });
  expect(paths).toContain(join(home, ".agents/skills/personal-tool"));
  expect(paths).toContain(join(repo, ".agents/skills/lead"));
  expect(paths).toContain(join(home, ".agents/skills/lead"));
  expect(paths.some((path) => /\/(swarm-lead|herdr-lead)$/u.test(path))).toBe(false);
  expect(paths).not.toContain(join(home, ".agents/skills"));
  expect(paths).toContain(join(repo, ".agents/skills/this-machine"));
});
