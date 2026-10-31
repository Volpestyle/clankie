/**
 * A plugin-free Claude seat: the worker's own hooks and MCP server, run from
 * the shipped worker directory the way Claude runs launch-time settings hooks
 * and `--mcp-config` servers (a shell command, no plugin environment).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { claudeWorkerInlineHooks, claudeWorkerInlineMcpConfig } from "../src/captain/claude-worker-inline.ts";
import { shippedWorkerFile } from "../src/worker-plugin-path.ts";

const run = promisify(execFile);
const root = shippedWorkerFile();
const bare = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" };

describe.skipIf(process.platform === "win32")("plugin-free worker launch", () => {
  const hooks = claudeWorkerInlineHooks(root);
  const commands = Object.values(hooks).flatMap((matchers) =>
    matchers.flatMap((matcher) => (matcher.hooks ?? []).map((hook) => String(hook.command))),
  );

  it("names every hook the plugin declares by real files, with no plugin variable left", () => {
    expect(Object.keys(hooks)).toEqual(expect.arrayContaining(["SessionStart", "UserPromptSubmit", "Stop"]));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toContain("${CLAUDE_PLUGIN_ROOT}");
      for (const path of command.match(/"([^"]+\.(?:mjs|sh))"/gu) ?? [])
        expect(existsSync(path.slice(1, -1)), path).toBe(true);
    }
  });

  it("runs each hook under a plain shell outside a fleet pane as a no-op", async () => {
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "x", cwd: root });
    for (const command of new Set(commands)) {
      const child = run("sh", ["-c", command], { env: bare, timeout: 20_000 });
      child.child.stdin?.end(input);
      await expect(child).resolves.toBeDefined();
    }
  });

  it("starts the worker's own server from the launch config", async () => {
    const server = (
      JSON.parse(claudeWorkerInlineMcpConfig(root)) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
      }
    ).mcpServers.worker!;
    const result = await run(server.command, server.args, {
      env: { ...bare, ...server.env },
      timeout: 20_000,
    }).catch((error: { stderr?: string }) => error);
    // Outside a Herdr pane the server answers with its own refusal, so it was found and ran.
    expect(String(result.stderr)).toContain("only a Clankie hire in a herdr pane");
  });
});
