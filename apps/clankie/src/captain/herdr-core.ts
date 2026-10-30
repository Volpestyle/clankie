import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { OPERATOR_TERMINAL_READ_MAX, type HerdrCoreAgent } from "@clankie/protocol";

// herdr-core (`hc`) is the terminal server behind the Herdr desktop app: a
// second home for agents, beside the terminal Herdr Clankie seats in. Clankie
// only looks here. It lists the terminals whose program reports a status
// (hc's own line between an agent and a shell), reads their screens, and asks
// the desktop app to show one. It never sends: `terminal.send` pastes into the
// terminal, which ADR 0207 rules out, and it never starts a core that isn't
// running. JSON-RPC 2.0, one message per line, protocol generation 1.

const GENERATION = 1;
const CALL_MS = 5_000;
const FOCUS_MS = 5_000;
const LIST_MAX = 48;

type HerdrCoreList =
  | { readonly status: "listed"; readonly agents: readonly HerdrCoreAgent[] }
  | { readonly status: "unavailable"; readonly detail: string };
type HerdrCoreRead =
  | { readonly status: "read"; readonly text: string }
  | { readonly status: "unavailable"; readonly detail: string };
type HerdrCoreFocus =
  | { readonly status: "focused" }
  | { readonly status: "unavailable"; readonly detail: string };

export interface HerdrCore {
  list(): Promise<HerdrCoreList>;
  read(terminal: string, lines: number): Promise<HerdrCoreRead>;
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
  return {
    async list() {
      try {
        const listed = (await call(socket(), "terminal.list", {})) as { terminals?: unknown };
        const terminals = Array.isArray(listed.terminals) ? (listed.terminals as HcTerminal[]) : [];
        return {
          status: "listed",
          agents: terminals.filter(isLiveAgent).slice(0, LIST_MAX).map(toAgent),
        };
      } catch (error) {
        return { status: "unavailable", detail: unavailableDetail(error) };
      }
    },

    async read(terminal, lines) {
      try {
        // Only agents are read: a shell beside them isn't something Clankie lists.
        const found = (await call(socket(), "terminal.get", { terminal })) as HcTerminal;
        if (!isLiveAgent(found))
          return { status: "unavailable", detail: "That terminal isn't a running agent now." };
        const read = (await call(socket(), "terminal.read", { terminal, lines })) as { text?: unknown };
        const text = typeof read.text === "string" ? read.text : "";
        return {
          status: "read",
          text: text.length > OPERATOR_TERMINAL_READ_MAX ? text.slice(-OPERATOR_TERMINAL_READ_MAX) : text,
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

interface HcTerminal {
  readonly address?: unknown;
  readonly state?: unknown;
  readonly reported?: unknown;
  readonly cwd?: unknown;
  readonly title?: unknown;
  readonly status?: { readonly app?: unknown; readonly state?: unknown } | null;
  readonly foreground?: { readonly name?: unknown } | null;
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
