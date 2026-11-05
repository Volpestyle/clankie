import { findExecutable } from "../find-executable.ts";
import { HerdrCoreError, SEAT_LABEL, herdrCoreCall, herdrCoreSocketPath } from "./herdr-core.ts";

// Where Clankie's hires start in the Herdr desktop app (ADR 0319): a terminal in
// herdr-core, the app's terminal server, labeled into one Clankie space so the
// window shows it. The core starts, inspects and ends these terminals. A hire's
// messages reach it through its worker channel, never through the terminal's
// input (ADR 0207); the only input is named keys, pressed for the owner or a
// connected app he turned keys on for (ADR 0323), never text.

/** The desktop app shows a terminal labeled with a space; this one is Clankie's. */
export const CLANKIE_SPACE = "clankie";
const SPACE_LABEL = "herdr.space";
const TAB_LABEL = "herdr.tab";
/** Which hire a terminal holds, so Clankie finds his own terminals again by label. */
export { SEAT_LABEL };

/**
 * The core starts a terminal with its own environment and the run's values on top.
 * A core started from a Herdr pane carries that pane's identity, which would make a
 * hire's worker think it sits in that pane, so a hire's terminal clears it. HERDR_ENV
 * goes too: it switches on Herdr's own in-pane reporting, and a desktop hire is no pane.
 */
const INHERITED_HERDR_IDENTITY = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
] as const;

/**
 * A core started from an agent's shell tool, such as Codex's, carries that tool's
 * colorless settings, and a hire would draw in plain white, so a hire's terminal clears them.
 */
const INHERITED_COLOR_OPT_OUTS = ["NO_COLOR", "FORCE_COLOR"] as const;

/**
 * The Herdr desktop app tells the terminals it opens itself on a Mac that its browser
 * is there (herdr-app `hc.rs`): HERDR_BROWSER marks it, and BROWSER sends a link to a
 * browser pane. A hire is started here, not by the app, so it gets the same values,
 * but only when Herdr Browser is installed, so a hire without it falls back (#697).
 */
async function herdrBrowserEnv(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  if (process.platform !== "darwin") return {};
  return (await findExecutable("herdr-browser-open", env))
    ? { HERDR_BROWSER: "1", BROWSER: "herdr-browser-open" }
    : {};
}

interface HerdrCoreSeatStart {
  /** The hire's command, run as the terminal's own program. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The hire this terminal holds; also its tab in the Clankie space. */
  readonly seat: string;
  /** A tab shared with other terminals, such as a project's pipeline; the hire's own by default. */
  readonly tab?: string;
  /** The space this terminal shows in; Clankie's one space by default. */
  readonly space?: string;
  /** Extra labels, such as the names the window should give its space and tab. */
  readonly labels?: Readonly<Record<string, string>>;
}

export interface HerdrCoreTerminal {
  readonly address: string;
  readonly state: "live" | "finished";
  readonly labels: Readonly<Record<string, string>>;
  readonly pid?: number;
  readonly exitCode?: number;
  /** When its program ended (ms since the epoch), once it has. */
  readonly finishedMs?: number;
  /** The agent's own status report (OSC 7501), when it gives one. */
  readonly status?: string;
  /** Which agent reported it (`claude-code`, `codex`). */
  readonly app?: string;
  readonly title?: string;
  readonly cwd?: string;
}

export interface HerdrCoreSeats {
  /** Whether the desktop app's core answers on this machine now. */
  available(): Promise<boolean>;
  /** Starts a hire's terminal and answers its core address (`t7`). */
  start(request: HerdrCoreSeatStart): Promise<string>;
  /** The terminal now, or undefined once the core no longer has it. */
  get(address: string): Promise<HerdrCoreTerminal | undefined>;
  /** Every terminal the core keeps, live or finished, Clankie's or not. */
  list(): Promise<readonly HerdrCoreTerminal[]>;
  /** The finished terminals the core still keeps, which a plain list leaves out. */
  finished(): Promise<readonly HerdrCoreTerminal[]>;
  /** Ends a terminal Clankie started; one that is already gone is not an error. */
  kill(address: string, beforeDispatch?: () => void): Promise<void>;
  /**
   * Takes a finished terminal out of the core, so the window no longer shows it; one that is
   * gone is not an error. False when it is still live and so stays (#584).
   */
  remove(address: string): Promise<boolean>;
  /** The terminal's text: its screen, with `lines` of history above it. */
  read(address: string, lines: number): Promise<string>;
  /** Sets labels on a terminal Clankie started; an empty value removes one. */
  label(address: string, labels: Readonly<Record<string, string>>): Promise<void>;
  /** Presses named keys (`up`, `esc`, `ctrl+c`) in the terminal, encoded for its program's modes. */
  keys(address: string, keys: readonly string[]): Promise<void>;
}

export interface HerdrCoreSeatsOptions {
  readonly socketPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Clankie's own Herdr session socket. A hire's terminal gets it as HERDR_SOCKET_PATH
   * so the `herdr` CLI there reaches a Herdr server rather than failing on an empty
   * path (#291); its pane id stays empty, so the worker still knows its seat from the core.
   */
  readonly herdrSocket?: string;
}

export function createHerdrCoreSeats(options: HerdrCoreSeatsOptions = {}): HerdrCoreSeats {
  const socket = () => options.socketPath ?? herdrCoreSocketPath(options.env ?? process.env);
  const call = (method: string, params: Record<string, unknown>, beforeDispatch?: () => void) =>
    herdrCoreCall(socket(), method, params, beforeDispatch);
  return {
    async available() {
      try {
        await call("terminal.list", {});
        return true;
      } catch (error) {
        if (error instanceof HerdrCoreError) return false;
        throw error;
      }
    },

    async start(request) {
      if (request.argv.length === 0) throw new Error("A hire's terminal needs a command");
      // The terminal the desktop app itself opens, so a hire draws the way the owner's own terminals do.
      const env: Record<string, string> = {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TERM_PROGRAM: "herdr",
        ...Object.fromEntries(
          [...INHERITED_HERDR_IDENTITY, ...INHERITED_COLOR_OPT_OUTS].map((key) => [key, ""]),
        ),
        ...(options.herdrSocket?.trim() ? { HERDR_SOCKET_PATH: options.herdrSocket.trim() } : {}),
        ...(await herdrBrowserEnv(options.env ?? process.env)),
        ...request.env,
      };
      const started = (await call("terminal.run", {
        argv: [...request.argv],
        cwd: request.cwd,
        env,
        labels: {
          ...request.labels,
          [SPACE_LABEL]: request.space ?? CLANKIE_SPACE,
          [TAB_LABEL]: request.tab ?? request.seat,
          [SEAT_LABEL]: request.seat,
        },
        // A hire outlives the window and a core restart; the core brings a lost one back as a shell.
        keep: true,
      })) as { address?: unknown };
      if (typeof started.address !== "string" || started.address.length === 0)
        throw new HerdrCoreError("herdr-core started the terminal without answering its address.");
      return started.address;
    },

    async get(address) {
      try {
        return terminalOf((await call("terminal.get", { terminal: address })) as HcRecord);
      } catch (error) {
        if (error instanceof HerdrCoreError && error.kind === "not_found") return undefined;
        throw error;
      }
    },

    async list() {
      const listed = (await call("terminal.list", {})) as { terminals?: unknown };
      return (Array.isArray(listed.terminals) ? (listed.terminals as HcRecord[]) : []).flatMap((record) =>
        record !== null && typeof record === "object" && typeof record.address === "string"
          ? [terminalOf(record)]
          : [],
      );
    },

    async finished() {
      const listed = (await call("terminal.list", { all: true })) as { terminals?: unknown };
      return (Array.isArray(listed.terminals) ? (listed.terminals as HcRecord[]) : []).flatMap((record) =>
        record !== null &&
        typeof record === "object" &&
        typeof record.address === "string" &&
        record.state === "finished"
          ? [terminalOf(record)]
          : [],
      );
    },

    async read(address, lines) {
      const read = (await call("terminal.read", { terminal: address, lines })) as { text?: unknown };
      return typeof read.text === "string" ? read.text : "";
    },

    async label(address, labels) {
      await call("terminal.label", { terminal: address, labels: { ...labels } });
    },

    async keys(address, keys) {
      await call("terminal.keys", { terminal: address, keys: [...keys] });
    },

    async kill(address, beforeDispatch) {
      try {
        await call("terminal.kill", { terminal: address }, beforeDispatch);
      } catch (error) {
        // Gone, or already ended: either way it no longer runs.
        if (error instanceof HerdrCoreError && (error.kind === "not_found" || error.kind === "finished"))
          return;
        throw error;
      }
    },

    async remove(address) {
      try {
        await call("terminal.rm", { terminal: address });
        return true;
      } catch (error) {
        if (error instanceof HerdrCoreError && error.kind === "not_found") return true;
        if (error instanceof HerdrCoreError && error.kind === "live") return false;
        throw error;
      }
    },
  };
}

interface HcRecord {
  readonly address?: unknown;
  readonly state?: unknown;
  readonly labels?: unknown;
  readonly pid?: unknown;
  readonly exit_code?: unknown;
  readonly finished_ms?: unknown;
  readonly status?: { readonly state?: unknown; readonly app?: unknown } | null;
  readonly title?: unknown;
  readonly cwd?: unknown;
}

function terminalOf(record: HcRecord): HerdrCoreTerminal {
  if (typeof record.address !== "string")
    throw new HerdrCoreError("herdr-core answered a terminal without its address.");
  const labels =
    record.labels !== null && typeof record.labels === "object"
      ? Object.fromEntries(
          Object.entries(record.labels as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  const status = record.status?.state;
  const app = record.status?.app;
  return {
    address: record.address,
    state: record.state === "finished" ? "finished" : "live",
    labels,
    ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    ...(typeof record.exit_code === "number" ? { exitCode: record.exit_code } : {}),
    ...(typeof record.finished_ms === "number" ? { finishedMs: record.finished_ms } : {}),
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof app === "string" && app.length > 0 ? { app } : {}),
    ...(typeof record.title === "string" && record.title.length > 0 ? { title: record.title } : {}),
    ...(typeof record.cwd === "string" && record.cwd.length > 0 ? { cwd: record.cwd } : {}),
  };
}
