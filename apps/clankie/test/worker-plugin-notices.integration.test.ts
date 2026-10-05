import { spawn, execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerPluginNotices } from "../src/worker-plugin-notices.ts";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";

const exec = promisify(execFile);
it.skipIf(process.env.NATIVE_HARNESS_FIXTURES !== "1")(
  "flags an admitted old native plugin once through MCP and real Herdr metadata, preserving its pane process",
  async () => {
    const root = await mkdtemp("/tmp/cl1652-");
    const home = join(root, "home"),
      config = join(root, "config.toml"),
      session = `plugin-${root.split("-").at(-1)}`;
    await mkdir(home);
    await writeFile(
      config,
      'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
    );
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_STATE_HOME: join(home, "state"),
      XDG_RUNTIME_DIR: root,
      HERDR_CONFIG_PATH: config,
      HERDR_SOCKET_PATH: join(root, "api.sock"),
      TERM: "xterm-256color",
      SHELL: "/bin/sh",
    };
    const run = async (args: readonly string[]) =>
      (await exec("herdr", ["--session", session, ...args], { env, cwd: root, timeout: 10_000 })).stdout;
    const server = spawn("herdr", ["--session", session, "server"], { env, cwd: root, stdio: "ignore" });
    const credentials = new FileCredentialStore(join(root, "credentials.json"));
    const host = createMcpHost({
      credentials,
      settings: new SettingsStore(join(root, "settings.json")),
      curated: [],
      logger: { info: () => {}, warn: () => {} },
    });
    let worker: WorkerMcp | undefined;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await run(["api", "snapshot"]);
          ready = true;
          break;
        } catch {
          if (server.exitCode !== null) throw Error("Fixture Herdr exited");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      expect(ready).toBe(true);
      const created = JSON.parse(
        await run(["workspace", "create", "--cwd", root, "--label", "Fixture", "--no-focus"]),
      ).result;
      const pane = created.root_pane.pane_id;
      const processInfo = async () =>
        JSON.parse(await run(["pane", "process-info", "--pane", pane])).result.process_info;
      const before = await processInfo();
      const pid = before.shell_pid;
      const startTime = (await exec("/bin/ps", ["-p", String(pid), "-o", "lstart="])).stdout.trim();
      // Admission proof fixture is grounded in this real pane/process; this does not test agent admission.
      const proof: ProjectProcessProof = {
        fleet: "default",
        pane,
        nativeOccupantId: `fixture-${pid}`,
        binding: { socketPath: env.HERDR_SOCKET_PATH, session },
        shell: { pid, startTime },
        processes: [{ pid, startTime }],
      };
      const identity = {
        fleet: "default",
        pane,
        validate: async () => (await processInfo()).shell_pid === pid,
        projectProof: async () => proof,
      };
      const directory = join(root, "notices");
      const reports: readonly string[][] = [];
      let reporter = new WorkerPluginNotices({
        directory,
        expectedVersion: "0.6.2",
        report: async (_fleet, target, args) => {
          (reports as string[][]).push([...args]);
          return run(["pane", "report-metadata", target, "--source", "clankie-plugin-update", ...args]);
        },
      });
      worker = new WorkerMcp({
        directory: join(root, "grants"),
        credentials,
        host,
        pluginExpectedVersion: () => reporter.expected(),
        pluginVersionObserved: (current, version) => reporter.observe(current, version),
      });
      const initialize = async (version: string) => {
        const response = await worker!.handleLocalFleet(
          new Request("http://fixture/v1/fleet/mcp", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "clankie-worker", version },
              },
            }),
          }),
          identity,
        );
        expect(response.status).toBe(200);
      };
      await initialize("0.6.1");
      expect(reports).toHaveLength(1);
      expect(reports[0]?.join(" ")).toContain("Save this session, then restart/resume this harness");
      const snapshot = JSON.parse(await run(["api", "snapshot"])).result.snapshot;
      expect(
        JSON.stringify(snapshot.panes.find((entry: { pane_id: string }) => entry.pane_id === pane)),
      ).toContain("clankie-plugin");
      expect(await processInfo()).toMatchObject({ shell_pid: pid });
      const files = await readdir(directory),
        stored = await readFile(join(directory, files[0]!), "utf8");
      await initialize("0.6.1");
      // Simulated service recreation, same durable journal and actual metadata projection.
      reporter = new WorkerPluginNotices({
        directory,
        expectedVersion: "0.6.2",
        report: async (_fleet, target, args) => {
          (reports as string[][]).push([...args]);
          return run(["pane", "report-metadata", target, "--source", "clankie-plugin-update", ...args]);
        },
      });
      await initialize("0.6.1");
      expect(reports).toHaveLength(1);
      expect(await readFile(join(directory, files[0]!), "utf8")).toBe(stored);
      await initialize("0.6.2");
      expect(reports[1]).toEqual(["--clear-token", "clankie-plugin"]);
      const api = createRuntimeUpdateRoutes({
        authorize: async (request) =>
          request.headers.get("authorization") === "Bearer owner"
            ? { current: () => true, guard: async () => {} }
            : undefined,
        pluginVersionInstalled: (version) => reporter.expect(version),
      });
      expect(
        (await api.request("/v1/harness-plugin-version", { method: "POST", body: '{"version":"0.6.3"}' }))
          .status,
      ).toBe(403);
      expect(
        (
          await api.request("/v1/harness-plugin-version", {
            method: "POST",
            headers: { authorization: "Bearer owner", "content-type": "application/json" },
            body: '{"version":"0.6.3"}',
          })
        ).status,
      ).toBe(200);
      await initialize("0.6.2");
      expect(reports[2]?.join(" ")).toContain("is older than 0.6.3");
      expect(await processInfo()).toMatchObject({ shell_pid: pid });
      expect(reports.every((args) => !args.includes("restart") && !args.includes("send-keys"))).toBe(true);
    } finally {
      await worker?.close();
      await host.close();
      const exited = new Promise<void>((resolve) =>
        server.exitCode !== null || server.signalCode !== null
          ? resolve()
          : server.once("exit", () => resolve()),
      );
      server.kill("SIGTERM");
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
