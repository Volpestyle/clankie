import { parseHerdrAgentList, recoverLocalCodexSession } from "../../clankie/src/captain/herdr-census.ts";
import { inspectLiveHarnessBridges } from "../../../integrations/claude-plugin/worker/bin/harness-live.mjs";
import { inspectHarnessProfiles } from "../../../integrations/claude-plugin/worker/bin/harness-status.mjs";
import { readFile, realpath, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecFileImpl } from "./install-doctor.ts";

const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

interface CensusPane {
  paneId: string;
  terminalId?: string;
  parentPaneId?: string;
  harness?: string;
}

interface ParentLeadObservation {
  paneId: string;
  terminalId?: string;
  harness?: string;
  children: readonly { paneId: string; terminalId?: string }[];
  bridgeStatus: "live-process" | "missing" | "pane-mismatch" | "unobserved";
  detail: string;
  remediation?: string;
}

function parentLeadObservations(
  census: readonly CensusPane[],
  live: Awaited<ReturnType<typeof inspectLiveHarnessBridges>>,
): ParentLeadObservation[] {
  const parents = new Map<string, { paneId: string; terminalId?: string }[]>();
  for (const child of census) {
    if (!child.parentPaneId || !["claude", "codex"].includes(child.harness ?? "")) continue;
    const children = parents.get(child.parentPaneId) ?? [];
    children.push({
      paneId: child.paneId,
      ...(child.terminalId === undefined ? {} : { terminalId: child.terminalId }),
    });
    parents.set(child.parentPaneId, children);
  }
  return [...parents].map(([paneId, children]) => {
    const parent = census.find((pane) => pane.paneId === paneId);
    const observation = live.panes.find((pane) => pane.paneId === paneId);
    const operator = observation?.operatorBridge;
    const bridgeStatus =
      observation?.status === "live-process" || operator?.status === "live-process"
        ? ("live-process" as const)
        : observation?.status === "pane-mismatch" || operator?.status === "pane-mismatch"
          ? ("pane-mismatch" as const)
          : observation?.status === "missing" && operator === undefined
            ? ("missing" as const)
            : ("unobserved" as const);
    const label = `Lead pane ${paneId} parenting ${children.map((child) => child.paneId).join(", ")}`;
    const detail =
      bridgeStatus === "live-process"
        ? `${label} has an observed matching Clankie bridge process. Native catalog, delivery and parent report routing remain unverified.`
        : parent === undefined
          ? `${label} is absent from the current agent census; its bridge remains unobserved.`
          : bridgeStatus === "missing"
            ? `${label} has no observed Clankie bridge for its live native harness. This does not prove that its profile lacks an installation.`
            : bridgeStatus === "pane-mismatch"
              ? `${label}'s observed bridge has no matching pane/socket ownership.`
              : `${label}'s native bridge could not be observed${parent.harness ? ` (census harness: ${parent.harness})` : " (census harness unknown)"}.`;
    return {
      paneId,
      ...(parent?.terminalId === undefined ? {} : { terminalId: parent.terminalId }),
      ...(parent?.harness === undefined ? {} : { harness: parent.harness }),
      children,
      bridgeStatus,
      detail,
      ...(bridgeStatus === "live-process"
        ? {}
        : {
            remediation:
              `${label} has ${bridgeStatus === "missing" ? "no observed Clankie bridge" : "no verified matching Clankie bridge process"}. ` +
              "Inspect that parent's foreground native harness and source-owned bridge profile; install/enable or resume its bridge as needed, then verify its native tool catalog and parent report routing. Preserve the native session and reconcile uncertain reports before retrying.",
          }),
    };
  });
}

/** Registration is separate from live membership: neither a config entry nor a pane ID grants tools. */
export async function inspectHarnessBridges(
  env: NodeJS.ProcessEnv,
  execute: ExecFileImpl,
  fetchImpl: typeof fetch,
  repoRoot?: string,
) {
  const home = env.HOME?.trim() || homedir();
  const stateRoot = env.CLANKIE_STATE?.trim() || join(home, ".clankie");
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
  let linkedSession: Awaited<ReturnType<typeof inspectLiveHarnessBridges>> & {
    parentLeads?: readonly ParentLeadObservation[];
    nativeBindings?: readonly {
      paneId: string;
      status: "observed" | "recovered" | "missing";
      detail: string;
    }[];
  } = {
    state: "no-link",
    panes: [],
    unownedBridges: [],
    parentLeads: [],
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
      const link = await json(join(stateRoot, "links", "default-local.json"));
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
        const census: CensusPane[] = (list.result?.agents ?? []).flatMap(
          (agent: { pane_id?: string; terminal_id?: string; parent_pane_id?: string; agent?: string }) =>
            typeof agent.pane_id === "string"
              ? [
                  {
                    paneId: agent.pane_id,
                    ...(typeof agent.terminal_id === "string" ? { terminalId: agent.terminal_id } : {}),
                    ...(typeof agent.parent_pane_id === "string"
                      ? { parentPaneId: agent.parent_pane_id }
                      : {}),
                    ...(typeof agent.agent === "string" ? { harness: agent.agent } : {}),
                  },
                ]
              : [],
        );
        let runtimePid: number | undefined;
        try {
          const response = await fetchImpl(`${link.url}/health`, { signal: AbortSignal.timeout(5_000) });
          const health = response.ok ? await response.json() : undefined;
          if (
            health?.ok === true &&
            health.service === "clankie" &&
            Number.isSafeInteger(health.runtime?.pid) &&
            health.runtime.pid > 1
          )
            runtimePid = health.runtime.pid;
        } catch {
          // No running runtime identity: bridge presence remains observable, age remains unknown.
        }
        const live = await inspectLiveHarnessBridges({
          socket: link.socket,
          panes: census.flatMap((pane) =>
            pane.harness === undefined ? [] : [{ paneId: pane.paneId, harness: pane.harness }],
          ),
          run,
          ...(runtimePid === undefined ? {} : { runtimePid }),
        });
        const nativeBindings = await Promise.all(
          parseHerdrAgentList(JSON.stringify(list))
            .filter((agent) => ["claude", "codex"].includes(agent.agent))
            .map(async (agent) => {
              const recovered =
                agent.session ??
                (agent.agent === "codex"
                  ? await recoverLocalCodexSession(agent, {
                      bridgeSocket: link.socket,
                      herdrSession: link.session ?? "default",
                      localCodexRecordsPath: join(stateRoot, "local-codex-seats.json"),
                      runCommand: async (command, args) => ({
                        stdout: await run(command, [...args]),
                        stderr: "",
                      }),
                    })
                  : undefined);
              return {
                paneId: agent.paneId,
                status: agent.session
                  ? ("observed" as const)
                  : recovered
                    ? ("recovered" as const)
                    : ("missing" as const),
                detail: recovered
                  ? "Exact native session binding observed; delivery remains unverified."
                  : "Native session binding missing; reports and steering require exact native proof. Inspect the seat socket/thread and use owner-authorized re-adoption for the same thread.",
              };
            }),
        );
        linkedSession = { ...live, parentLeads: parentLeadObservations(census, live), nativeBindings };
      } catch {
        linkedSession = { state: "unavailable", panes: [], unownedBridges: [], parentLeads: [] };
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
      ...(linkedSession.nativeBindings ?? [])
        .filter((binding) => binding.status === "missing")
        .map((binding) => `${binding.paneId}: ${binding.detail}`),
      ...(linkedSession.parentLeads ?? []).flatMap((lead) =>
        lead.remediation === undefined ? [] : [lead.remediation],
      ),
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
      // An installed but outdated plugin still loads, so it is drift doctor must name.
      ...profiles.claude
        .filter((profile) => profile.installed && (profile.versionMatches === false || !profile.bridge))
        .map(
          (profile) =>
            `Update clankie-worker ${profile.version ?? "unknown"} in ${profile.profile} to ${profile.expectedVersion ?? "the bundled version"}: clankie harness install`,
        ),
      ...(profiles.codex.pluginInstalled && profiles.codex.versionMatches === false
        ? [
            `Update the Codex clankie-worker plugin ${profiles.codex.version ?? "unknown"} to ${profiles.codex.expectedVersion}: clankie harness install`,
          ]
        : []),
    ] as readonly string[],
  };
}
