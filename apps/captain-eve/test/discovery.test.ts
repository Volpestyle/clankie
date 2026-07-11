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
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);

    const jsonStart = result.stdout.indexOf("{");
    expect(jsonStart, result.stdout).toBeGreaterThanOrEqual(0);
    const info = JSON.parse(result.stdout.slice(jsonStart)) as {
      diagnostics: { errors: number; warnings: number };
      skills: string[];
      status: string;
    };

    expect(info).toMatchObject({
      diagnostics: { errors: 0, warnings: 0 },
      status: "ready",
    });
    expect(info.skills).toEqual(["debug-mission", "evaluate-mission", "lead-mission"]);
  });

  it("validates canonical provider skill packages", () => {
    const skillsRoot = resolve(repoRoot, ".agents/skills");
    const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillNames).toHaveLength(9);
    for (const name of skillNames) {
      const skillRoot = resolve(skillsRoot, name);
      const skillFile = resolve(skillRoot, "SKILL.md");
      const markdown = readFileSync(skillFile, "utf8");
      const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
      expect(frontmatter, skillFile).toMatch(/^description:\s*\S+/mu);

      for (const match of markdown.matchAll(/(?:`|\()((?:references)\/[^`)\s]+\.md)(?:`|\))/gu)) {
        const reference = match[1];
        expect(lstatSync(resolve(skillRoot, reference)).isFile(), `${skillFile}: ${reference}`).toBe(true);
      }
    }
  });
});
