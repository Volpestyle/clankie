import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    for (const path of ["owner/skills/tool", "owner/sessions", ".agents/skills/process"])
      await mkdir(join(root, path), { recursive: true });
    const config = `model = "existing"\n[hooks.state."${join(home, "hooks.json")}:session_start:0:0"]\ntrusted_hash = "sha256:already-trusted"\n`;
    await writeFile(join(home, "config.toml"), config);
    await writeFile(join(home, "auth.json"), "test-only");
    const launch = await workerSkills("codex", root, root, home);
    const overlay = launch.env!.CODEX_HOME!;
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

  it("uses native discovery for Claude and pi without changing their homes", async () => {
    expect(await workerSkills("claude", "/body", "/state")).toEqual({
      args: ["--plugin-dir", "/body/integrations/worker-skills"],
    });
    expect(await workerSkills("pi", "/body", "/state")).toEqual({
      args: ["--skill", "/body/.agents/skills"],
    });
  });
});
