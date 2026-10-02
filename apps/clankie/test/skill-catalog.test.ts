import { expect, it } from "vitest";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import {
  invocableSkills,
  listedSkillRoots,
  quietMachineSkills,
  skillSearchExtension,
} from "../src/captain/skill-catalog.ts";
import { resolveOperatorPrompt } from "../src/captain/captain.ts";

function skill(name: string, filePath: string, description = `${name} skill`, explicitOnly = false): Skill {
  return {
    name,
    description,
    filePath,
    baseDir: filePath.slice(0, filePath.lastIndexOf("/")),
    sourceInfo: {} as Skill["sourceInfo"],
    disableModelInvocation: explicitOnly,
  };
}

const roots = listedSkillRoots("/repo", "/work/app");
const loaded = [
  skill("this-machine", "/repo/.agents/skills/this-machine/SKILL.md"),
  skill("release-clankie", "/repo/.agents/dev-skills/release-clankie/SKILL.md"),
  skill("app-deploy", "/work/app/.agents/skills/app-deploy/SKILL.md"),
  skill(
    "davinci-resolve",
    "/home/.agents/skills/davinci-resolve/SKILL.md",
    "Edit video timelines in Resolve",
  ),
  skill("house-hunting", "/home/.agents/skills/house-hunting/SKILL.md", "Compare listings and neighborhoods"),
  skill("explicit", "/home/.agents/skills/explicit/SKILL.md", "Only on request", true),
];

it("lists Clankie's own and the workspace's skills and quiets the machine-wide ones", () => {
  const quieted = new Set<string>();
  const skills = quietMachineSkills(loaded, roots, quieted);
  const prompt = formatSkillsForPrompt(skills);
  for (const name of ["this-machine", "release-clankie", "app-deploy"])
    expect(prompt).toContain(`<name>${name}</name>`);
  for (const name of ["davinci-resolve", "house-hunting", "explicit"])
    expect(prompt).not.toContain(`<name>${name}</name>`);
  expect([...quieted].sort()).toEqual(["davinci-resolve", "house-hunting"]);
  // A sibling directory that only shares a prefix is not inside a listed root.
  expect(
    quietMachineSkills([skill("x", "/repo/.agents/skills-old/x/SKILL.md")], roots, quieted)[0]!
      .disableModelInvocation,
  ).toBe(true);
});

it("keeps an owner's /name working for quieted skills but not author-disabled ones", () => {
  const quieted = new Set<string>();
  const skills = invocableSkills(quietMachineSkills(loaded, roots, quieted), quieted);
  expect(resolveOperatorPrompt("/davinci-resolve cut the intro", skills)).toEqual({
    prompt: "/skill:davinci-resolve cut the intro",
    skillName: "davinci-resolve",
  });
  expect(resolveOperatorPrompt("/explicit", skills).skillName).toBeUndefined();
});

it("finds quieted skills by task and names the file to read", async () => {
  const quieted = new Set<string>();
  const skills = quietMachineSkills(loaded, roots, quieted);
  const tools = new Map<
    string,
    { execute: (id: string, params: unknown) => Promise<{ details: unknown }> }
  >();
  const handlers = new Map<string, () => void>();
  let active = ["read", "bash"];
  const pi = {
    registerTool: (tool: {
      name: string;
      execute: (id: string, params: unknown) => Promise<{ details: unknown }>;
    }) => tools.set(tool.name, tool),
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => (active = names),
  };
  const extension = skillSearchExtension(() => skills, quieted);
  if (typeof extension === "function") throw new Error("expected a named extension");
  await extension.factory(pi as never);
  handlers.get("session_start")!();
  expect(active).toContain("skill_search");

  const search = tools.get("skill_search")!;
  const result = (await search.execute("1", { query: "edit video in resolve" })).details as {
    matches: { name: string; location: string }[];
  };
  expect(result.matches[0]).toEqual({
    name: "davinci-resolve",
    description: "Edit video timelines in Resolve",
    location: "/home/.agents/skills/davinci-resolve/SKILL.md",
  });
  // Listed and author-disabled skills are not search results.
  const listedOnly = (await search.execute("2", { query: "machine explicit request" })).details as {
    matches: unknown[];
  };
  expect(listedOnly.matches).toEqual([]);
});
