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

it("uses the linked service's live runtime identity to expose an older operator bridge without worker readiness", async () => {
  const home = await mkdtemp(join(tmpdir(), "clankie-older-seat-doctor-"));
  // A distinct secret avoids matching legitimate macOS /private/tmp paths.
  const secret = "harness-doctor-environment-secret";
  try {
    await mkdir(join(home, ".clankie/links"), { recursive: true });
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
            ? args.includes("pid=,lstart=")
              ? "30 Sat Oct  3 12:00:00 2026\n99 Sun Oct  4 12:00:00 2026"
              : args[0] === "eww"
                ? `30 node clankie mcp --lane operator HERDR_PANE_ID=w1:p1 HERDR_SOCKET_PATH=/test/default.sock SECRET=${secret}`
                : "20 10 /bin/claude\n30 20 node /home/.local/bin/clankie mcp --lane operator\n99 1 node /runtime/apps/clankie/src/index.ts"
            : "{}",
    });
    const seen: string[] = [];
    const probe: typeof fetch = async (url, options) => {
      seen.push(String(url));
      expect(new Headers(options?.headers).has("authorization")).toBe(false);
      return Response.json({ ok: true, service: "clankie", runtime: { pid: 99 } });
    };
    const report = await inspectHarnessBridges({ HOME: home }, execute, probe);
    if (process.platform === "darwin") {
      expect(seen).toEqual(["http://127.0.0.1:54321/health"]);
      expect(report.linkedSession.panes[0]).toMatchObject({
        status: "missing",
        operatorBridge: {
          status: "live-process",
          freshness: "older-than-runtime",
          remediation: expect.stringContaining("restart the seat"),
        },
      });
      for (const unproven of [
        { ok: true, service: "other", runtime: { pid: 99 } },
        { ok: true, service: "clankie", runtime: { pid: "99" } },
        { ok: false, service: "clankie", runtime: { pid: 99 } },
      ]) {
        const unknown = await inspectHarnessBridges({ HOME: home }, execute, async () =>
          Response.json(unproven),
        );
        expect(unknown.linkedSession.panes[0]?.operatorBridge?.freshness).toBe("unknown");
      }
    }
    expect(JSON.stringify(report)).not.toContain(secret);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.runIf(process.platform === "darwin").each([
  { name: "missing runtime identity", probe: async () => Response.json({ ok: true, service: "clankie" }) },
  { name: "offline runtime", probe: async () => new Response(null, { status: 503 }) },
  {
    name: "failed lookup",
    probe: async () => {
      throw new Error("service unavailable");
    },
  },
  { name: "malformed JSON", probe: async () => new Response("not json") },
  {
    name: "wrong service",
    probe: async () => Response.json({ ok: true, service: "other", runtime: { pid: 99 } }),
  },
  {
    name: "unhealthy runtime",
    probe: async () => Response.json({ ok: false, service: "clankie", runtime: { pid: 99 } }),
  },
  {
    name: "string PID",
    probe: async () => Response.json({ ok: true, service: "clankie", runtime: { pid: "99" } }),
  },
  {
    name: "fractional PID",
    probe: async () => Response.json({ ok: true, service: "clankie", runtime: { pid: 99.5 } }),
  },
  {
    name: "invalid PID",
    probe: async () => Response.json({ ok: true, service: "clankie", runtime: { pid: 1 } }),
  },
])("keeps both live bridge ages unknown for $name", async ({ probe }) => {
  const home = await mkdtemp(join(tmpdir(), "clankie-unknown-age-doctor-"));
  try {
    await mkdir(join(home, ".clankie/links"), { recursive: true });
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
            ? args.includes("pid=,lstart=")
              ? "30 Sat Oct  3 12:00:00 2026\n31 Sat Oct  3 12:00:00 2026\n99 Sun Oct  4 12:00:00 2026"
              : args[0] === "eww"
                ? [30, 31]
                    .map((pid) => `${pid} node HERDR_PANE_ID=w1:p1 HERDR_SOCKET_PATH=/test/default.sock`)
                    .join("\n")
                : "20 10 /bin/claude\n30 20 node /release/apps/tui/bin/clankie.js mcp --fleet\n31 20 node /release/apps/tui/bin/clankie.js mcp --lane operator\n99 1 node /runtime/apps/clankie/src/index.ts"
            : "{}",
    });
    const report = await inspectHarnessBridges({ HOME: home }, execute, probe);
    const worker = report.linkedSession.panes[0];
    expect(worker).toMatchObject({
      status: "live-process",
      freshness: "unknown",
      operatorBridge: { status: "live-process", freshness: "unknown" },
    });
    for (const observation of [worker, worker?.operatorBridge]) {
      expect(observation?.bridgeStartedAt).toBeUndefined();
      expect(observation?.runtimeStartedAt).toBeUndefined();
      expect(observation?.remediation).toBeUndefined();
    }
    expect(JSON.stringify(report.linkedSession)).not.toContain("older-than-runtime");
    expect(JSON.stringify(report.linkedSession)).not.toContain("restart the seat");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
