import { inspectHarnessBridges } from "../src/harness-doctor.ts";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
      expectedVersion: "0.6.2",
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
      prepareSkills: async () => {},
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

it.each(["current", "stale", "disabled", "missing-bridge", "missing-forwarding"])(
  "checks Codex plugin activation, bridge and forwarding separately: %s",
  async (kind) => {
    const expectedVersion = JSON.parse(
      await readFile(
        join(import.meta.dirname, "../../../integrations/claude-plugin/worker/.codex-plugin/plugin.json"),
        "utf8",
      ),
    ).version as string;
    const home = await mkdtemp(join(tmpdir(), "clankie-codex-profile-"));
    const root = join(
      home,
      ".codex/plugins/cache/clankie-fleet/clankie-worker",
      kind === "stale" ? "0.3.0" : expectedVersion,
    );
    try {
      await mkdir(join(root, ".codex-plugin"), { recursive: true });
      await mkdir(join(root, "bin"));
      await writeFile(
        join(root, ".codex-plugin/plugin.json"),
        JSON.stringify({
          version: kind === "stale" ? "0.3.0" : expectedVersion,
          mcpServers: "./codex-mcp.json",
        }),
      );
      await writeFile(join(root, "bin/fleet-mcp.mjs"), "// fixture\n");
      if (kind !== "missing-bridge")
        await writeFile(
          join(root, "codex-mcp.json"),
          JSON.stringify({
            mcpServers: {
              clankie: {
                command: "node",
                args: ["bin/fleet-mcp.mjs"],
                cwd: ".",
                env_vars: kind === "missing-forwarding" ? [] : ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"],
              },
            },
          }),
        );
      const execute = async (command: string, args: readonly string[]) => {
        if (command === "codex" && args[0] === "plugin")
          return JSON.stringify({
            installed: [
              {
                pluginId: "clankie-worker@clankie-fleet",
                version: kind === "stale" ? "0.3.0" : expectedVersion,
                enabled: kind !== "disabled",
              },
            ],
          });
        if (args[0] === "mcp")
          return JSON.stringify({
            enabled: kind !== "disabled",
            transport: {
              command: "node",
              args: ["bin/fleet-mcp.mjs"],
              cwd: join(root, "."),
              env_vars: kind === "missing-forwarding" ? [] : ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"],
            },
          });
        return "version";
      };
      const report = await inspectHarnessProfiles({ env: { HOME: home }, expectedVersion, execute });
      const summary = await inspectHarnessBridges(
        { HOME: home },
        async (command, args) => ({ stdout: await execute(command, args), stderr: "" }),
        async () => new Response(null, { status: 403 }),
        join(import.meta.dirname, "../../.."),
      );
      expect(summary.codex.registered).toBe(kind === "current");
      expect(report.codex.registration).toBe(kind === "missing-bridge" ? "unrecognized" : "plugin");
      expect(report.codex).toMatchObject({
        pluginInstalled: true,
        versionMatches: kind !== "stale",
        enabled: kind !== "disabled",
        bridge: kind !== "missing-bridge",
        identityForwarding: !["missing-bridge", "missing-forwarding"].includes(kind),
        registered: false,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each([true, false])(
  "identifies the legacy shipped Node registration and checks identity forwarding (%s)",
  async (forwarding) => {
    const home = await mkdtemp(join(tmpdir(), "clankie-codex-legacy-"));
    const bridge = join(home, ".clankie/claude-plugin/worker/bin/swarm-mcp.mjs");
    try {
      await mkdir(join(home, ".clankie/claude-plugin/worker/bin"), { recursive: true });
      await writeFile(bridge, "// fixture\n");
      const report = await inspectHarnessProfiles({
        env: { HOME: home },
        execute: async (_command, args) =>
          args[0] === "mcp"
            ? JSON.stringify({
                enabled: true,
                transport: {
                  command: "node",
                  args: [bridge],
                  env_vars: forwarding ? ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"] : [],
                },
              })
            : "{}",
      });
      expect(report.codex).toMatchObject({
        registration: "legacy-node",
        registrationIdentityForwarding: forwarding,
        registered: forwarding,
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it("ships matching Claude and Codex worker versions for doctor comparisons", async () => {
  const root = join(import.meta.dirname, "../../../integrations/claude-plugin/worker");
  for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
    expect(JSON.parse(await readFile(join(root, manifest), "utf8")).version).toBe("0.6.8");
  }
});
