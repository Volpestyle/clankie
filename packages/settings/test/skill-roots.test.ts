import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clankieSkillRoots } from "../src/skill-roots.ts";

const base = { repoRoot: "/body", agentDir: "/home/.pi/agent", home: "/home" };

describe("clankie skill roots", () => {
  it("reaches the roots every other agent on this machine shares", () => {
    expect(clankieSkillRoots(base)).toContain(join("/home", ".agents", "skills"));
    expect(clankieSkillRoots(base)).toContain(join("/home/.pi/agent", "skills"));
  });

  it("ranks the skills shipped with this body above a personal skill of the same name", () => {
    const roots = clankieSkillRoots({ ...base, cwd: "/work" });
    expect(roots.indexOf(join("/body", ".agents", "skills"))).toBeLessThan(
      roots.indexOf(join("/home", ".agents", "skills")),
    );
  });

  it("adds the workspace's own skills only for a session that has one", () => {
    expect(clankieSkillRoots({ ...base, cwd: "/work" })).toContain(join("/work", ".agents", "skills"));
    expect(clankieSkillRoots(base)).not.toContain(join("/work", ".agents", "skills"));
  });
});
