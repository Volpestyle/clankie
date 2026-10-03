import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    // The seat adds identity; it never strips Claude Code's own engineering instructions.
    expect(style).toContain("keep-coding-instructions: true");
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
      args: ["prompt", "--lane", "operator", "--sections", "persona,reach,fleet,address,model"],
    });
    // The card injects once per session and on change; SessionStart re-arms it.
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      expect(hooks.hooks[event]?.[0]?.hooks).toContainEqual(
        expect.objectContaining({
          command: "clankie",
          args: ["memory-card", "--lane", "operator", "--hook"],
          timeout: 60,
        }),
      );
    }
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "StopFailure",
      "SessionEnd",
      "PreCompact",
    ]) {
      expect(hooks.hooks[event]?.[0]?.hooks).toContainEqual(
        expect.objectContaining({ command: "clankie", args: ["seat-sync"], timeout: 60 }),
      );
    }
    // Projection injects nothing, so turn-end and pre-compact syncs never block the seat.
    for (const event of ["PostToolUse", "Stop", "StopFailure", "PreCompact"]) {
      expect(hooks.hooks[event]?.[0]?.hooks).toContainEqual(
        expect.objectContaining({ args: ["seat-sync"], async: true }),
      );
    }
    const mcp = JSON.parse(await readFile(join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env?: unknown }>;
    };
    expect(mcp.mcpServers.clankie).toEqual({
      command: "clankie",
      args: ["mcp", "--lane", "operator"],
    });
  });

  it("links the product skills from the repo rather than copying them", async () => {
    for (const skill of ["this-machine", "trace-clankie", "work-items", "research-team"]) {
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
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: "clankie", source: "./" }),
      expect.objectContaining({ name: "clankie-worker", source: "./worker" }),
    ]);
  });
});

/** ADR 0194: the worker channel plugin is its own identity, apart from the seat. */
describe("clankie-worker claude plugin", () => {
  const workerRoot = join(pluginRoot, "worker");
  const shim = join(workerRoot, "bin", "swarm-mcp.mjs");
  const run = (env: NodeJS.ProcessEnv, input = "") =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [shim], {
        env: { PATH: process.env.PATH, ...env },
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });

  it("declares one server, seat-lifecycle hooks, and no seat identity or credential", async () => {
    const manifest = JSON.parse(
      await readFile(join(workerRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as {
      name: string;
    };
    expect(manifest.name).toBe("clankie-worker");
    const mcp = JSON.parse(await readFile(join(workerRoot, ".mcp.json"), "utf8")) as unknown;
    expect(mcp).toEqual({
      mcpServers: {
        clankie: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/bin/swarm-mcp.mjs"],
        },
      },
    });
    expect(await readdir(workerRoot)).toEqual(expect.not.arrayContaining(["output-styles"]));
    // Its hooks report a Clankie hire's settled turns (VUH-1458), through one no-op-elsewhere script.
    const hooks = JSON.parse(await readFile(join(workerRoot, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      "SessionStart",
      "Stop",
      "StopFailure",
      "UserPromptSubmit",
    ]);
    for (const entries of Object.values(hooks.hooks))
      expect(entries[0]?.hooks[0]?.command).toBe('node "${CLAUDE_PLUGIN_ROOT}/bin/seat-hook.mjs"');
  });

  it("serves a Clankie hire's mailbox through clankie mcp --seat, with Claude's argv handed over", async () => {
    const bin = await mkdtemp(join(tmpdir(), "clankie-worker-bin-"));
    await writeFile(
      join(bin, "clankie"),
      `#!/bin/sh\nprintf '%s|%s|%s' "$*" "$CLANKIE_SEAT_PARENT_ARGV" "$HERDR_PANE_ID"\n`,
      { mode: 0o755 },
    );
    const served = await run({ HOME: bin, PATH: `${bin}:${process.env.PATH ?? ""}`, HERDR_PANE_ID: "w1:p1" });
    expect(served.code).toBe(0);
    const [args, parent, pane] = served.stdout.split("|");
    expect(args).toBe("mcp --seat");
    // The test runner is this wrapper's parent here, as Claude is in a real launch.
    expect(parent).toContain("node");
    expect(pane).toBe("w1:p1");
  });

  it("reports hooks only from a Clankie hire's pane", async () => {
    const hook = join(workerRoot, "bin", "seat-hook.mjs");
    const bin = await mkdtemp(join(tmpdir(), "clankie-worker-hook-"));
    await writeFile(join(bin, "clankie"), `#!/bin/sh\nprintf '%s:' "$*"; cat\n`, { mode: 0o755 });
    const call = (env: NodeJS.ProcessEnv) =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [hook], {
          env: { HOME: bin, PATH: `${bin}:${process.env.PATH ?? ""}`, ...env },
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
        child.on("exit", () => resolve(stdout));
        child.stdin.end('{"hook_event_name":"Stop"}');
      });
    expect(await call({ HERDR_PANE_ID: "w1:p1" })).toBe('seat-hook:{"hook_event_name":"Stop"}');
    expect(await call({})).toBe("");
  });
});
