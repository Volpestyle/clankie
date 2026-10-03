import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { inspectHarnessProfiles } from "../../../integrations/claude-plugin/worker/bin/harness-status.mjs";
import { installHarnessBridges } from "../src/harness-install.ts";

it("reports installed, enabled, version, bridge, hook and skill gaps independently for each Claude profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "clankie-harness-profiles-"));
  const active = join(home, "custom-profile");
  const named = join(home, ".claude-james");
  const root = join(home, "plugin");
  try {
    for (const path of [join(named, "plugins"), active, join(root, ".claude-plugin"), join(root, "hooks")])
      await mkdir(path, { recursive: true });
    await writeFile(
      join(named, "settings.json"),
      JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": true } }),
    );
    await writeFile(
      join(named, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "clankie-worker@clankie": [{ scope: "user", installPath: root }] } }),
    );
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.2.0" }));
    await writeFile(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { swarm: {} } }));
    await writeFile(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "node /bin/seat-hook.mjs" }] }],
          UserPromptSubmit: [{ hooks: [{ type: "command", command: "node /bin/seat-hook.mjs" }] }],
          Stop: [{ hooks: [{ type: "command", command: "node /bin/seat-hook.mjs" }] }],
        },
      }),
    );
    const report = await inspectHarnessProfiles({
      env: { HOME: home, CLAUDE_CONFIG_DIR: active },
      expectedVersion: "0.3.0",
      execute: async (_command, args) => (args[0] === "--version" ? "version" : "{}"),
    });
    expect(report.claude).toHaveLength(3);
    expect(report.claude.find((profile) => profile.profile === named)).toMatchObject({
      installed: true,
      enabled: true,
      versionMatches: false,
      bridge: false,
      legacyServerName: true,
      hooks: true,
      skill: false,
      liveReceiver: "not-observed",
    });
    expect(report.claude.find((profile) => profile.profile === active)).toMatchObject({
      installed: false,
      enabled: false,
    });
    const environments: string[] = [];
    await installHarnessBridges({
      repoRoot: "/fixture",
      env: { HOME: home, CLAUDE_CONFIG_DIR: active },
      consent: async () => true,
      execute: async (command, args, env) => {
        if (command === "claude" && args[1] === "enable") environments.push(env!.CLAUDE_CONFIG_DIR!);
      },
    });
    expect(environments.sort()).toEqual([join(home, ".claude"), named, active].sort());
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
