import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { bundledSkills } from "@clankie/settings";
import { workerSkills } from "../src/captain/worker-skills.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hired worker skill discovery", () => {
  it("isolates Codex config and preserves tool skills while exposing the bundle", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "worker-skills-")));
    roots.push(root);
    const home = join(root, "owner");
    for (const path of [
      "owner/skills/tool",
      "owner/sessions",
      "owner/app-server-control",
      ".agents/skills/process",
    ])
      await mkdir(join(root, path), { recursive: true });
    await writeFile(
      join(root, ".agents/skills/process/SKILL.md"),
      "---\nname: process\ndescription: Test skill\n---\n",
    );
    const config = `model = "existing"\n[hooks.state."${join(home, "hooks.json")}:session_start:0:0"]\ntrusted_hash = "sha256:already-trusted"\n`;
    await writeFile(join(home, "config.toml"), config);
    await writeFile(join(home, "auth.json"), "test-only");
    const launch = await workerSkills("codex", root, root, home);
    const overlay = launch.env!.CODEX_HOME!;
    expect(await readdir(overlay)).not.toContain("app-server-control");
    expect(await realpath(join(overlay, "skills/process"))).toBe(join(root, ".agents/skills/process"));
    expect(await realpath(join(overlay, "skills/tool"))).toBe(join(home, "skills/tool"));
    expect(await realpath(join(overlay, "sessions"))).toBe(join(home, "sessions"));
    expect(await readFile(join(overlay, "auth.json"), "utf8")).toBe("test-only");
    expect(await readFile(join(overlay, "config.toml"), "utf8")).toContain(
      `[hooks.state."${join(overlay, "hooks.json")}:session_start:0:0"]\ntrusted_hash = "sha256:already-trusted"`,
    );
    await writeFile(join(overlay, "config.toml"), "worker changes\n");
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(config);
  });

  it("carries hook trust keyed by another account home that shares the same hooks file", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "worker-skills-")));
    roots.push(root);
    const shared = join(root, "dotfiles");
    const primary = join(root, "primary");
    const second = join(root, "second");
    for (const dir of [shared, primary, join(second, "sessions")]) await mkdir(dir, { recursive: true });
    await writeFile(join(shared, "hooks.json"), "{}\n");
    await symlink(join(shared, "hooks.json"), join(primary, "hooks.json"));
    await symlink(join(shared, "hooks.json"), join(second, "hooks.json"));
    const other = join(root, "elsewhere", "hooks.json");
    await writeFile(
      join(second, "config.toml"),
      `[hooks.state."${join(primary, "hooks.json")}:session_start:0:0"]\ntrusted_hash = "sha256:shared"\n` +
        `[hooks.state."${other}:session_start:0:0"]\ntrusted_hash = "sha256:other"\n`,
    );
    const overlay = (await workerSkills("codex", root, root, second)).env!.CODEX_HOME!;
    const config = await readFile(join(overlay, "config.toml"), "utf8");
    expect(config).toContain(
      `[hooks.state."${join(overlay, "hooks.json")}:session_start:0:0"]\ntrusted_hash = "sha256:shared"`,
    );
    // A hooks file that is not the copied one keeps its own key and stays unreviewed here.
    expect(config).toContain(`[hooks.state."${other}:session_start:0:0"]`);
  });

  it.each([
    { opinionated: true, exclude: [], lead: true, reflect: true },
    { opinionated: false, exclude: [], lead: false, reflect: false },
    { opinionated: true, exclude: ["lead"], lead: false, reflect: true },
  ])("filters every worker loader: %j", async (selection) => {
    const repo = join(import.meta.dirname, "../../..");
    const state = await realpath(await mkdtemp(join(tmpdir(), "worker-skills-")));
    roots.push(state);
    const home = join(state, "codex");
    for (const name of ["lead", "swarm-lead", "herdr-lead"])
      await mkdir(join(home, "skills", name), { recursive: true });
    for (const harness of ["claude", "pi", "codex"]) {
      const launch = await workerSkills(harness, repo, state, home, selection, repo);
      let names: string[];
      if (harness === "claude") {
        names = await readdir(join(launch.args[1]!, "skills"));
        expect(await readFile(join(launch.args[1]!, ".claude-plugin/plugin.json"), "utf8")).toContain(
          "clankie-work",
        );
      } else if (harness === "pi") {
        expect(launch.args[0]).toBe("--no-skills");
        const paths = launch.args.filter((_, index) => launch.args[index - 1] === "--skill");
        names = loadSkills({
          cwd: repo,
          agentDir: state,
          skillPaths: [...paths],
          includeDefaults: false,
        }).skills.map((skill) => skill.name);
      } else {
        names = await readdir(join(launch.env!.CODEX_HOME!, "skills"));
      }
      expect(names.includes("lead"), harness).toBe(selection.lead);
      expect(names.includes("reflect"), harness).toBe(selection.reflect);
      expect(names, harness).toContain("this-machine");
      expect(names, harness).not.toContain("swarm-lead");
      expect(names, harness).not.toContain("herdr-lead");
      for (const skill of bundledSkills(repo, selection)) {
        expect(names.includes(skill.name), `${harness}: ${skill.name}`).toBe(skill.included);
      }
    }
  });
});
