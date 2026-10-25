import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../integrations/claude-plugin/", import.meta.url));
async function hook(input: Record<string, unknown>, ...args: string[]) {
  const child = spawn(process.execPath, [root + "worker/bin/tracker-hook.mjs", ...args], {
    env: { PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  for await (const chunk of (child.stdin.end(JSON.stringify(input)), child.stdout)) output += chunk;
  return output ? JSON.parse(output) : undefined;
}

const denied = [
  "mcp__linear-server__create_comment",
  "mcp__linear-server___create_comment",
  "mcp__linear-server__get_issue",
  "mcp__claude_ai_Linear__create_issue",
  "mcp__plugin_external_Linear__save_comment",
];
const retained = [
  "mcp__plugin_clankie-worker_worker__clankie_call",
  "mcp__plugin_clankie_lead__linear_create_comment",
  "mcp__clankie__linear_create_comment",
  "mcp__github__create_issue",
  "Bash",
];

it("plugin-local guard denies inherited Linear tools without a pane or live bridge, retaining Clankie and other tools", async () => {
  for (const name of denied) {
    expect(
      await hook({ hook_event_name: "PreToolUse", tool_name: name, permission_mode: "bypassPermissions" }),
    ).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
  }
  for (const name of retained) {
    expect(await hook({ hook_event_name: "PreToolUse", tool_name: name })).toBeUndefined();
  }
  expect(await hook({ hook_event_name: "SessionStart" })).toMatchObject({
    systemMessage: expect.stringContaining("clankie_tools / clankie_call"),
  });
  // The operator seat is the lead: it is never told to ask a lead or use the worker bridge.
  const lead = await hook({ hook_event_name: "SessionStart" }, "lead");
  expect(lead.systemMessage).toContain("linear_* tools");
  expect(lead.systemMessage).not.toContain("message_clankie");
  expect(await hook({ hook_event_name: "PreToolUse", tool_name: denied[0] }, "lead")).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
  // Hooks reside only in these plugins. Loading neither plugin adds no deny to
  // a plain session, and no hook writes owner profile configuration. Claude
  // tests a hook matcher as an unanchored RegExp; the guard starts for every
  // Linear-named server and for no other Clankie or plain tool (VUH-2390).
  for (const path of ["hooks/hooks.json", "worker/hooks/hooks.json"]) {
    const config = JSON.parse(await readFile(root + path, "utf8"));
    const guards = config.hooks.PreToolUse.filter((entry: { hooks: { command: string }[] }) =>
      entry.hooks.some((handler) => handler.command.includes("tracker-hook.mjs")),
    );
    expect(guards).toHaveLength(1);
    const matcher = new RegExp(guards[0].matcher);
    for (const name of denied) expect(matcher.test(name)).toBe(true);
    for (const name of retained) expect(matcher.test(name)).toBe(false);
  }
});

it.skipIf(process.env.NATIVE_CLAUDE_CACHE_FIXTURES !== "1")(
  "native Claude installs the plugin guard into a private profile, without changing the personal profile",
  async () => {
    const exec = promisify(execFile);
    const directory = await mkdtemp(join(tmpdir(), "clankie-tracker-native-"));
    const profile = join(directory, "profile"),
      marketplace = join(directory, "marketplace");
    const pluginId = "clankie-worker@clankie-tracker-proof";
    const env = {
      PATH: process.env.PATH,
      HOME: directory,
      CLAUDE_CONFIG_DIR: profile,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      NO_COLOR: "1",
    };
    try {
      await mkdir(profile);
      await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
      await cp(root + "worker", join(marketplace, "worker"), { recursive: true });
      await writeFile(
        join(marketplace, ".claude-plugin/marketplace.json"),
        JSON.stringify({
          name: "clankie-tracker-proof",
          owner: { name: "Fixture" },
          plugins: [{ name: "clankie-worker", source: "./worker" }],
        }),
      );
      await exec("claude", ["plugin", "marketplace", "add", marketplace], { env, timeout: 30_000 });
      await exec("claude", ["plugin", "install", pluginId, "--scope", "user"], { env, timeout: 30_000 });
      const state = JSON.parse(await readFile(join(profile, "plugins/installed_plugins.json"), "utf8"));
      const installed = state.plugins[pluginId].find((entry: { scope: string }) => entry.scope === "user");
      expect(installed.version).toBe("0.6.19");
      const config = JSON.parse(await readFile(join(installed.installPath, "hooks/hooks.json"), "utf8"));
      const guard = config.hooks.PreToolUse.find((entry: { hooks: { command: string }[] }) =>
        entry.hooks.some((handler) => handler.command.includes("tracker-hook.mjs")),
      );
      expect(guard.hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/bin/tracker-hook.mjs"');
      const child = spawn(process.execPath, [join(installed.installPath, "bin/tracker-hook.mjs")], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end(
        JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__linear-server__create_comment",
          permission_mode: "bypassPermissions",
        }),
      );
      let output = "";
      for await (const chunk of child.stdout) output += chunk;
      expect(JSON.parse(output)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      console.log(
        JSON.stringify({
          proof: "native-Claude-plugin-install-and-installed-hook",
          version: installed.version,
          inheritedLinearDecision: JSON.parse(output).hookSpecificOutput.permissionDecision,
          personalProfile: "untouched",
          modelTurn: false,
          providerWrite: false,
        }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);
