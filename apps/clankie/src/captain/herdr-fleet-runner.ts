import { fleetQualified, splitFleetQualified, type HerdrFleet, type HerdrFleetRun } from "../herdr-fleet.ts";
import { createSshAgentHost } from "@clankie/agent-hosts";
import type { AgentTranscriptHost } from "@clankie/agent-transcript";
import { remoteHerdrTranscriptReader } from "./remote-herdr-transcript.ts";
import type { PreparedCommandTab } from "./prepared-native-host.ts";
import {
  createHerdrWatchRunner,
  parseHerdrPaneList,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "./herdr-watch.ts";

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
 * the SSH host's confined transcript reader. Other replies use `herdr agent read`.
 * A Codex seat Clankie hired here is driven through its own app-server over
 * ssh (VUH-1527); every other remote message stays refused rather than typed.
 */
export function createRemoteHerdrRunner(
  fleet: HerdrFleet,
  run: HerdrFleetRun,
  options: {
    readonly pollMs?: number;
    readonly transcriptHost?: AgentTranscriptHost;
    readonly createCommandTab?: (input: PreparedCommandTab) => Promise<string>;
  } = {},
): HerdrWatchRunner {
  const base = createHerdrWatchRunner(undefined, run, options.createCommandTab, {
    localCodexRecovery: false,
  });
  const pollMs = options.pollMs ?? REMOTE_POLL_MS;
  let cached: { readonly at: number; readonly panes: Promise<readonly HerdrAgentSnapshot[]> } | undefined;

  const panes = (fresh = false): Promise<readonly HerdrAgentSnapshot[]> => {
    const now = Date.now();
    if (fresh || cached === undefined || now - cached.at >= pollMs / 2) {
      const pending = run(["pane", "list"]).then(parseHerdrPaneList);
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

  /**
   * A pane can be newer than the shared poll (a hire just made it), so a miss
   * reads the list once more before reporting the terminal gone.
   */
  const terminal = async (terminalId: string): Promise<HerdrAgentSnapshot | undefined> =>
    (await panes()).find((pane) => pane.terminalId === terminalId) ??
    (await panes(true)).find((pane) => pane.terminalId === terminalId);

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

  return {
    ...base,
    get: current,
    resolveTerminal: terminal,
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

/**
 * One runner over every fleet (ADR 0184). A `<fleet>/` prefix routes a pane or
 * terminal id to that fleet's runner, and everything it answers comes back
 * qualified the same way, so a watch, a seat or a hire records an id that still
 * names its machine after a restart. Bare ids stay on the local default fleet.
 */
export function routeHerdrFleets(
  local: HerdrWatchRunner,
  fleets: ReadonlyMap<string, HerdrWatchRunner> | (() => Promise<ReadonlyMap<string, HerdrWatchRunner>>),
): HerdrWatchRunner {
  const current = async () => (typeof fleets === "function" ? fleets() : fleets);
  // Fleet factories refresh per call. Keep placement serialization at the
  // controller boundary too, so concurrent hires cannot each found a workspace.
  const allocations = new Map<string, Promise<string>>();
  const route = async (target: string): Promise<{ runner: HerdrWatchRunner; id: string; fleet?: string }> => {
    const qualified = splitFleetQualified(target);
    if (qualified === undefined) return { runner: local, id: target };
    const runner = (await current()).get(qualified.fleet);
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
    const { runner, id, fleet } = await route(target);
    return qualify(fleet, await call(runner, id));
  };
  return {
    list: async (fleet) => {
      const runner = fleet === undefined ? local : (await current()).get(fleet);
      if (runner?.list === undefined)
        throw new Error(`Complete Herdr inventory unavailable for ${fleet ?? "local"}`);
      return (await runner.list()).map((snapshot) => qualify(fleet, snapshot));
    },
    get: (target) => onTarget(target, (runner, id) => runner.get(id)),
    resolveTerminal: async (terminalId) => {
      const { runner, id, fleet } = await route(terminalId);
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
      const { runner } = await route(agent.paneId);
      return runner.transcript?.(unqualify(agent));
    },
    read: async (target, harness, source) => {
      const { runner, id } = await route(target);
      if (runner.read === undefined) throw new Error("Herdr read is unavailable");
      return runner.read(id, harness, source);
    },
    readPane: async (target, source, format) => {
      const { runner, id } = await route(target);
      if (!runner.readPane) throw new Error("Styled pane input is unavailable");
      return runner.readPane(id, source, format);
    },
    paneProcesses: async (paneId) => {
      const { runner, id } = await route(paneId);
      if (runner.paneProcesses === undefined) throw new Error("Herdr process info is unavailable");
      return runner.paneProcesses(id);
    },
    // A pid is only meaningful on the machine that reported it; the local
    // runner answers for local panes; remote codex seats use their own app-server.
    ...(local.openFiles === undefined ? {} : { openFiles: local.openFiles }),
    ...(local.codexControl === undefined ? {} : { codexControl: local.codexControl }),
    ...(local.codexQueue === undefined ? {} : { codexQueue: local.codexQueue }),
    closePane: async (target) => {
      const { runner, id } = await route(target);
      if (runner.closePane === undefined) throw new Error("Herdr close is unavailable");
      await runner.closePane(id);
    },
    createTab: async (options) => {
      const runner = options.fleet === undefined ? local : (await current()).get(options.fleet);
      if (runner?.createTab === undefined) throw new Error(`Unknown Herdr fleet ${String(options.fleet)}`);
      const key = options.fleet ?? "local";
      const next = (allocations.get(key) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          const paneId = await runner.createTab!(options);
          return options.fleet === undefined ? paneId : fleetQualified(options.fleet, paneId);
        });
      allocations.set(key, next);
      try {
        return await next;
      } finally {
        if (allocations.get(key) === next) allocations.delete(key);
      }
    },
    startAgent: async (options) => {
      const { runner, id } = await route(options.paneId);
      if (runner.startAgent === undefined) throw new Error("Herdr agent start is unavailable");
      await runner.startAgent({ ...options, paneId: id });
    },
    ...(local.runInPane === undefined
      ? {}
      : {
          runInPane: async (target: string, argv: readonly string[]) => {
            const { runner, id } = await route(target);
            if (runner.runInPane === undefined) throw new Error("Herdr pane run is unavailable");
            await runner.runInPane(id, argv);
          },
        }),
    ...(local.installPiIntegration === undefined ? {} : { installPiIntegration: local.installPiIntegration }),
    ...(local.configurePiProvider === undefined ? {} : { configurePiProvider: local.configurePiProvider }),
  };
}
