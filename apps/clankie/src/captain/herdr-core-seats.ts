import { HerdrCoreError, herdrCoreCall, herdrCoreSocketPath } from "./herdr-core.ts";

// Where Clankie's hires start in the Herdr desktop app (ADR 0319): a terminal in
// herdr-core, the app's terminal server, labeled into one Clankie space so the
// window shows it. The core only starts, inspects and ends these terminals. A
// hire's messages reach it through its worker channel, never through the
// terminal's input (ADR 0207), so nothing here writes to a terminal.

/** The desktop app shows a terminal labeled with a space; this one is Clankie's. */
export const CLANKIE_SPACE = "clankie";
const SPACE_LABEL = "herdr.space";
const TAB_LABEL = "herdr.tab";
/** Which hire a terminal holds, so Clankie finds his own terminals again by label. */
export const SEAT_LABEL = "clankie.seat";

/**
 * The core starts a terminal with its own environment and the run's values on top.
 * A core started from a Herdr pane carries that pane's identity, which would make a
 * hire's worker think it sits in that pane, so a hire's terminal clears it.
 */
const INHERITED_HERDR_IDENTITY = [
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
] as const;

interface HerdrCoreSeatStart {
  /** The hire's command, run as the terminal's own program. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  /** The hire this terminal holds; also its tab in the Clankie space. */
  readonly seat: string;
  /** A tab shared with other terminals, such as a project's pipeline; the hire's own by default. */
  readonly tab?: string;
}

export interface HerdrCoreTerminal {
  readonly address: string;
  readonly state: "live" | "finished";
  readonly labels: Readonly<Record<string, string>>;
  readonly pid?: number;
  readonly exitCode?: number;
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
  /** Ends a terminal Clankie started; one that is already gone is not an error. */
  kill(address: string): Promise<void>;
  /** The terminal's text: its screen, with `lines` of history above it. */
  read(address: string, lines: number): Promise<string>;
}

export interface HerdrCoreSeatsOptions {
  readonly socketPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export function createHerdrCoreSeats(options: HerdrCoreSeatsOptions = {}): HerdrCoreSeats {
  const socket = () => options.socketPath ?? herdrCoreSocketPath(options.env ?? process.env);
  const call = (method: string, params: Record<string, unknown>) => herdrCoreCall(socket(), method, params);
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
        ...Object.fromEntries(INHERITED_HERDR_IDENTITY.map((key) => [key, ""])),
        ...request.env,
      };
      const started = (await call("terminal.run", {
        argv: [...request.argv],
        cwd: request.cwd,
        env,
        labels: {
          [SPACE_LABEL]: CLANKIE_SPACE,
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

    async read(address, lines) {
      const read = (await call("terminal.read", { terminal: address, lines })) as { text?: unknown };
      return typeof read.text === "string" ? read.text : "";
    },

    async kill(address) {
      try {
        await call("terminal.kill", { terminal: address });
      } catch (error) {
        // Gone, or already ended: either way it no longer runs.
        if (error instanceof HerdrCoreError && (error.kind === "not_found" || error.kind === "finished"))
          return;
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
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof app === "string" && app.length > 0 ? { app } : {}),
    ...(typeof record.title === "string" && record.title.length > 0 ? { title: record.title } : {}),
    ...(typeof record.cwd === "string" && record.cwd.length > 0 ? { cwd: record.cwd } : {}),
  };
}
