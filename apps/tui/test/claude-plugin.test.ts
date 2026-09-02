import { readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- the plugin's own generator is plain ESM without types.
import { OUTPUT_STYLE_PATH, renderOutputStyle } from "../../../integrations/claude-plugin/build.mjs";

const pluginRoot = join(import.meta.dirname, "..", "..", "..", "integrations", "claude-plugin");

/** The plugin carries only what a plugin can uniquely declare, and nothing it carries drifts from the source. */
describe("clankie claude plugin", () => {
  it("keeps the output style generated from the captain's identity prompt", async () => {
    expect(await readFile(OUTPUT_STYLE_PATH as string, "utf8")).toBe(renderOutputStyle() as string);
    const style = await readFile(join(pluginRoot, "output-styles", "clankie.md"), "utf8");
    expect(style.startsWith("---\nname: Clankie\n")).toBe(true);
    expect(style).toContain("force-for-plugin: true");
    expect(style).not.toContain("keep-coding-instructions");
    expect(style).toContain("# Identity");
    expect(style).toContain("# This seat");
  });

  it("wires the hooks and the MCP server to the launcher, never to a config with a secret", async () => {
    const hooks = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, { hooks: { type: string; command: string; args: string[] }[] }[]>;
    };
    expect(hooks.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "clankie",
      args: ["prompt", "--lane", "operator", "--sections", "persona,reach,address,model"],
    });
    expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "clankie",
      args: ["memory-card", "--lane", "operator"],
    });
    const mcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: unknown }>;
    };
    expect(mcp.mcpServers.clankie).toEqual({ command: "clankie", args: ["mcp", "--lane", "operator"] });
  });

  it("links the product skills from the repo rather than copying them", async () => {
    for (const skill of ["this-machine", "trace-clankie"]) {
      expect(await readlink(join(pluginRoot, "skills", skill))).toBe(`../../../.agents/skills/${skill}`);
      expect(await readFile(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8")).toContain(
        `name: ${skill}`,
      );
    }
  });

  it("is its own marketplace so `claude plugin install clankie@clankie` works from a checkout", async () => {
    const marketplace = JSON.parse(
      await readFile(join(pluginRoot, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { name: string; plugins: { name: string; source: string }[] };
    expect(marketplace.name).toBe("clankie");
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "clankie", source: "./" })]);
  });
});
