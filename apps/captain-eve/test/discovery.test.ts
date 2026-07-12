import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("captain Eve authored surface", () => {
  it("compiles and discovers the mission skills", () => {
    const result = spawnSync("pnpm", ["exec", "eve", "info", "--json"], {
      cwd: appRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        CAPTAIN_TEST_MODEL: "openai/gpt-5.6-luna",
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const jsonStart = result.stdout.indexOf("{");
    expect(jsonStart, result.stdout).toBeGreaterThanOrEqual(0);
    const info = JSON.parse(result.stdout.slice(jsonStart)) as {
      diagnostics: { errors: number; warnings: number };
      tools: string[];
      skills: string[];
      status: string;
    };

    expect(info).toMatchObject({
      diagnostics: { errors: 0, warnings: 0 },
      status: "ready",
    });
    expect(info.skills).toEqual(["debug-mission", "delegate-workers", "evaluate-mission", "lead-mission"]);
    expect(info.tools).toEqual([
      "add_recovery",
      "create_mission",
      "decide_action",
      "get_mission",
      "start_mission",
      "steer_worker",
      "submit_plan",
    ]);

    const manifest = JSON.parse(
      readFileSync(resolve(appRoot, ".eve/compile/compiled-agent-manifest.json"), "utf8"),
    ) as {
      config: { compaction?: { thresholdPercent?: number } };
      hooks: { slug: string }[];
    };
    expect(manifest.config.compaction).toEqual({ thresholdPercent: 1 });
    expect(manifest.hooks.map((hook) => hook.slug)).toContain("captain-lanes");
    expect(manifest.hooks.map((hook) => hook.slug)).toContain("captain-presence");
    expect(manifest.hooks.map((hook) => hook.slug)).toContain("session-accounting");
  });

  it("validates canonical provider skill packages", () => {
    const skillsRoot = resolve(repoRoot, ".agents/skills");
    const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillNames).toHaveLength(10);
    for (const name of skillNames) {
      const skillRoot = resolve(skillsRoot, name);
      const skillFile = resolve(skillRoot, "SKILL.md");
      const markdown = readFileSync(skillFile, "utf8");
      const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
      expect(frontmatter, skillFile).toMatch(/^description:\s*\S+/mu);

      for (const match of markdown.matchAll(/(?:`|\()((?:references)\/[^`)\s]+\.md)(?:`|\))/gu)) {
        const reference = match[1];
        if (reference === undefined) continue;
        expect(lstatSync(resolve(skillRoot, reference)).isFile(), `${skillFile}: ${reference}`).toBe(true);
      }
    }

    const delegationSkill = readFileSync(resolve(skillsRoot, "clankie-lead", "SKILL.md"), "utf8");
    expect(delegationSkill).toContain("/goal <task and definition of done>");
    expect(delegationSkill).toContain("Never send approval answers");
    expect(delegationSkill).toContain("Tier-0 protocol facts");
    expect(delegationSkill).toContain("worker.turn.settled");
    expect(delegationSkill).not.toContain("~/dev/clankie/");

    const captainDelegationSkill = readFileSync(
      resolve(appRoot, "agent", "skills", "delegate-workers", "SKILL.md"),
      "utf8",
    );
    expect(captainDelegationSkill).toContain("/model");
    expect(captainDelegationSkill).toContain("/effort");
    expect(captainDelegationSkill).toContain("/goal <task and definition of done>");
    expect(captainDelegationSkill).toContain("Never send approval answers");
    expect(captainDelegationSkill).toContain("worker.turn.settled");
  });
});
