import { fleetQualified, splitFleetQualified, type HerdrFleet, type HerdrFleetRun } from "../herdr-fleet.ts";
import { createSshAgentHost } from "@clankie/agent-hosts";
import type { AgentTranscriptHost } from "@clankie/agent-transcript";
import { remoteHerdrTranscriptReader } from "./remote-herdr-transcript.ts";
import { createHerdrWatchRunner, type HerdrAgentSnapshot, type HerdrWatchRunner } from "./herdr-watch.ts";

const SETTLED = new Set(["idle", "done", "blocked"]);
const CHANNEL_DIALOG_SETTLED = new Set(["idle", "working", "done"]);
const REMOTE_POLL_MS = 3_000;
const CHANNEL_DIALOG_WAIT_MS = 30_000;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * A fleet on another machine, observed by polling one shared `pane list`
 * rather than holding an `agent wait` open per seat. A long wait would pin an
 * ssh channel per watched pane (sshd allows ten per connection by default) and
 * leave a remote process behind whenever the link drops; a poll holds nothing
 * open, so a lost link is only a missed poll.
 *
 * Machine-local powers (lsof, codex queue, the seat MCP
 * registration, pi's integration and provider files) are absent: they read or
 * write this machine, not that one. Native history reads on demand through
 * the SSH host's confined transcript reader. Other replies use `herdr agent read`
 * and delivery to the pty lane, as ADR 0184 allows until the reverse-forward
 * mailbox lands.
 */
export function createRemoteHerdrRunner(
  fleet: HerdrFleet,
  run: HerdrFleetRun,
  options: { readonly pollMs?: number; readonly transcriptHost?: AgentTranscriptHost } = {},
): HerdrWatchRunner {
  const base = createHerdrWatchRunner(undefined, run);
  const pollMs = options.pollMs ?? REMOTE_POLL_MS;
  let cached: { readonly at: number; readonly panes: Promise<readonly HerdrAgentSnapshot[]> } | undefined;

  const panes = (): Promise<readonly HerdrAgentSnapshot[]> => {
    const now = Date.now();
    if (cached === undefined || now - cached.at >= pollMs / 2) {
      const pending = run(["pane", "list"]).then(parsePaneList);
      cached = { at: now, panes: pending };
      pending.catch(() => {
        if (cached?.panes === pending) cached = undefined;
      });
    }
    return cached.panes;
  };

  const current = async (target: string): Promise<HerdrAgentSnapshot> =>
    (await panes()).find((pane) => pane.paneId === target || pane.terminalId === target) ??
    (await base.get(target));

  const until = async (
    target: string,
    signal: AbortSignal | undefined,
    done: (snapshot: HerdrAgentSnapshot) => boolean,
    deadline?: number,
  ): Promise<HerdrAgentSnapshot> => {
    for (;;) {
      const snapshot = await current(target);
      if (done(snapshot)) return snapshot;
      if (deadline !== undefined && Date.now() >= deadline)
        throw new Error(`fleet ${fleet.id}: timed out waiting for ${target}`);
      await delay(pollMs, signal);
    }
  };

  const { addClaudeMcp: _localOnly, ...remote } = base;
  return {
    ...remote,
    get: current,
    resolveTerminal: async (terminalId) => (await panes()).find((pane) => pane.terminalId === terminalId),
    wait: (target, signal) => until(target, signal, (snapshot) => SETTLED.has(snapshot.status)),
    waitForChange: (target, status, signal) =>
      until(target, signal, (snapshot) => snapshot.status !== status),
    waitUntilIdle: (target, signal) =>
      until(
        target,
        signal,
        (snapshot) => CHANNEL_DIALOG_SETTLED.has(snapshot.status),
        Date.now() + CHANNEL_DIALOG_WAIT_MS,
      ),
    transcript: remoteHerdrTranscriptReader(
      options.transcriptHost ??
        createSshAgentHost({ id: fleet.id, ssh: fleet.ssh.host, shell: fleet.ssh.shell }),
    ),
    openFiles: () => Promise.reject(new Error(`fleet ${fleet.id}: open files are read on this machine only`)),
    codexQueue: async () => false,
    installPiIntegration: () =>
      Promise.reject(
        new Error(`unsupported: pi's integration is installed on the fleet's machine by its owner`),
      ),
    configurePiProvider: () =>
      Promise.reject(
        new Error(`unsupported: pi providers are configured on the fleet's machine by its owner`),
      ),
  };
}

function parsePaneList(stdout: string): readonly HerdrAgentSnapshot[] {
  const parsed = JSON.parse(stdout) as { result?: { panes?: unknown } };
  const panes = Array.isArray(parsed.result?.panes) ? parsed.result.panes : [];
  return panes.flatMap((pane) => {
    if (typeof pane !== "object" || pane === null) return [];
    const entry = pane as Record<string, unknown>;
    if (typeof entry.pane_id !== "string" || typeof entry.terminal_id !== "string") return [];
    const session =
      typeof entry.agent_session === "object" && entry.agent_session !== null
        ? (entry.agent_session as Record<string, unknown>)
        : undefined;
    const title = [entry.title, entry.terminal_title_stripped, entry.terminal_title].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    return [
      {
        paneId: entry.pane_id,
        terminalId: entry.terminal_id,
        ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
        agent: typeof entry.agent === "string" ? entry.agent : "unknown",
        status: typeof entry.agent_status === "string" ? entry.agent_status : "unknown",
        title: title?.trim() ?? "",
        ...(typeof session?.source === "string" &&
        (session.kind === "id" || session.kind === "path") &&
        typeof session.value === "string"
          ? { session: { source: session.source, kind: session.kind, value: session.value } }
          : {}),
        ...(typeof entry.cwd === "string" ? { workingDirectory: entry.cwd } : {}),
      } satisfies HerdrAgentSnapshot,
    ];
  });
}

/**
 * One runner over every fleet (ADR 0184). A `<fleet>/` prefix routes a pane or
 * terminal id to that fleet's runner, and everything it answers comes back
 * qualified the same way, so a watch, a seat or a hire records an id that still
 * names its machine after a restart. Bare ids stay on the local default fleet.
 */
export function routeHerdrFleets(
  local: HerdrWatchRunner,
  fleets: ReadonlyMap<string, HerdrWatchRunner>,
): HerdrWatchRunner {
  if (fleets.size === 0) return local;
  const route = (target: string): { runner: HerdrWatchRunner; id: string; fleet?: string } => {
    const qualified = splitFleetQualified(target);
    if (qualified === undefined) return { runner: local, id: target };
    const runner = fleets.get(qualified.fleet);
    if (runner === undefined) throw new Error(`Unknown Herdr fleet ${qualified.fleet}`);
    return { runner, id: qualified.id, fleet: qualified.fleet };
  };
  const qualify = (fleet: string | undefined, snapshot: HerdrAgentSnapshot): HerdrAgentSnapshot =>
    fleet === undefined
      ? snapshot
      : {
          ...snapshot,
          paneId: fleetQualified(fleet, snapshot.paneId),
          terminalId: fleetQualified(fleet, snapshot.terminalId),
        };
  const unqualify = (snapshot: HerdrAgentSnapshot): HerdrAgentSnapshot => {
    const pane = splitFleetQualified(snapshot.paneId);
    const terminal = splitFleetQualified(snapshot.terminalId);
    return {
      ...snapshot,
      paneId: pane?.id ?? snapshot.paneId,
      terminalId: terminal?.id ?? snapshot.terminalId,
    };
  };
  const onTarget = async (
    target: string,
    call: (runner: HerdrWatchRunner, id: string) => Promise<HerdrAgentSnapshot>,
  ): Promise<HerdrAgentSnapshot> => {
    const { runner, id, fleet } = route(target);
    return qualify(fleet, await call(runner, id));
  };
  return {
    get: (target) => onTarget(target, (runner, id) => runner.get(id)),
    resolveTerminal: async (terminalId) => {
      const { runner, id, fleet } = route(terminalId);
      const found = await runner.resolveTerminal(id);
      return found === undefined ? undefined : qualify(fleet, found);
    },
    wait: (target, signal) => onTarget(target, (runner, id) => runner.wait(id, signal)),
    waitForChange: (target, status, signal) =>
      onTarget(target, (runner, id) =>
        runner.waitForChange === undefined
          ? runner.wait(id, signal)
          : runner.waitForChange(id, status, signal),
      ),
    waitUntilIdle: (target, signal) =>
      onTarget(target, (runner, id) =>
        runner.waitUntilIdle === undefined ? runner.wait(id, signal) : runner.waitUntilIdle(id, signal),
      ),
    transcript: async (agent) => {
      const { runner } = route(agent.paneId);
      return runner.transcript?.(unqualify(agent));
    },
    read: async (target, harness, source) => {
      const { runner, id } = route(target);
      if (runner.read === undefined) throw new Error("Herdr read is unavailable");
      return runner.read(id, harness, source);
    },
    sendText: async (target, text) => {
      const { runner, id } = route(target);
      if (runner.sendText === undefined) throw new Error("Herdr send is unavailable");
      await runner.sendText(id, text);
    },
    pressEnter: async (target) => {
      const { runner, id } = route(target);
      if (runner.pressEnter === undefined) throw new Error("Herdr send is unavailable");
      await runner.pressEnter(id);
    },
    sendKeys: async (target, key) => {
      const { runner, id } = route(target);
      if (runner.sendKeys === undefined) throw new Error("Herdr send-keys is unavailable");
      await runner.sendKeys(id, key);
    },
    paneProcesses: async (paneId) => {
      const { runner, id } = route(paneId);
      if (runner.paneProcesses === undefined) throw new Error("Herdr process info is unavailable");
      return runner.paneProcesses(id);
    },
    // A pid is only meaningful on the machine that reported it; the local
    // runner answers for local panes and remote codex seats take the pty lane.
    ...(local.openFiles === undefined ? {} : { openFiles: local.openFiles }),
    ...(local.codexQueue === undefined ? {} : { codexQueue: local.codexQueue }),
    closePane: async (target) => {
      const { runner, id } = route(target);
      if (runner.closePane === undefined) throw new Error("Herdr close is unavailable");
      await runner.closePane(id);
    },
    createTab: async (options) => {
      const runner = options.fleet === undefined ? local : fleets.get(options.fleet);
      if (runner?.createTab === undefined) throw new Error(`Unknown Herdr fleet ${String(options.fleet)}`);
      const paneId = await runner.createTab(options);
      return options.fleet === undefined ? paneId : fleetQualified(options.fleet, paneId);
    },
    startAgent: async (options) => {
      const { runner, id } = route(options.paneId);
      if (runner.startAgent === undefined) throw new Error("Herdr agent start is unavailable");
      await runner.startAgent({ ...options, paneId: id });
    },
    ...(local.addClaudeMcp === undefined ? {} : { addClaudeMcp: local.addClaudeMcp }),
    ...(local.installPiIntegration === undefined ? {} : { installPiIntegration: local.installPiIntegration }),
    ...(local.configurePiProvider === undefined ? {} : { configurePiProvider: local.configurePiProvider }),
  };
}
