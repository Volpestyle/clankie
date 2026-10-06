import { expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  formatSkillsForPrompt,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  CaptainResourceLoader,
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

it("refreshes real session resources without losing history, tools or skill exclusions", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "captain-resources-")));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const repoRoot = join(root, "body");
    const home = join(root, "owner");
    const cwd = join(home, "workspace");
    const agentDir = join(home, ".pi", "agent");
    const personal = join(home, ".agents", "skills");
    const workspace = join(cwd, ".agents", "skills");
    const recipe = join(root, "recipe");
    const replacement = join(root, "replacement");
    const writeSkill = async (path: string, name: string, description: string, explicitOnly = false) => {
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: ${explicitOnly}\n---\n${description}\n`,
      );
    };
    await mkdir(cwd, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeSkill(join(personal, "existing"), "existing", "Original procedure");
    await writeFile(join(cwd, "AGENTS.md"), "Original workspace rule");
    const quieted = new Set<string>();
    const settingsManager = SettingsManager.inMemory();
    const loader: CaptainResourceLoader = new CaptainResourceLoader({
      repoRoot,
      home,
      cwd,
      agentDir,
      settingsManager,
      quieted,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [skillSearchExtension(() => loader.getSkills().skills, quieted)],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({ role: "user", content: "Keep working on my task", timestamp: Date.now() });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
      modelRuntime,
    }));
    await session.bindExtensions({ mode: "print" });
    const history = structuredClone(session.messages);
    const tools = session.getActiveToolNames();
    const extensionRuntime = loader.getExtensions().runtime;
    const sessionId = session.sessionId;
    expect(session.systemPrompt).toContain("Original workspace rule");
    expect(tools).toContain("skill_search");

    await writeSkill(join(personal, "existing"), "existing", "Updated procedure");
    await writeSkill(recipe, "learned", "Learned by the neighboring agent");
    await symlink(recipe, join(personal, "learned"));
    await writeSkill(join(workspace, "workflow"), "workflow", "New workspace workflow");
    await writeSkill(join(personal, "manual"), "manual", "Explicit invocation only", true);
    await writeFile(join(home, "AGENTS.md"), "New owner rule");
    await writeFile(join(cwd, "AGENTS.md"), "Updated workspace rule");
    session.setActiveToolsByName(tools);
    expect(session.systemPrompt).toContain("Updated workspace rule");
    expect(session.systemPrompt).toContain("New owner rule");
    expect(session.systemPrompt).toContain("New workspace workflow");
    expect(session.systemPrompt).not.toContain("Original workspace rule");
    expect(session.systemPrompt).not.toContain("<name>learned</name>");
    const discovered = loader.getSkills().skills;
    expect(discovered.map((entry) => entry.name).sort()).toEqual([
      "existing",
      "learned",
      "manual",
      "workflow",
    ]);
    expect(discovered.find((entry) => entry.name === "existing")?.description).toBe("Updated procedure");
    expect([...quieted].sort()).toEqual(["existing", "learned"]);
    expect(
      invocableSkills(discovered, quieted).find((entry) => entry.name === "learned")?.disableModelInvocation,
    ).toBe(false);
    expect(
      invocableSkills(discovered, quieted).find((entry) => entry.name === "manual")?.disableModelInvocation,
    ).toBe(true);

    await writeSkill(replacement, "learned", "Corrected procedure");
    await unlink(join(personal, "learned"));
    await symlink(replacement, join(personal, "learned"));
    await rm(join(workspace, "workflow"), { recursive: true });
    await rm(join(home, "AGENTS.md"));
    session.setActiveToolsByName(tools);
    expect(loader.getSkills().skills.find((entry) => entry.name === "learned")?.description).toBe(
      "Corrected procedure",
    );
    expect(session.systemPrompt).not.toContain("New workspace workflow");
    expect(session.systemPrompt).not.toContain("New owner rule");
    expect(session.messages).toEqual(history);
    expect(session.sessionId).toBe(sessionId);
    expect(session.getActiveToolNames()).toEqual(tools);
    expect(loader.getExtensions().runtime).toBe(extensionRuntime);
  } finally {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
