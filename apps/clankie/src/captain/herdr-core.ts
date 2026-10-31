import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { OPERATOR_TERMINAL_READ_MAX, type HerdrCoreAgent } from "@clankie/protocol";
import { AgentReadScope, isShell, type LiveAgentOccupant } from "./agent-read-scope.ts";

// herdr-core (`hc`) is the terminal server behind the Herdr desktop app: a
// second home for agents, beside the terminal Herdr Clankie seats in. Clankie
// only looks here. It lists the terminals with a live coding agent in them now
// (a program that reports a status, in front, that isn't a shell), reads what
// that agent showed through the same scope as a Herdr pane (ADR 0307), and
// asks the desktop app to show one. It never sends: `terminal.send` pastes into
// the terminal, which ADR 0207 rules out, and it never starts a core that isn't
// running. JSON-RPC 2.0, one message per line, protocol generation 1.

const GENERATION = 1;
const CALL_MS = 5_000;
const FOCUS_MS = 5_000;
const LIST_MAX = 48;
/** History read above the screen, so an occupant's anchor stays in view as it writes. */
const HISTORY_LINES = 2_000;

type HerdrCoreList =
  | { readonly status: "listed"; readonly agents: readonly HerdrCoreAgent[] }
  | { readonly status: "unavailable"; readonly detail: string };
type HerdrCoreRead =
  | { readonly status: "read"; readonly text: string; readonly detail?: string }
  | { readonly status: "unavailable"; readonly detail: string };
type HerdrCoreFocus =
  | { readonly status: "focused" }
  | { readonly status: "unavailable"; readonly detail: string };

export interface HerdrCore {
  list(): Promise<HerdrCoreList>;
  /** What the agent in that terminal showed since its first read, newest lines last. */
  read(terminal: string): Promise<HerdrCoreRead>;
  /** Show the agent in the desktop app, through the app's own command line. */
  focus(terminal: string): Promise<HerdrCoreFocus>;
}

export interface HerdrCoreOptions {
  /** The core's socket; defaults to `HC_SOCKET`, else the `HC_SESSION` (or `default`) session's. */
  readonly socketPath?: string;
  /** The desktop app's command line; `herdr-app` on PATH by default. */
  readonly appCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** Where `hc` itself looks for the core: `$XDG_STATE_HOME/herdr-core/<session>/<session>.sock`. */
function herdrCoreSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HC_SOCKET !== undefined && env.HC_SOCKET.length > 0) return env.HC_SOCKET;
  const session = env.HC_SESSION !== undefined && env.HC_SESSION.length > 0 ? env.HC_SESSION : "default";
  const state =
    env.XDG_STATE_HOME !== undefined && isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : join(homedir(), ".local", "state");
  return join(state, "herdr-core", session, `${session}.sock`);
}

export function createHerdrCore(options: HerdrCoreOptions = {}): HerdrCore {
  const env = options.env ?? process.env;
  const socket = () => options.socketPath ?? herdrCoreSocketPath(env);
  const appCommand = options.appCommand ?? "herdr-app";
  // Anchors per terminal, kept for this core's life in the service (ADR 0307).
  const scope = new AgentReadScope();
  return {
    async list() {
      try {
        const listed = (await call(socket(), "terminal.list", {})) as { terminals?: unknown };
        const terminals = Array.isArray(listed.terminals) ? (listed.terminals as HcTerminal[]) : [];
        return {
          status: "listed",
          agents: terminals
            .filter((terminal) => liveAgentOccupant(terminal) !== undefined)
            .slice(0, LIST_MAX)
            .map(toAgent),
        };
      } catch (error) {
        return { status: "unavailable", detail: unavailableDetail(error) };
      }
    },

    async read(terminal) {
      try {
        // Only a live agent is read, and only what it showed (ADR 0307), as for a Herdr pane.
        const occupant = liveAgentOccupant(
          (await call(socket(), "terminal.get", { terminal })) as HcTerminal,
          scope.occupantPid(terminal),
        );
        if (occupant === undefined) {
          scope.forget(terminal);
          return { status: "unavailable", detail: "No coding agent is running in that terminal now." };
        }
        const history = await readText(socket(), terminal, HISTORY_LINES);
        const screen = await readText(socket(), terminal, 0);
        // The terminal is read only if the same agent held it on both sides of the reads.
        const after = liveAgentOccupant(
          (await call(socket(), "terminal.get", { terminal })) as HcTerminal,
          occupant.pid,
        );
        if (after?.key !== occupant.key) {
          scope.forget(terminal);
          return {
            status: "unavailable",
            detail: "The agent in that terminal changed while it was read; read it again.",
          };
        }
        const { text, detail } = scope.bound(terminal, occupant, history, screen);
        return {
          status: "read",
          text: text.length > OPERATOR_TERMINAL_READ_MAX ? text.slice(-OPERATOR_TERMINAL_READ_MAX) : text,
          ...(detail === undefined ? {} : { detail }),
        };
      } catch (error) {
        return { status: "unavailable", detail: unavailableDetail(error) };
      }
    },

    async focus(terminal) {
      try {
        await promisify(execFile)(appCommand, ["do", "pane.focus", JSON.stringify({ terminal })], {
          timeout: FOCUS_MS,
          env,
        });
        return { status: "focused" };
      } catch (error) {
        return { status: "unavailable", detail: unavailableDetail(error) };
      }
    },
  };
}

interface HcProcess {
  readonly pid?: unknown;
  readonly name?: unknown;
  readonly argv?: unknown;
}

interface HcTerminal {
  readonly address?: unknown;
  readonly state?: unknown;
  readonly reported?: unknown;
  readonly created_ms?: unknown;
  /** The terminal's own program, as started, and its pid while it runs. */
  readonly argv?: unknown;
  readonly pid?: unknown;
  readonly cwd?: unknown;
  readonly title?: unknown;
  readonly status?: { readonly app?: unknown; readonly state?: unknown } | null;
  /** The foreground process group's leader now. */
  readonly foreground?: HcProcess | null;
}

/**
 * The coding agent in a herdr-core terminal now (ADR 0307), as for a Herdr pane. The program
 * reports a status (hc's own word for an agent) and that status still stands, and the process
 * in front is not a shell. hc keeps a status until the terminal's own program ends, so an agent
 * that exits back to its shell leaves its last word behind; the shell in front is what says the
 * agent is gone. The agent is the terminal's own program when that isn't a shell (an agent
 * launched as the terminal's command, or a shell that exec'd into it), else the process in front.
 * Its pid is part of who it is, so an agent started again in the same terminal is a new occupant.
 */
function liveAgentOccupant(terminal: HcTerminal, previous?: number): LiveAgentOccupant | undefined {
  if (!isLiveAgent(terminal) || terminal.status === null || terminal.status === undefined) return undefined;
  const root = pidOf(terminal.pid);
  const front = terminal.foreground;
  const frontPid = pidOf(front?.pid);
  if (root === undefined || front === null || front === undefined || frontPid === undefined) return undefined;
  const frontArgv0 = argv0(front.argv);
  if (isShell({ name: text(front.name) ?? "", ...(frontArgv0 === undefined ? {} : { argv0: frontArgv0 }) }))
    return undefined;
  const rootIsShell = frontPid !== root && isShell({ name: argv0(terminal.argv) ?? "" });
  const agent = previous === root || previous === frontPid ? previous : rootIsShell ? frontPid : root;
  return {
    pid: agent,
    key: JSON.stringify([
      terminal.address,
      terminal.created_ms ?? null,
      root,
      agent,
      text(terminal.status.app) ?? null,
    ]),
  };
}

function pidOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1 ? value : undefined;
}

function argv0(argv: unknown): string | undefined {
  return Array.isArray(argv) && typeof argv[0] === "string" ? argv[0] : undefined;
}

function isLiveAgent(terminal: HcTerminal): boolean {
  return terminal.state === "live" && terminal.reported === true && typeof terminal.address === "string";
}

function toAgent(terminal: HcTerminal): HerdrCoreAgent {
  const address = terminal.address as string;
  const slash = address.lastIndexOf("/");
  const harness = text(terminal.status?.app) ?? text(terminal.foreground?.name);
  const status = text(terminal.status?.state);
  const title = text(terminal.title);
  const cwd = text(terminal.cwd);
  return {
    terminal: address,
    ...(harness === undefined ? {} : { harness: harness.slice(0, 128) }),
    ...(slash > 0 ? { machine: address.slice(0, slash) } : {}),
    ...(cwd === undefined ? {} : { workingDirectory: cwd.slice(0, 4096) }),
    ...(title === undefined ? {} : { title: title.slice(0, 200) }),
    ...(status === undefined ? {} : { status: status.slice(0, 32) }),
  };
}

/** A terminal's text: `lines` of history above its screen, then the screen. */
async function readText(socketPath: string, terminal: string, lines: number): Promise<string> {
  const read = (await call(socketPath, "terminal.read", { terminal, lines })) as { text?: unknown };
  return typeof read.text === "string" ? read.text : "";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

class HerdrCoreError extends Error {}

/** One call on a fresh connection: `hello` to check the generation and the method, then the call. */
async function call(socketPath: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath);
    let buffered = "";
    const finish = (error: Error | undefined, result?: unknown) => {
      clearTimeout(timer);
      connection.destroy();
      if (error === undefined) resolve(result);
      else reject(error);
    };
    const timer = setTimeout(() => finish(new HerdrCoreError("herdr-core didn't answer in time.")), CALL_MS);
    connection.on("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? new HerdrCoreError("herdr-core isn't running on this Mac.")
          : error,
      ),
    );
    connection.on("connect", () => {
      connection.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: GENERATION } })}\n`,
      );
    });
    connection.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim().length === 0) continue;
        let message: {
          id?: unknown;
          result?: unknown;
          error?: { message?: unknown; data?: { kind?: unknown } };
        };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return finish(new HerdrCoreError("herdr-core answered with something other than JSON."));
        }
        if (message.error !== undefined) {
          const kind = message.error.data?.kind ?? message.error.message;
          return finish(
            new HerdrCoreError(
              kind === "not_found"
                ? "herdr-core has no terminal by that name now."
                : `herdr-core refused: ${String(kind)}`,
            ),
          );
        }
        if (message.id === 1) {
          const methods = (message.result as { methods?: unknown } | undefined)?.methods;
          if (!Array.isArray(methods) || !methods.includes(method))
            return finish(new HerdrCoreError(`This herdr-core doesn't offer ${method}.`));
          connection.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method, params })}\n`);
        } else if (message.id === 2) return finish(undefined, message.result ?? {});
      }
    });
  });
}

function unavailableDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(error instanceof HerdrCoreError))
    return "The Herdr desktop app's command line (herdr-app) isn't installed here.";
  return message.slice(0, 1024);
}
