import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexAppServerClient, openCodexSocket } from "./codex-app-server.ts";
import { codexControlEndpoint } from "./codex-seat.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { hostname } from "node:os";
import type { HerdrForegroundProcess } from "./codex-seat.ts";
import type { HerdrCensusFleet } from "./herdr-census.ts";
import { readHerdrSeatTranscript, type HerdrAgentSession } from "./herdr-transcript.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import { DESKTOP_SEAT_FLEET } from "../herdr-fleet.ts";
import { AGENT_LABEL, SESSION_LABEL } from "./herdr-core.ts";
import { SEAT_LABEL, type HerdrCoreSeats, type HerdrCoreTerminal } from "./herdr-core-seats.ts";
import {
  SPACE_NAME_LABEL,
  TAB_NAME_LABEL,
  hireProject,
  nameClankieTabs,
  placeHire,
  type HerdrWindow,
} from "./herdr-window.ts";

// Clankie's hires in the Herdr desktop app's terminals (ADR 0319), seen the way his
// seat code sees a Herdr pane. Routed under one reserved prefix (`herdr-core/t7`), so
// a seat, a receipt or a watch keeps naming the core's terminal across restarts. Only
// terminals Clankie started (labeled with a seat) answer: an owner's own terminal is
// read through the connector's session source, never driven here.

/** The prefix a desktop-app terminal's seat id carries; no Herdr fleet may take it. */
export const HERDR_CORE_FLEET = DESKTOP_SEAT_FLEET;

/**
 * The agent name Clankie minted for the hire, unique among live seats as a Herdr agent's
 * name is. The seat label is only what the desktop app shows, and many hires share one
 * ("clankie · Work"), so it never names a seat: a shared name merged every hire into one
 * character and sent one hire's messages to another (#208).
 */
const NAME_LABEL = "clankie.name";

/** The harnesses a desktop-app terminal can start so far, by the binary its owner runs. */
const HARNESS_BINARIES: Readonly<Record<string, string>> = { claude: "claude", codex: "codex" };

/**
 * A new hire's terminal runs this until Clankie hands it the harness command. The core
 * starts a terminal with its program and takes no command after that, and Clankie never
 * types into a terminal (ADR 0207), so the command arrives as a private file the
 * launcher sources: it removes the file, then execs the harness in its place. A
 * terminal whose command never comes ends after ten minutes.
 */
const LAUNCHER = [
  'f="$1"',
  "n=0",
  'while [ ! -f "$f" ]; do',
  "  n=$((n + 1))",
  '  if [ "$n" -gt 3000 ]; then echo "Clankie never started this hire." >&2; exit 1; fi',
  "  sleep 0.2",
  "done",
  '. "$f"',
].join("\n");

const exec = promisify(execFile);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** The agent status OSC 7501 reports, in the words Herdr uses for a pane's agent. */
const STATUSES = new Set(["idle", "working", "blocked", "done"]);
const SETTLED = new Set(["idle", "done", "blocked"]);
const POLL_MS = 500;
/** How long a start waits for the launcher to take its handoff; it polls every 0.2 s. */
const LAUNCH_HANDOFF_MS = 3_000;
const IDLE_WAIT_MS = 30_000;
/** How often, and how many times, a new hire's tab is looked for to name it. */
const NAME_RETRY_MS = 500;
const NAME_ATTEMPTS = 30;
const HISTORY_LINES = 2_000;

/** The agent name Herdr gives the app a 7501 report names. */
function agentOf(app: string | undefined): string {
  if (app === undefined) return "unknown";
  if (app === "claude-code" || app === "claude") return "claude";
  return app;
}

/**
 * What Clankie started in one of his terminals, kept where only the service writes. A
 * terminal's labels name its seat and session for anyone looking, but any process in
 * the terminal can relabel it through the core's socket, so a seat's proof (ADR 0319)
 * trusts this record: the terminal's pid when the harness took it, and its session.
 */
export interface DesktopSeatRecord {
  readonly pid: number;
  readonly agent: string;
  readonly session: string;
}

const recordPath = (directory: string, address: string) => {
  if (!/^t[0-9a-z]+$/u.test(address)) throw new Error(`Not a desktop-app terminal: ${address}`);
  return join(directory, `${address}.json`);
};

/** The record Clankie kept for this terminal, or undefined when it kept none. */
export async function readDesktopSeat(
  directory: string,
  address: string,
): Promise<DesktopSeatRecord | undefined> {
  try {
    const value = JSON.parse(
      await readFile(recordPath(directory, address), "utf8"),
    ) as Partial<DesktopSeatRecord>;
    return Number.isSafeInteger(value.pid) &&
      value.pid! > 1 &&
      typeof value.agent === "string" &&
      typeof value.session === "string" &&
      value.session.length > 0
      ? { pid: value.pid!, agent: value.agent, session: value.session }
      : undefined;
  } catch {
    return undefined;
  }
}

/** A live terminal Clankie started at this address, with its program's pid; null otherwise. */
export async function liveDesktopTerminal(
  seats: HerdrCoreSeats,
  address: string,
): Promise<{ readonly pid: number } | null> {
  const terminal = await seats.get(address);
  return terminal?.state === "live" && terminal.labels[SEAT_LABEL] !== undefined && terminal.pid !== undefined
    ? { pid: terminal.pid }
    : null;
}

/**
 * The harness in a live seat of Clankie's, from his private record of it (ADR 0319): null
 * unless the terminal is live, his, and its pid is still the one the harness took.
 */
export async function liveDesktopSeat(
  seats: HerdrCoreSeats,
  directory: string,
  address: string,
): Promise<DesktopSeatRecord | null> {
  const terminal = await liveDesktopTerminal(seats, address);
  const record = terminal === null ? undefined : await readDesktopSeat(directory, address);
  return record !== undefined && record.pid === terminal?.pid ? record : null;
}

async function writePrivately(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * What a hire's native controller reports about the harness it drives in one of
 * Clankie's terminals, the way it reports a Herdr pane's agent (`pane report-agent`).
 * Codex learns its thread only once its view is running, so its session arrives here
 * rather than in the launch arguments, and its turns come from its app-server.
 */
export interface DesktopAgentReport {
  readonly agent: string;
  readonly state?: string;
  readonly session?: string;
}

/** A finished terminal's hire as its labels name it, for removeFinished to match against its records. */
export interface FinishedHire {
  readonly seatId: string;
  readonly agent: string;
  readonly session: string;
}

export interface HerdrCoreRunnerOptions {
  readonly seats: HerdrCoreSeats;
  /**
   * A hire's turn as its harness's own hooks last reported it, for a terminal whose
   * program reports no status of its own: the core keeps only OSC 7501 reports.
   */
  readonly turn?: (session: string) => "working" | "idle" | undefined;
  /** A private directory for launch handoffs; only the service writes here. */
  readonly launchDirectory?: string;
  /** A private directory for the records a seat's proof trusts (readDesktopSeat). */
  readonly seatDirectory?: string;
  /**
   * The installed harness as an absolute command (its executable, or interpreter and
   * script), the same one a seat's process proof checks for. Unset or unresolved, the
   * launcher looks the harness up on the terminal's own PATH.
   */
  readonly harnessCommand?: (harness: string) => Promise<readonly string[] | undefined>;
  readonly pollMs?: number;
  /** The desktop app's window, to name the spaces and tabs a hire opens; unset, they stay unnamed. */
  readonly window?: HerdrWindow;
}

/** A seat runner for the desktop app's core: it starts, reads, waits on and closes Clankie's hires. */
export function createHerdrCoreRunner(options: HerdrCoreRunnerOptions): HerdrWatchRunner &
  Required<Pick<HerdrWatchRunner, "list" | "readPane" | "closePane" | "createTab" | "startAgent">> & {
    /** Records a controller's report on a harness Clankie started here (DesktopAgentReport). */
    reportAgent(address: string, report: DesktopAgentReport): Promise<void>;
    /**
     * Takes out of the window Clankie's own terminals that finished at least `ageMs` ago:
     * nothing runs in them, and nothing else lists or closes them (#584). Answers their addresses.
     */
    removeFinished(
      ageMs: number,
      hired: (terminal: FinishedHire) => boolean,
      now?: number,
    ): Promise<string[]>;
  } {
  const { seats } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  /** Terminals waiting at the launcher, by address, with the file their command goes in. */
  const pending = new Map<string, string>();
  /** The turn a hire's native controller last reported, by address, for a harness with no hooks here. */
  const reported = new Map<string, string>();
  /**
   * Names a new hire's space and tab once the window places it (on its next listing). One
   * pass at a time, in the background: a hire never waits on the window, and no window
   * open leaves the names on the terminals for the next pass.
   */
  const appWindow = options.window;
  let naming: Promise<void> | undefined;
  let again = false;
  const nameTabs = () => {
    if (appWindow === undefined) return;
    if (naming !== undefined) {
      again = true;
      return;
    }
    naming = (async () => {
      for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
        again = false;
        const waiting = await nameClankieTabs(seats, appWindow);
        if (waiting === undefined || (waiting === 0 && !again)) return;
        await new Promise<void>((resolve) => setTimeout(resolve, NAME_RETRY_MS).unref());
      }
    })()
      // allow-swallowed-rejection -- names are cosmetic; the hire already started
      .catch(() => undefined)
      .finally(() => {
        naming = undefined;
      });
  };
  /** The program's own report, else its harness hooks' turn once Clankie started it, else unknown. */
  const statusOf = (terminal: HerdrCoreTerminal, session: HerdrAgentSession | undefined): string => {
    if (terminal.state !== "live") return "offline";
    if (terminal.status !== undefined && STATUSES.has(terminal.status)) return terminal.status;
    if (terminal.labels[AGENT_LABEL] === undefined) return "unknown";
    const controlled = reported.get(terminal.address);
    if (controlled !== undefined) return controlled;
    return (session?.kind === "id" ? options.turn?.(session.value) : undefined) ?? "idle";
  };
  const snapshot = (terminal: HerdrCoreTerminal): HerdrAgentSnapshot => {
    const labeled = terminal.labels[SESSION_LABEL];
    // The core knows no agent session: this is the one Clankie named at launch.
    const session: HerdrAgentSession | undefined =
      labeled === undefined
        ? undefined
        : { source: `herdr:${terminal.labels[AGENT_LABEL] ?? "claude"}`, kind: "id", value: labeled };
    const name = terminal.labels[NAME_LABEL];
    const live = terminal.state === "live";
    return {
      paneId: terminal.address,
      terminalId: terminal.address,
      ...(name === undefined ? {} : { name }),
      agent: live ? agentOf(terminal.app ?? terminal.labels[AGENT_LABEL]) : "unknown",
      status: statusOf(terminal, session),
      title: terminal.title ?? "",
      ...(session === undefined ? {} : { session }),
      ...(terminal.cwd === undefined ? {} : { workingDirectory: terminal.cwd }),
    };
  };
  /** A terminal of Clankie's own, or undefined: the core no longer has it, or it isn't his. */
  const own = async (address: string): Promise<HerdrCoreTerminal | undefined> => {
    const terminal = await seats.get(address);
    return terminal?.labels[SEAT_LABEL] === undefined ? undefined : terminal;
  };
  /** The harness Clankie started in his own live terminal, as its one process; else undefined. */
  const harnessProcess = async (address: string): Promise<HerdrForegroundProcess[] | undefined> => {
    const terminal = await own(address);
    if (terminal === undefined) throw new Error(`The desktop app has no Clankie terminal ${address}`);
    const harness = terminal.labels[AGENT_LABEL];
    if (terminal.state !== "live" || harness === undefined || terminal.pid === undefined) return undefined;
    if (harness !== "codex") return [{ pid: terminal.pid, name: harness }];
    // Labels survive a service restart, but cannot select a socket. Require our
    // private seat record and observe the surviving TUI's actual --remote argv.
    const recorded =
      options.seatDirectory === undefined
        ? null
        : await liveDesktopSeat(seats, options.seatDirectory, address);
    if (recorded?.agent !== "codex" || recorded.session !== terminal.labels[SESSION_LABEL]) return [];
    const { stdout } = await exec("/bin/ps", ["-ww", "-p", String(terminal.pid), "-o", "command="], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    // Dedicated sockets generated by the launcher contain no whitespace. Ambiguous
    // command lines fail closed rather than guessing a daemon or another session.
    const endpoints = [...stdout.matchAll(/(?:^|\s)--remote(?:=|\s+)(unix:\/\/[^\s'"`]+)(?=\s|$)/gu)];
    const fresh = await liveDesktopSeat(seats, options.seatDirectory!, address);
    if (endpoints.length !== 1 || fresh?.pid !== recorded.pid || fresh.session !== recorded.session)
      return [];
    return [{ pid: terminal.pid, name: harness, argv: ["codex", "--remote", endpoints[0]![1]!] }];
  };
  const get = async (address: string): Promise<HerdrAgentSnapshot> => {
    const terminal = await own(address);
    if (terminal === undefined) throw new Error(`The desktop app has no Clankie terminal ${address}`);
    return snapshot(terminal);
  };
  /** Polls until `done` holds for the terminal's snapshot, it is gone, or the signal ends the wait. */
  const until = async (
    address: string,
    done: (agent: HerdrAgentSnapshot) => boolean,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<HerdrAgentSnapshot> => {
    const end = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    for (;;) {
      signal.throwIfAborted();
      const agent = await get(address);
      if (done(agent) || agent.status === "offline" || (end !== undefined && Date.now() >= end)) return agent;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer);
          reject(signal.reason);
        };
        // Each delay takes its listener back, so a long wait holds one at a time.
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", aborted);
          resolve();
        }, pollMs);
        signal.addEventListener("abort", aborted, { once: true });
      });
    }
  };
  return {
    removeFinished: async (ageMs, hired, now = Date.now()) => {
      const removed: string[] = [];
      for (const terminal of await seats.finished()) {
        const agent = terminal.labels[AGENT_LABEL];
        const session = terminal.labels[SESSION_LABEL];
        // Only a hire this service recorded, by its seat and session: a label alone is anyone's
        // to write, and an owner's finished terminal is his to keep or remove.
        if (terminal.labels[SEAT_LABEL] === undefined || agent === undefined || session === undefined)
          continue;
        if (terminal.finishedMs === undefined || now - terminal.finishedMs < ageMs) continue;
        if (!hired({ seatId: `${HERDR_CORE_FLEET}/${terminal.address}`, agent, session })) continue;
        if (!(await seats.remove(terminal.address))) continue;
        pending.delete(terminal.address);
        reported.delete(terminal.address);
        if (options.seatDirectory !== undefined)
          await rm(recordPath(options.seatDirectory, terminal.address), { force: true });
        removed.push(terminal.address);
      }
      return removed;
    },
    // Only Clankie's own live terminals: an owner's terminal is never a seat here.
    list: async () =>
      (await seats.list())
        .filter((terminal) => terminal.state === "live" && terminal.labels[SEAT_LABEL] !== undefined)
        .map(snapshot),
    get,
    resolveTerminal: async (address) => {
      const terminal = await own(address);
      return terminal === undefined ? undefined : snapshot(terminal);
    },
    wait: (address, signal) => until(address, (agent) => SETTLED.has(agent.status), signal),
    waitForChange: (address, current, signal) => until(address, (agent) => agent.status !== current, signal),
    waitUntilIdle: (address, signal) =>
      until(address, (agent) => ["idle", "working", "done"].includes(agent.status), signal, IDLE_WAIT_MS),
    // The harness's own session file, as a Herdr pane's is read: Clankie named the session.
    transcript: async (agent) => {
      if (agent.agent !== "codex") return readHerdrSeatTranscript(agent.agent, agent.session);
      const sessionId = nativeSessionId(agent);
      const process = (await harnessProcess(agent.paneId))?.[0];
      const endpoint = codexControlEndpoint(process);
      if (!sessionId) return undefined;
      const socket =
        typeof endpoint === "string" ? await openCodexSocket(`ws+unix://${endpoint.slice(7)}:/`) : undefined;
      // Its server can be gone while the view lives on (it then says "Reconnect failed"). The
      // session Clankie recorded for this live hire still names its file, found as a Herdr
      // pane's Codex session is (ADR 0307); the label alone is anyone's to write, so never it.
      if (!socket) {
        const recorded =
          options.seatDirectory === undefined
            ? null
            : await liveDesktopSeat(seats, options.seatDirectory, agent.paneId);
        if (recorded?.agent !== "codex" || recorded.session !== sessionId) return undefined;
        const read = readHerdrSeatTranscript("codex", {
          source: "herdr:codex",
          kind: "id",
          value: recorded.session,
        });
        const after = await liveDesktopSeat(seats, options.seatDirectory!, agent.paneId);
        return after?.pid === recorded.pid && after.session === recorded.session ? read : undefined;
      }
      const client = new CodexAppServerClient(socket, () => {}, 5000);
      try {
        await client.initialize(true);
        const read = (await client.request("thread/read", { threadId: sessionId })) as {
          thread?: { id?: string; path?: string };
        };
        const fresh = await get(agent.paneId);
        const observed = (await harnessProcess(agent.paneId))?.[0];
        if (
          read.thread?.id !== sessionId ||
          !read.thread.path ||
          nativeSessionId(fresh) !== sessionId ||
          observed?.pid !== process?.pid ||
          codexControlEndpoint(observed) !== endpoint
        )
          return undefined;
        return readHerdrSeatTranscript("codex", {
          source: "herdr:codex",
          kind: "path",
          value: read.thread.path,
        });
      } finally {
        client.close();
      }
    },
    readPane: async (address, source) => {
      if ((await own(address)) === undefined)
        throw new Error(`The desktop app has no Clankie terminal ${address}`);
      return seats.read(address, source === "visible" ? 0 : HISTORY_LINES);
    },
    // The launcher execs the harness as the terminal's own process (no shell under it), so
    // once Clankie has started a harness there the terminal's pid is the harness's.
    paneProcesses: async (address) => (await harnessProcess(address)) ?? [],
    paneShell: async (address) => {
      const foreground = (await harnessProcess(address)) ?? [];
      return { ...(foreground[0] === undefined ? {} : { shellPid: foreground[0].pid }), foreground };
    },
    // Named keys only, in a terminal Clankie started (ADR 0323); never text, so never a brief.
    sendKeys: async (address, keys) => {
      if ((await own(address)) === undefined)
        throw new Error(`The desktop app has no Clankie terminal ${address}`);
      await seats.keys(address, keys);
    },
    closePane: async (address, guard) => {
      if ((await own(address)) === undefined) return;
      await guard?.();
      guard?.assertCurrent?.();
      pending.delete(address);
      reported.delete(address);
      if (guard?.assertCurrent) await seats.kill(address, guard.assertCurrent);
      else await seats.kill(address);
      // The core keeps an ended terminal in the window until it is removed (#584). The program
      // has ended, so the close stands even if removal fails; auto-tidy's removeFinished retries.
      await seats.remove(address).catch((error: unknown) => {
        console.warn("Desktop terminal removal after close unavailable", address, String(error));
      });
      if (options.seatDirectory !== undefined)
        await rm(recordPath(options.seatDirectory, address), { force: true });
    },
    createTab: async (request) => {
      if (request.fleet !== undefined) throw new Error("The desktop app's terminals belong to this machine");
      const seat = request.paneLabel ?? request.label;
      // Each hire its own tab in its project's space, named for it (a pipeline's shared a few
      // at a time), so the window never squeezes every hire into one tab's columns.
      const place = placeHire(await seats.list(), {
        project: await hireProject(request.cwd, request.project),
        tabName: seat,
        ...(request.pipeline === undefined ? {} : { pipeline: request.pipeline }),
      });
      const placement = {
        space: place.space,
        tab: place.tab,
        labels: { [SPACE_NAME_LABEL]: place.spaceName, [TAB_NAME_LABEL]: place.tabName },
      };
      if (request.command !== undefined) {
        const address = await seats.start({
          argv: request.command,
          cwd: request.cwd,
          ...(request.env === undefined ? {} : { env: request.env }),
          seat,
          ...placement,
        });
        nameTabs();
        return address;
      }
      if (options.launchDirectory === undefined)
        throw new Error("The desktop app's terminals need a launch directory to start a harness");
      await mkdir(options.launchDirectory, { recursive: true, mode: 0o700 });
      const handoff = join(options.launchDirectory, `${randomUUID()}.sh`);
      const launcher = ["/bin/sh", "-c", LAUNCHER, "clankie-seat", handoff];
      // A Herdr pane confines a hire through its SHELL wrapper (worker-sandbox.ts); a core
      // terminal starts no shell, so the launcher itself runs under the worker's profile
      // and the harness it execs, with its tools, inherits it.
      const profile = request.env?.CLANKIE_WORKER_SANDBOX_PROFILE;
      if (profile === undefined && basename(request.env?.SHELL ?? "") === "worker-shell.sh")
        throw new Error("A sandboxed hire needs its worker profile; refusing to start it unconfined");
      const env =
        profile === undefined || request.env === undefined
          ? request.env
          : { ...request.env, SHELL: request.env.CLANKIE_WORKER_SHELL ?? "/bin/zsh" };
      const address = await seats.start({
        argv: profile === undefined ? launcher : ["/usr/bin/sandbox-exec", "-p", profile, ...launcher],
        cwd: request.cwd,
        ...(env === undefined ? {} : { env }),
        seat,
        ...placement,
      });
      pending.set(address, handoff);
      nameTabs();
      return address;
    },
    startAgent: async ({ name, kind, paneId, args = [] }) => {
      const handoff = pending.get(paneId);
      if (handoff === undefined)
        throw new Error(`Desktop-app terminal ${paneId} is not waiting for a harness`);
      const binary = HARNESS_BINARIES[kind];
      if (binary === undefined) throw new Error(`The desktop app's terminals can't start ${kind} yet`);
      const terminal = await own(paneId);
      if (terminal?.state !== "live") throw new Error(`Desktop-app terminal ${paneId} has ended`);
      pending.delete(paneId);
      // The desktop app's own PATH may find another install than the service's, which the
      // seat's process proof would then refuse; exec the exact harness the proof expects.
      // allow-swallowed-rejection -- an unresolved install falls back to the terminal's own PATH, as before
      const command = (await options.harnessCommand?.(kind).catch(() => undefined)) ?? [binary];
      await writePrivately(handoff, `rm -f -- "$1"\nexec ${[...command, ...args].map(quote).join(" ")}\n`);
      // The launcher removes its handoff just before it execs the harness. Until then the
      // terminal's process is still the launcher, so its session and seat record wait for
      // that: a session seen any earlier starts the hire's process proof against the launcher.
      const deadline = Date.now() + LAUNCH_HANDOFF_MS;
      while (
        Date.now() < deadline &&
        (await access(handoff).then(
          () => true,
          () => false,
        ))
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      // The session Clankie named or resumes stays on the terminal, since the core can't detect it.
      // Only Claude takes its session on the command line; Codex reports its thread once its
      // view creates or restores it (reportAgent).
      const named =
        kind === "claude" ? args.findIndex((arg) => arg === "--session-id" || arg === "--resume") : -1;
      const session = named < 0 ? undefined : args[named + 1];
      await seats.label(paneId, {
        [NAME_LABEL]: name,
        [AGENT_LABEL]: kind,
        ...(session === undefined ? {} : { [SESSION_LABEL]: session }),
      });
      // The launcher execs the harness in its own place, so the terminal's pid becomes the harness's.
      if (options.seatDirectory !== undefined && session !== undefined && terminal.pid !== undefined) {
        await mkdir(options.seatDirectory, { recursive: true, mode: 0o700 });
        await writePrivately(
          recordPath(options.seatDirectory, paneId),
          JSON.stringify({ pid: terminal.pid, agent: kind, session } satisfies DesktopSeatRecord),
        );
      }
    },
    reportAgent: async (address, report) => {
      const terminal = await own(address);
      if (terminal?.state !== "live") throw new Error(`Desktop-app terminal ${address} has ended`);
      // Only the harness Clankie started here, once it is running in the terminal's place.
      if (pending.has(address) || terminal.labels[AGENT_LABEL] !== report.agent)
        throw new Error(`Desktop-app terminal ${address} is not running ${report.agent}`);
      if (report.session !== undefined) {
        const labeled = terminal.labels[SESSION_LABEL];
        if (labeled !== undefined && labeled !== report.session)
          throw new Error(`Desktop-app terminal ${address} already holds another session`);
        if (labeled === undefined) await seats.label(address, { [SESSION_LABEL]: report.session });
        // The record a seat's proof trusts, as a launch with a named session writes it.
        if (options.seatDirectory !== undefined && terminal.pid !== undefined) {
          const path = recordPath(options.seatDirectory, address);
          const recorded = await readDesktopSeat(options.seatDirectory, address);
          if (
            recorded !== undefined &&
            (recorded.session !== report.session || recorded.pid !== terminal.pid)
          )
            throw new Error(`Desktop-app terminal ${address} already records another seat`);
          if (recorded === undefined) {
            await mkdir(options.seatDirectory, { recursive: true, mode: 0o700 });
            await writePrivately(
              path,
              JSON.stringify({
                pid: terminal.pid,
                agent: report.agent,
                session: report.session,
              } satisfies DesktopSeatRecord),
            );
          }
        }
      }
      if (report.state !== undefined && STATUSES.has(report.state)) reported.set(address, report.state);
    },
  };
}

/**
 * How a Codex seat's view in one of these terminals reaches the core runner (ADR 0341), in
 * the shape the Codex adapter takes: no Herdr CLI answers for a `herdr-core/` pane, so the
 * view's agent and thread are reported to the runner, and its end is read from the runner's
 * own view of the terminal.
 */
export function desktopCodexViews(
  runner: Pick<ReturnType<typeof createHerdrCoreRunner>, "reportAgent" | "resolveTerminal">,
  pollMs = 3_000,
) {
  const address = (paneId: string) =>
    paneId.startsWith(`${HERDR_CORE_FLEET}/`) ? paneId.slice(HERDR_CORE_FLEET.length + 1) : undefined;
  return {
    owns: (paneId: string) => address(paneId) !== undefined,
    report: (paneId: string, report: { agent: "codex"; state: string; session: string }) =>
      runner.reportAgent(address(paneId)!, report),
    gone: (paneId: string, gone: () => void) => {
      const terminal = address(paneId)!;
      let ended = false;
      const poll = setInterval(() => {
        void runner
          .resolveTerminal(terminal)
          .then((agent) => {
            if (ended || (agent !== undefined && agent.status !== "offline")) return;
            ended = true;
            clearInterval(poll);
            gone();
          })
          // allow-swallowed-rejection -- an unanswered read is not an ended terminal; the next poll asks again
          .catch(() => undefined);
      }, pollMs);
      poll.unref();
      return () => {
        ended = true;
        clearInterval(poll);
      };
    },
  };
}

/**
 * The desktop app's terminals as one more fleet in Clankie's census (ADR 0319), so a
 * hire there is a seat like a Herdr pane's: listed with its persona, messageable
 * through its harness channel, and routed back by its `herdr-core/` id. It answers the
 * two reads the census makes (`agent list`, `api snapshot`) in Herdr's own shape, from
 * the runner's own list, so only terminals Clankie started and named a session for
 * are ever seated.
 */
export function herdrCoreCensusFleet(
  runner: Pick<HerdrWatchRunner, "list">,
  available: () => Promise<boolean>,
): HerdrCensusFleet {
  return {
    id: HERDR_CORE_FLEET,
    session: HERDR_CORE_FLEET,
    host: hostname(),
    run: async (args) => {
      const read = args.join(" ");
      if (read !== "agent list" && read !== "api snapshot")
        throw new Error(`The desktop app's terminals don't answer herdr ${read}`);
      // No desktop app running is an empty fleet, not a machine that stopped answering.
      const agents = await (runner.list?.() ?? Promise.resolve([])).catch(async (error: unknown) => {
        if (await available()) throw error;
        return [];
      });
      const rows = agents.flatMap((agent) =>
        agent.session === undefined || agent.status === "offline"
          ? []
          : [
              {
                pane_id: agent.paneId,
                terminal_id: agent.terminalId,
                ...(agent.name === undefined ? {} : { name: agent.name }),
                agent: agent.agent,
                agent_status: agent.status,
                title: agent.title,
                ...(agent.workingDirectory === undefined ? {} : { cwd: agent.workingDirectory }),
                agent_session: agent.session,
              },
            ],
      );
      return JSON.stringify(
        read === "agent list" ? { result: { agents: rows } } : { result: { snapshot: { agents: rows } } },
      );
    },
  };
}
