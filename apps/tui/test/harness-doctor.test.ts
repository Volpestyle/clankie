import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { inspectHarnessBridges } from "../src/harness-doctor.ts";

it("reports harness registration, generated config source, and live membership separately without secrets", async () => {
  const home = await mkdtemp(join(tmpdir(), "clankie-harness-doctor-"));
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".claude/plugins"), { recursive: true });
    await mkdir(join(home, "bundle"));
    await mkdir(join(home, ".clankie/links"), { recursive: true });
    const source = join(home, "generated.toml");
    await writeFile(source, "# generated config\n");
    await symlink(source, join(home, ".codex/config.toml"));
    await writeFile(join(home, "bundle/.mcp.json"), "{}");
    await writeFile(
      join(home, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": true } }),
    );
    await writeFile(
      join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({
        plugins: { "clankie-worker@clankie": [{ scope: "user", installPath: join(home, "bundle") }] },
      }),
    );
    await writeFile(
      join(home, ".clankie/links/default-local.json"),
      JSON.stringify({
        schemaVersion: 2,
        authentication: "local-process",
        socket: "/test/default.sock",
        url: "http://127.0.0.1:54321",
      }),
    );
    const execute = async (command: string, args: readonly string[]) => ({
      stderr: "",
      stdout:
        command === "/usr/bin/env"
          ? JSON.stringify({
              result: args.includes("list")
                ? { agents: [{ pane_id: "w1:p1", agent: "claude" }] }
                : { process_info: { pane_id: "w1:p1", shell_pid: 10, foreground_process_group_id: 20 } },
            })
          : command === "/bin/ps"
            ? "20 10 /bin/claude"
            : command === "codex"
              ? JSON.stringify({
                  enabled: true,
                  transport: {
                    command: "clankie",
                    args: ["mcp", "--fleet"],
                    env_vars: ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"],
                    env: { SECRET: "never-report-me" },
                  },
                })
              : `${process.pid} 1 /app-server-daemon/bin/codex`,
    });
    const env = { HOME: home, HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/test/default.sock" };
    const probe: typeof fetch = async (_url, options) => {
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      return Response.json({ error: "session_required" }, { status: 400 });
    };
    const report = await inspectHarnessBridges(env, execute, probe);
    expect(report.codex).toMatchObject({ registered: true, configSource: await realpath(source) });
    expect(report.claude).toEqual({ installed: true, enabled: true });
    if (process.platform === "darwin")
      expect(report.linkedSession.panes[0]).toMatchObject({
        paneId: "w1:p1",
        status: "missing",
        remediation: expect.stringContaining("clankie-worker@clankie"),
      });
    const outside = await inspectHarnessBridges({ HOME: home }, execute, probe);
    expect(outside.localFleet.membership).toBe(
      process.platform === "darwin" ? "not-in-session" : "unsupported",
    );
    expect(outside.linkedSession.panes).toEqual(report.linkedSession.panes);
    expect(report.localFleet.sharedDaemon).toBe(true);
    expect(report.localFleet.membership).toBe(process.platform === "darwin" ? "verified" : "unsupported");
    expect(JSON.stringify(report)).not.toContain("never-report-me");
    const denied = await inspectHarnessBridges(env, execute, async () => new Response(null, { status: 403 }));
    expect(denied.localFleet.membership).toBe(process.platform === "darwin" ? "unavailable" : "unsupported");
    expect(await import("node:fs/promises").then((fs) => fs.readlink(join(home, ".codex/config.toml")))).toBe(
      source,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("names an installed but outdated Claude worker plugin as remediation", async () => {
  const home = await mkdtemp(join(tmpdir(), "clankie-harness-doctor-stale-"));
  try {
    const bundle = join(home, "bundle");
    await mkdir(join(bundle, ".claude-plugin"), { recursive: true });
    await mkdir(join(home, ".claude/plugins"), { recursive: true });
    await writeFile(join(bundle, ".claude-plugin/plugin.json"), JSON.stringify({ version: "0.2.0" }));
    await writeFile(join(bundle, ".mcp.json"), JSON.stringify({ mcpServers: { swarm: {} } }));
    await writeFile(
      join(home, ".claude/settings.json"),
      JSON.stringify({ enabledPlugins: { "clankie-worker@clankie": true } }),
    );
    await writeFile(
      join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ plugins: { "clankie-worker@clankie": [{ scope: "user", installPath: bundle }] } }),
    );
    const execute = async () => ({ stdout: "", stderr: "" });
    const repoRoot = join(import.meta.dirname, "../../..");
    const report = await inspectHarnessBridges({ HOME: home }, execute, fetch, repoRoot);
    const stale = report.remediation.filter((line) => line.includes(join(home, ".claude")));
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatch(
      /^Update clankie-worker 0\.2\.0 in .+ to \d+\.\d+\.\d+: clankie harness install$/u,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.each([true, false])(
  "uses only the private state discovery root (descriptor present=%s)",
  async (present) => {
    const home = await mkdtemp(join(tmpdir(), "clankie-doctor-state-"));
    const privateRoot = join(home, "private-state");
    const descriptor = (url: string) =>
      JSON.stringify({
        schemaVersion: 2,
        authentication: "local-process",
        socket: "/test/default.sock",
        url,
      });
    try {
      await mkdir(join(home, ".clankie", "links"), { recursive: true });
      await writeFile(
        join(home, ".clankie", "links", "default-local.json"),
        descriptor("http://127.0.0.1:54321"),
      );
      if (present) {
        await mkdir(join(privateRoot, "links"), { recursive: true });
        await writeFile(
          join(privateRoot, "links", "default-local.json"),
          descriptor("http://127.0.0.1:54322"),
        );
      }
      const execute = async () => ({ stderr: "", stdout: "{}" });
      const probe = vi.fn<typeof fetch>(async () => new Response(null, { status: 400 }));
      const report = await inspectHarnessBridges(
        {
          HOME: home,
          CLANKIE_STATE: ` ${privateRoot} `,
          HERDR_PANE_ID: "w1:p1",
          HERDR_SOCKET_PATH: "/test/default.sock",
        },
        execute,
        probe,
      );
      if (process.platform === "darwin" && present) {
        expect(report.localFleet.membership).toBe("verified");
        expect(probe).toHaveBeenCalledWith("http://127.0.0.1:54322/v1/fleet/mcp", expect.any(Object));
      } else {
        expect(report.localFleet.membership).toBe(process.platform === "darwin" ? "no-link" : "unsupported");
        expect(probe).not.toHaveBeenCalled();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
