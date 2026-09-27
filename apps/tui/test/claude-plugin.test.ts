import { spawn } from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- the plugin's own generator is plain ESM without types.
import {
  OUTPUT_STYLE_PATH,
  renderOutputStyle,
} from "../../../integrations/claude-plugin/build.mjs";

const pluginRoot = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "integrations",
  "claude-plugin",
);

/** The plugin carries only what a plugin can uniquely declare, and nothing it carries drifts from the source. */
describe("clankie claude plugin", () => {
  it("keeps the output style generated from the captain's identity prompt", async () => {
    expect(await readFile(OUTPUT_STYLE_PATH as string, "utf8")).toBe(
      renderOutputStyle() as string,
    );
    const style = await readFile(
      join(pluginRoot, "output-styles", "clankie.md"),
      "utf8",
    );
    expect(style.startsWith("---\nname: Clankie\n")).toBe(true);
    expect(style).toContain("force-for-plugin: true");
    expect(style).not.toContain("keep-coding-instructions");
    expect(style).toContain("# Identity");
    expect(style).toContain("# This seat");
  });

  it("wires the hooks and the MCP server to the launcher, never to a config with a secret", async () => {
    const hooks = JSON.parse(
      await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    ) as {
      hooks: Record<
        string,
        { hooks: { type: string; command: string; args: string[] }[] }[]
      >;
    };
    expect(hooks.hooks.SessionStart?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "clankie",
      args: [
        "prompt",
        "--lane",
        "operator",
        "--sections",
        "persona,reach,fleet,address,model",
      ],
    });
    expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]).toMatchObject({
      type: "command",
      command: "clankie",
      args: ["memory-card", "--lane", "operator"],
    });
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "SessionEnd",
      "PreCompact",
    ]) {
      expect(hooks.hooks[event]?.[0]?.hooks).toContainEqual(
        expect.objectContaining({ command: "clankie", args: ["seat-sync"] }),
      );
    }
    const mcp = JSON.parse(
      await readFile(join(pluginRoot, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<
        string,
        { command: string; args: string[]; env?: unknown }
      >;
    };
    expect(mcp.mcpServers.clankie).toEqual({
      command: "clankie",
      args: ["mcp", "--lane", "operator"],
    });
  });

  it("links the product skills from the repo rather than copying them", async () => {
    for (const skill of ["this-machine", "trace-clankie", "work-items"]) {
      expect(await readlink(join(pluginRoot, "skills", skill))).toBe(
        `../../../.agents/skills/${skill}`,
      );
      expect(
        await readFile(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8"),
      ).toContain(`name: ${skill}`);
    }
  });

  it("is its own marketplace so `claude plugin install clankie@clankie` works from a checkout", async () => {
    const marketplace = JSON.parse(
      await readFile(
        join(pluginRoot, ".claude-plugin", "marketplace.json"),
        "utf8",
      ),
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
    new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve) => {
        const child = spawn(process.execPath, [shim], {
          env: { PATH: process.env.PATH, ...env },
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
        child.on("exit", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(input);
      },
    );

  it("declares one swarm server and no hooks, seat identity, or credential", async () => {
    const manifest = JSON.parse(
      await readFile(join(workerRoot, ".claude-plugin", "plugin.json"), "utf8"),
    ) as {
      name: string;
    };
    expect(manifest.name).toBe("clankie-worker");
    const mcp = JSON.parse(
      await readFile(join(workerRoot, ".mcp.json"), "utf8"),
    ) as unknown;
    expect(mcp).toEqual({
      mcpServers: {
        swarm: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/bin/swarm-mcp.mjs"],
        },
      },
    });
    expect(await readdir(workerRoot)).toEqual(
      expect.not.arrayContaining(["hooks", "output-styles", "skills"]),
    );
  });

  it("serves only inside a Swarm-dispatched interactive launch", async () => {
    const echo = join(
      await mkdtemp(join(tmpdir(), "clankie-worker-")),
      "echo.mjs",
    );
    await writeFile(
      echo,
      "process.stdin.on('data', (d) => process.stdout.write(`${process.env.SWARM_SESSION_CAPABILITY}:${d}`));",
    );
    const launch = {
      SWARM_MCP_CHANNEL: "1",
      SWARM_WORKER_LAUNCH: "/tmp/launch.json",
    };
    expect((await run({})).code).toBe(1);
    expect(
      (
        await run({
          ...launch,
          SWARM_WORKER_MCP: JSON.stringify(["node", echo]),
        })
      ).stderr,
    ).toContain("absolute");
    expect(
      await run(
        {
          ...launch,
          SWARM_SESSION_CAPABILITY: "worker-cap",
          SWARM_WORKER_MCP: JSON.stringify([process.execPath, echo]),
        },
        "ping",
      ),
    ).toEqual({ code: 0, stdout: "worker-cap:ping", stderr: "" });
  });
});
