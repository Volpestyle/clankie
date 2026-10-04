// Read-only host facts. Process presence is not MCP catalog or delivery acceptance.
const MAX_PANES = 48;
const MAX_BRIDGES = 96;
const daemonFix =
  "After saving affected sessions, stop the shared daemon with codex app-server daemon stop. Resume each session in its own pane with codex --no-daemon resume <SESSION>; keep daemon_auto_start=false in the source-owned config.";
const fix = (harness) =>
  harness === "claude"
    ? "In this pane's Claude profile, install/enable clankie-worker@clankie: claude plugin install clankie-worker@clankie --scope user; claude plugin enable clankie-worker@clankie --scope user. Restart/resume Claude, then verify its native tool catalog."
    : "Check this pane's source-owned Codex bridge registration/plugin. Resume in this pane with codex --no-daemon resume <SESSION>, then verify its native tool catalog.";

function table(stdout) {
  return new Map(
    stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match ? [[Number(match[1]), { parent: Number(match[2]), command: match[3] }]] : [];
    }),
  );
}
function descends(rows, pid, ancestor) {
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    if (pid === ancestor) return true;
    const row = rows.get(pid);
    if (!row) break;
    pid = row.parent;
  }
  return false;
}
function environment(text, key) {
  return new RegExp(`(?:^| )${key}=([^]*?)(?= [A-Za-z_][A-Za-z0-9_]*=|$)`, "u").exec(text)?.[1];
}
function bridgeKind(command) {
  // Match argv at the start, not a shell's embedded command or unrelated swarm-mcp.
  const launcher =
    /^(?:\S*\/)?(?:node|bun|clankie)(?:\s+\S*\/clankie(?:\.(?:ts|js))?)?\s+mcp(?:\s|$)(.*)$/u.exec(command);
  if (launcher) {
    if (/(?:^|\s)--fleet(?:\s|$)/u.test(launcher[1])) return "worker";
    if (/(?:^|\s)--(?:seat|grant)(?:\s|$)/u.test(launcher[1])) return undefined;
    if (
      !/(?:^|\s)--lane(?:\s|=)/u.test(launcher[1]) ||
      /(?:^|\s)--lane(?:\s+|=)operator(?:\s|$)/u.test(launcher[1])
    )
      return "operator";
  }
  if (
    /^(?:\S*\/)?node\s+\S*\/(?:clankie-worker|worker)\/[^ ]*bin\/swarm-mcp\.mjs(?:\s|$)/u.test(command) ||
    /^(?:\S*\/)?node\s+\S*\/clankie-worker\/[^ ]*\/swarm-mcp\.mjs(?:\s|$)/u.test(command)
  )
    return "worker";
  return undefined;
}

function processStarts(stdout) {
  return new Map(
    stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/u.exec(
        line,
      );
      const time = match && Date.parse(match[2]);
      return Number.isFinite(time) ? [[Number(match[1]), time]] : [];
    }),
  );
}

/** One process snapshot and one targeted env read, plus bounded Herdr pane facts. */
export async function inspectLiveHarnessBridges({
  socket,
  panes,
  run,
  platform = process.platform,
  runtimePid,
}) {
  const targets = panes.filter((pane) => ["claude", "codex"].includes(pane.harness)).slice(0, MAX_PANES);
  const unknown = (pane, detail) => ({ ...pane, status: "unobserved", detail });
  if (platform !== "darwin")
    return {
      state: "unsupported",
      panes: targets.map((pane) =>
        unknown(pane, "Host process/env bridge observation currently supports macOS."),
      ),
      unownedBridges: [],
    };
  try {
    const rows = table(await run("/bin/ps", ["-axo", "pid=,ppid=,comm="]));
    for (const row of rows.values()) row.executable = row.command;
    // Avoid reading huge shell argv or all process environments. Only native
    // Codex servers and potential bridge interpreters need command lines.
    const argvPids = [...rows]
      .filter(([, row]) => /(?:^|\/)(?:node|bun|clankie|codex)(?:\s|$)/u.test(row.command))
      .map(([pid]) => pid);
    if (argvPids.length > 256) throw new Error("Process command observation limit exceeded");
    if (argvPids.length) {
      const commands = table(await run("/bin/ps", ["-p", argvPids.join(","), "-o", "pid=,ppid=,command="]));
      for (const [pid, row] of commands) if (rows.has(pid)) rows.get(pid).command = row.command;
    }
    const candidates = [...rows].filter(([, row]) => bridgeKind(row.command));
    if (candidates.length > MAX_BRIDGES) throw new Error("Bridge observation limit exceeded");
    const envText = candidates.length
      ? await run("/bin/ps", ["eww", "-p", candidates.map(([pid]) => pid).join(","), "-o", "pid=,command="])
      : "";
    let starts = new Map();
    if (Number.isSafeInteger(runtimePid) && runtimePid > 1 && rows.has(runtimePid)) {
      try {
        starts = processStarts(
          await run("/bin/ps", [
            "-p",
            [...new Set([runtimePid, ...candidates.map(([pid]) => pid)])].join(","),
            "-o",
            "pid=,lstart=",
          ]),
        );
      } catch {
        // Missing process clocks say nothing about an otherwise healthy bridge.
      }
    }
    const runtimeStart = starts.get(runtimePid);
    const age = (bridge) => {
      if (runtimePid === undefined) return { freshness: "unknown" };
      const bridgeStart = starts.get(bridge.pid);
      const older =
        Number.isFinite(bridgeStart) && Number.isFinite(runtimeStart) && bridgeStart < runtimeStart;
      return {
        freshness:
          Number.isFinite(bridgeStart) && Number.isFinite(runtimeStart)
            ? older
              ? "older-than-runtime"
              : "current"
            : "unknown",
        ...(Number.isFinite(bridgeStart) ? { bridgeStartedAt: new Date(bridgeStart).toISOString() } : {}),
        ...(Number.isFinite(runtimeStart) ? { runtimeStartedAt: new Date(runtimeStart).toISOString() } : {}),
        ...(older
          ? {
              remediation:
                "Seat bridge older than runtime; restart the seat to reload its bridge. Process age alone does not prove an obsolete build. Preserve the native session and reconcile uncertain deliveries before resuming.",
            }
          : {}),
      };
    };
    const envRows = new Map(
      envText.split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
        return match ? [[Number(match[1]), match[2]]] : [];
      }),
    );
    const bridges = candidates.map(([pid, row]) => {
      const text = envRows.get(pid);
      const ancestors = [...rows].filter(
        ([ancestor, row]) =>
          row.executable.split(/\s/u)[0]?.includes("/app-server-daemon/") && descends(rows, pid, ancestor),
      );
      return {
        pid,
        kind: bridgeKind(row.command),
        claimedPane:
          text && /^w[\w]+:p[\w]+$/u.test(environment(text, "HERDR_PANE_ID") ?? "")
            ? environment(text, "HERDR_PANE_ID")
            : undefined,
        socket: text && environment(text, "HERDR_SOCKET_PATH"),
        sharedDaemon: ancestors.length > 0,
      };
    });
    const owned = new Set();
    const results = [];
    // At most four pane probes at once; unavailable facts do not become missing bridges.
    for (let start = 0; start < targets.length; start += 4) {
      results.push(
        ...(await Promise.all(
          targets.slice(start, start + 4).map(async (pane) => {
            try {
              const info = JSON.parse(await run("herdr", ["pane", "process-info", "--pane", pane.paneId]))
                .result?.process_info;
              const pid = info?.foreground_process_group_id;
              if (
                info?.pane_id !== pane.paneId ||
                !Number.isSafeInteger(pid) ||
                pid <= 1 ||
                pid === info.shell_pid ||
                !rows.has(pid)
              )
                return unknown(pane, "No live foreground harness process was observed.");
              // A profile wrapper can lead the foreground process group. Herdr
              // supplies the actual argv and PID of native members of that group.
              const nativeMember = info.foreground_processes?.find(
                (member) =>
                  Number.isSafeInteger(member.pid) &&
                  rows.has(member.pid) &&
                  descends(rows, member.pid, pid) &&
                  Array.isArray(member.argv) &&
                  new RegExp(`(?:^|/)${pane.harness}$`, "u").test(member.argv[0] ?? ""),
              );
              const nativePid = nativeMember?.pid ?? pid;
              const nativeArgv = nativeMember?.argv ?? rows.get(pid).command.split(/\s+/u);
              if (!new RegExp(`(?:^|/)${pane.harness}$`, "u").test(nativeArgv[0] ?? ""))
                return unknown(pane, "Foreground process does not identify the reported native harness.");
              const descendants = bridges.filter((bridge) => descends(rows, bridge.pid, nativePid));
              // A hired Codex TUI connects to a dedicated server launched by the service,
              // not necessarily a descendant of its shell. Join exact native socket argv.
              const remote = nativeArgv;
              const endpoint = remote[remote.indexOf("--remote") + 1];
              const dedicated =
                pane.harness === "codex" && remote.includes("--remote")
                  ? bridges.filter(
                      (bridge) =>
                        !bridge.sharedDaemon &&
                        [...rows].some(([ancestor, row]) => {
                          const argv = row.command.split(/\s+/u);
                          return (
                            argv.includes("app-server") &&
                            argv.includes("--listen") &&
                            argv[argv.indexOf("--listen") + 1] === endpoint &&
                            descends(rows, bridge.pid, ancestor)
                          );
                        }),
                    )
                  : [];
              const matches = [...new Set([...descendants, ...dedicated])];
              matches.forEach((bridge) => owned.add(bridge.pid));
              const operatorMatches = matches.filter((bridge) => bridge.kind === "operator");
              const operator = operatorMatches.find(
                (bridge) =>
                  bridge.claimedPane === pane.paneId && bridge.socket === socket && !bridge.sharedDaemon,
              );
              const operatorBridge = operator
                ? {
                    status: "live-process",
                    bridgePid: operator.pid,
                    claimedPane: operator.claimedPane,
                    detail:
                      "Operator bridge process belongs to this native pane and claims its pane/socket. Channel polling and reply delivery remain unverified.",
                    ...age(operator),
                  }
                : operatorMatches.length
                  ? {
                      status: operatorMatches.some(
                        (bridge) => bridge.claimedPane === undefined || bridge.socket === undefined,
                      )
                        ? "unobserved"
                        : "pane-mismatch",
                      bridgePid: operatorMatches[0].pid,
                      claimedPane: operatorMatches[0].claimedPane,
                      detail: "Operator bridge process has no proven matching pane/socket.",
                    }
                  : undefined;
              const withOperator = (observation) => ({
                ...observation,
                ...(operatorBridge ? { operatorBridge } : {}),
              });
              const workerMatches = matches.filter((bridge) => bridge.kind === "worker");
              const good = workerMatches.find(
                (bridge) =>
                  bridge.claimedPane === pane.paneId && bridge.socket === socket && !bridge.sharedDaemon,
              );
              if (good)
                return withOperator({
                  ...pane,
                  status: "live-process",
                  bridgePid: good.pid,
                  claimedPane: good.claimedPane,
                  detail:
                    "Bridge process belongs to this native pane and claims its pane/socket. Native tools and reply delivery still need verification.",
                  ...age(good),
                });
              if (
                workerMatches.some(
                  (bridge) => bridge.claimedPane === undefined || bridge.socket === undefined,
                )
              )
                return withOperator(
                  unknown(pane, "Bridge environment could not be observed; pane ownership is unproven."),
                );
              const mismatch = workerMatches[0];
              if (mismatch)
                return withOperator({
                  ...pane,
                  status: "pane-mismatch",
                  bridgePid: mismatch.pid,
                  claimedPane: mismatch.claimedPane,
                  sharedDaemon: mismatch.sharedDaemon,
                  detail:
                    "The native pane's bridge claims another pane/socket or descends from a shared daemon.",
                  remediation: mismatch.sharedDaemon ? daemonFix : fix(pane.harness),
                });
              return withOperator({
                ...pane,
                status: "missing",
                detail:
                  "No descendant or socket-matched dedicated fleet bridge was observed for the live native harness." +
                  (pane.harness === "codex" &&
                  bridges.some((bridge) => bridge.sharedDaemon && bridge.socket === socket)
                    ? ` Shared daemon bridges on this linked socket claim ${[...new Set(bridges.filter((bridge) => bridge.sharedDaemon && bridge.socket === socket).map((bridge) => bridge.claimedPane ?? "unknown"))].join(", ")}; this pane's ownership remains unproven.`
                    : ""),
                remediation:
                  pane.harness === "codex" &&
                  bridges.some((bridge) => bridge.sharedDaemon && bridge.socket === socket)
                    ? daemonFix
                    : fix(pane.harness),
              });
            } catch {
              return unknown(pane, "Herdr process facts unavailable.");
            }
          }),
        )),
      );
    }
    return {
      state: "observed",
      panes: results,
      unownedBridges: bridges
        .filter((bridge) => !owned.has(bridge.pid) && bridge.socket === socket)
        .map(({ socket: _socket, ...bridge }) => ({
          ...bridge,
          detail: bridge.sharedDaemon
            ? "Shared daemon bridge: its claimed pane is inherited; no native pane ownership was proven."
            : "No observed native pane owns this bridge.",
          ...(bridge.sharedDaemon ? { remediation: daemonFix } : {}),
        })),
    };
  } catch {
    return {
      state: "unavailable",
      panes: targets.map((pane) => unknown(pane, "Host process/env snapshot unavailable.")),
      unownedBridges: [],
    };
  }
}
