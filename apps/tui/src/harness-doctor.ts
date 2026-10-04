import { inspectLiveHarnessBridges } from "../../../integrations/claude-plugin/worker/bin/harness-live.mjs";
import { inspectHarnessProfiles } from "../../../integrations/claude-plugin/worker/bin/harness-status.mjs";
import { readFile, realpath, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecFileImpl } from "./install-doctor.ts";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

/** Registration is separate from live membership: neither a config entry nor a pane ID grants tools. */
export async function inspectHarnessBridges(
  env: NodeJS.ProcessEnv,
  execute: ExecFileImpl,
  fetchImpl: typeof fetch,
  repoRoot?: string,
) {
  const home = env.HOME?.trim() || homedir();
  const codexRoot = env.CODEX_HOME?.trim() || join(home, ".codex");
  const claudeRoot = env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const configPath = join(codexRoot, "config.toml");
  let codexRegistered = false;
  try {
    const spec = JSON.parse((await execute("codex", ["mcp", "get", "clankie", "--json"])).stdout);
    const transport = spec.transport ?? spec;
    codexRegistered =
      spec.enabled !== false &&
      transport.command === "clankie" &&
      JSON.stringify(transport.args) === JSON.stringify(["mcp", "--fleet"]);
  } catch {
    /* Missing CLI or registration is a visible gap. */
  }
  const settings = await json(join(claudeRoot, "settings.json")).catch(() => ({}));
  const installs = await json(join(claudeRoot, "plugins", "installed_plugins.json")).catch(() => ({}));
  const entries = installs.plugins?.["clankie-worker@clankie"];
  let claudeInstalled = false;
  if (Array.isArray(entries))
    for (const entry of entries) {
      if (typeof entry.installPath !== "string" || entry.scope !== "user") continue;
      try {
        await access(join(entry.installPath, ".mcp.json"));
        claudeInstalled = true;
      } catch {
        /* stale install */
      }
    }
  let linkedSession: Awaited<ReturnType<typeof inspectLiveHarnessBridges>> = {
    state: "no-link",
    panes: [],
    unownedBridges: [],
  };
  const local = {
    platform: process.platform,
    membership: "no-link",
    sharedDaemon: false,
    detail: "No local fleet discovery file; start a service with a connected local Herdr session.",
  };
  try {
    const rows = (await execute("ps", ["-axo", "pid=,ppid=,comm="])).stdout.split("\n");
    const table = new Map(
      rows.flatMap((row) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(row);
        return match ? [[Number(match[1]), { parent: Number(match[2]), command: match[3]! }] as const] : [];
      }),
    );
    let pid = process.pid;
    for (let i = 0; i < 64 && pid > 1; i++) {
      const row = table.get(pid);
      if (!row) break;
      if (row.command.includes("/app-server-daemon/")) local.sharedDaemon = true;
      pid = row.parent;
    }
  } catch {
    /* Live membership probe remains authoritative. */
  }
  if (process.platform !== "darwin") {
    local.membership = "unsupported";
    local.detail =
      "Local process membership currently supports macOS; SSH fleet links use their existing authentication.";
  } else
    try {
      const link = await json(join(home, ".clankie", "links", "default-local.json"));
      if (
        typeof link.socket !== "string" ||
        !link.socket.startsWith("/") ||
        link.schemaVersion !== 2 ||
        link.authentication !== "local-process" ||
        !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(link.url)
      )
        throw new Error("Invalid local discovery");
      try {
        const run = async (command: string, args: string[]) =>
          (
            await execute(
              command === "herdr" ? "/usr/bin/env" : command,
              command === "herdr" ? [`HERDR_SOCKET_PATH=${link.socket}`, "herdr", ...args] : args,
            )
          ).stdout;
        const list = JSON.parse(await run("herdr", ["agent", "list"]));
        const panes = (list.result?.agents ?? []).flatMap((agent: { pane_id?: string; agent?: string }) =>
          typeof agent.pane_id === "string" && typeof agent.agent === "string"
            ? [{ paneId: agent.pane_id, harness: agent.agent }]
            : [],
        );
        linkedSession = await inspectLiveHarnessBridges({ socket: link.socket, panes, run });
      } catch {
        linkedSession = { state: "unavailable", panes: [], unownedBridges: [] };
      }
      if (!env.HERDR_PANE_ID || env.HERDR_SOCKET_PATH !== link.socket) {
        local.membership = "not-in-session";
        local.detail = "This process is outside the service's connected local Herdr session.";
      } else {
        const response = await fetchImpl(`${link.url}/v1/fleet/mcp`, {
          headers: { "x-clankie-pane": env.HERDR_PANE_ID },
          signal: AbortSignal.timeout(10_000),
        });
        local.membership = response.status === 400 ? "verified" : "unavailable";
        local.detail =
          response.status === 400
            ? "Local process membership verified. Tools depend on the connected fleet and fleet.tools; native catalog and reply delivery remain unverified."
            : local.sharedDaemon
              ? "Local process membership unavailable. Save sessions, stop the shared daemon with codex app-server daemon stop, and resume with codex --no-daemon resume <SESSION> in this Herdr pane; keep daemon_auto_start=false in the source-owned configuration; shared daemon MCP processes cannot prove pane ownership."
              : "Local process membership unavailable. Check clankie herdr status and the current pane. Private hires require a process registration owned by the running service; a pane ID alone grants nothing.";
      }
    } catch {
      /* Stale discovery or offline service confers no membership. */
    }
  const expectedVersion = repoRoot
    ? (
        await json(
          join(repoRoot, "integrations", "claude-plugin", "worker", ".claude-plugin", "plugin.json"),
        ).catch(() => ({}))
      ).version
    : undefined;
  const profiles = await inspectHarnessProfiles({
    env,
    expectedVersion,
    execute: async (command, args) => (await execute(command, args)).stdout,
  });
  codexRegistered =
    profiles.codex.registered ||
    (profiles.codex.pluginInstalled &&
      profiles.codex.enabled &&
      profiles.codex.bridge &&
      profiles.codex.identityForwarding &&
      profiles.codex.versionMatches !== false);
  return {
    profiles,
    codex: {
      registered: codexRegistered,
      configPath,
      configSource: await realpath(configPath).catch(() => configPath),
    },
    claude: {
      installed: claudeInstalled,
      enabled: settings.enabledPlugins?.["clankie-worker@clankie"] === true,
    },
    localFleet: local,
    linkedSession,
    remediation: [
      ...(!codexRegistered
        ? [
            "Register clankie mcp --fleet through the source that owns Codex configSource; preserve generated configuration symlinks.",
          ]
        : []),
      ...(!claudeInstalled
        ? [
            "claude plugin marketplace add <Clankie repoRoot>/integrations/claude-plugin",
            "claude plugin install clankie-worker@clankie --scope user",
          ]
        : []),
      ...(claudeInstalled && settings.enabledPlugins?.["clankie-worker@clankie"] !== true
        ? ["claude plugin enable clankie-worker@clankie --scope user"]
        : []),
    ] as readonly string[],
  };
}
