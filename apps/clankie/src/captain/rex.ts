import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { OPERATOR_TERMINAL_READ_MAX, type RexAgent } from "@clankie/protocol";
import type { KeyPressResult } from "@clankie/protocol/connector";
import { observeNativeBirth } from "../local-fleet-process.ts";
import { AgentReadScope, isShell, type LiveAgentOccupant } from "./agent-read-scope.ts";
import { TRANSCRIPT_READ_REFUSED, transcriptReadText, transcriptWaiting } from "./agent-transcript-read.ts";
import {
  nativeSessionForProcess,
  readProcessSession,
  sameLifetime,
  type NativeSessionLookup,
} from "./native-session-by-pid.ts";

// Rex (Superlogical, beta, macOS) as a home for agents (#963, ADR 0363): a tmux-style
// server whose sessions and blocks outlive its app. Clankie drives it only through the
// `rex` CLI against this Mac's own server, over its Unix socket. He never starts a server
// (`--autostart=false`), never focuses or raises anything, and never names a remote host;
// a `REX_SERVER` that isn't a local socket is refused rather than followed. Rex's API is in
// beta, so every call first checks the server's API revision and refuses one this adapter
// wasn't built for.
//
// Shapes. From Rex's public docs (superlogical.com/rex/docs, read 2026-11-05): `rex ls
// --json` (`sessions[].session_id`, `label`), `rex api call server.version` (`rex_version`,
// `api_revision`, `api_min_revision`, missing meaning 0), `rex capture`, `rex send-key`,
// `rex block close`, `rex block call format` (`content`), `block.event` with a `paste`
// event, the `rex events --json` envelope, the program-status states and kinds, the exit
// statuses (3 not found, 4 server unreachable). Not in the docs, so guessed from the
// community `rex-claude` skill and the events reference: `rex block ls --json` (`blocks[]`
// with `block_id`, `label`, `creator_name`), the `program_status` block method (`records[]`
// with `id`, `state`, `kind`, `msg`, `app`) and the `process` block method (`foreground`
// with `pid`, `name`, `cwd`, as `terminal.process_changed` carries it). Each of those field
// names appears in the Rex CLI's own JSON tags (Rex Beta.app, read without running it), but
// their nesting is unverified. A real Rex proof is owed before these are trusted (#963).

/** The Rex API revision this adapter was written against (Rex server 0.0.1793299046, 2026-10). */
const REX_API_REVISION = 7;
const CALL_TIMEOUT_MS = 10_000;
/** How long a sent message may take to show the agent working before it is unconfirmed. */
const CONFIRM_MS = 4_000;
const SESSION_MAX = 32;
const BLOCK_MAX = 48;
const TERMINAL_CREATOR = "com.superlogical.terminal";
/** A block Clankie started for a hire carries this label prefix; nothing else may be closed. */
const REX_SEAT_LABEL_PREFIX = "clankie.seat/";
const STATES = new Set(["idle", "working", "done", "blocked", "error"] as const);
type RexState = RexAgent["status"];

const NO_AGENT = "No coding agent is running in that Rex block now.";
const OWNER_AGENT_READ_DETAIL =
  "Read from the session transcript this agent's own harness files name for its process, not its screen.";

type RexUnavailableReason = "missing" | "not_running" | "unsupported" | "remote" | "failed";
type RexList =
  | { readonly status: "listed"; readonly agents: readonly RexAgent[] }
  | { readonly status: "unavailable"; readonly reason: RexUnavailableReason; readonly detail: string };
type RexRead =
  | { readonly status: "read"; readonly text: string; readonly detail?: string }
  | { readonly status: "unavailable"; readonly detail: string };
interface RexSent {
  readonly status: "delivered" | "queued" | "not_delivered" | "unconfirmed";
  readonly detail: string;
}
interface RexClosed {
  readonly status: "closed" | "refused" | "unavailable";
  readonly detail: string;
}

export interface Rex {
  list(): Promise<RexList>;
  /** What the agent in that block showed since its first read, newest lines last (ADR 0307). */
  read(block: string): Promise<RexRead>;
  /** One paste and Enter into the agent, never typed key by key, and never retried another way. */
  send(block: string, text: string): Promise<RexSent>;
  /** Named keys, one at a time; `current` is asked before each, and false presses nothing more. */
  keys(block: string, keys: readonly string[], current?: () => boolean): Promise<KeyPressResult>;
  /** Close a block Clankie started, once its agent isn't mid-turn. */
  close(block: string): Promise<RexClosed>;
}

export interface RexOptions {
  /** The `rex` executable; `rex` on PATH by default. */
  readonly command?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** How an owner-started Claude Code or Codex agent's session is found from its process (#530). */
  readonly nativeSession?: NativeSessionLookup;
  readonly confirmMs?: number;
}

class RexError extends Error {
  readonly reason: RexUnavailableReason;
  /** Rex's own exit status, when it ran. */
  readonly exitCode: number | undefined;
  constructor(message: string, reason: RexUnavailableReason, exitCode?: number) {
    super(message);
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

interface Target {
  readonly session: string;
  readonly block: string;
}

interface StatusRecord {
  readonly state: RexState;
  readonly kind?: string;
  readonly app?: string;
  readonly msg?: string;
}

interface Occupied {
  readonly record: StatusRecord;
  readonly occupant: LiveAgentOccupant;
  readonly cwd?: string;
  readonly foreground: string;
}

export function createRex(options: RexOptions = {}): Rex {
  const command = options.command ?? "rex";
  const env = options.env ?? process.env;
  const confirmMs = options.confirmMs ?? CONFIRM_MS;
  // Anchors per block, kept for this service's life (ADR 0307).
  const scope = new AgentReadScope();

  /** The global options every call carries: never start a server, this Mac's socket only. */
  function prefix(): string[] {
    const server = env.REX_SERVER?.trim();
    const local = server === undefined || server.length === 0 ? undefined : localSocket(server);
    if (server !== undefined && server.length > 0 && local === undefined)
      throw new RexError(
        "Rex here points at a server that isn't this Mac's own (REX_SERVER); Clankie only talks to the local Rex server.",
        "remote",
      );
    return ["--autostart=false", "--timeout", "5s", ...(local === undefined ? [] : ["-S", local])];
  }

  /** The child's environment: none of a calling Rex terminal's own targets. */
  function childEnv(): NodeJS.ProcessEnv {
    return Object.fromEntries(
      Object.entries(env).filter(
        ([key]) => !["REX_SERVER", "REX_SESSION", "REX_BLOCK", "REX_CLIENT", "REX_HOME"].includes(key),
      ),
    );
  }

  function run(args: readonly string[], input?: string): Promise<string> {
    const argv = [...prefix(), ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(command, argv, { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), CALL_TIMEOUT_MS);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (stdout.length < OPERATOR_TERMINAL_READ_MAX * 8) stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < 4096) stderr += chunk;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(
          error.code === "ENOENT"
            ? new RexError("Rex isn't installed on this Mac.", "missing")
            : new RexError(`Rex couldn't be run: ${error.message}`, "failed"),
        );
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve(stdout);
        const said = oneLine(stderr) ?? (signal === null ? `exit ${code}` : `stopped by ${signal}`);
        reject(
          code === 4
            ? new RexError("Rex isn't running on this Mac.", "not_running", 4)
            : new RexError(`Rex refused: ${said}`, "failed", code ?? undefined),
        );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    });
  }

  async function json(args: readonly string[], input?: string): Promise<unknown> {
    const out = await run(args, input);
    try {
      return JSON.parse(out) as unknown;
    } catch {
      throw new RexError("Rex answered with something that isn't JSON.", "failed");
    }
  }

  /** Refuses a server whose API revision range doesn't include the one this adapter speaks. */
  async function supported(): Promise<void> {
    const version = record(await json(["api", "call", "server.version"]));
    const revision = revisionOf(version?.api_revision);
    const minimum = revisionOf(version?.api_min_revision);
    if (minimum <= REX_API_REVISION && revision >= REX_API_REVISION) return;
    const named = text(version?.rex_version) ?? "unknown";
    throw new RexError(
      `Rex ${named.slice(0, 64)} on this Mac speaks API revisions ${minimum} to ${revision}; Clankie's Rex support is built for revision ${REX_API_REVISION}.`,
      "unsupported",
    );
  }

  function blockCall(target: Target, method: string, args?: unknown): Promise<unknown> {
    return json(
      [
        "block",
        "call",
        "-s",
        target.session,
        "-b",
        target.block,
        method,
        ...(args === undefined ? [] : ["-"]),
      ],
      args === undefined ? undefined : JSON.stringify(args),
    );
  }

  /** The block's root status record, if its program reports one Rex knows. */
  async function statusOf(target: Target): Promise<StatusRecord | undefined> {
    const records = record(await blockCall(target, "program_status"))?.records;
    if (!Array.isArray(records)) return undefined;
    const root = records.map(record).find((entry) => entry !== undefined && text(entry.id) === undefined);
    const state = text(root?.state);
    if (root === undefined || state === undefined || !STATES.has(state as RexState)) return undefined;
    const kind = text(root.kind);
    const app = text(root.app);
    const msg = statusMessage(root.msg);
    return {
      state: state as RexState,
      ...(kind === undefined ? {} : { kind }),
      ...(app === undefined ? {} : { app }),
      ...(msg === undefined ? {} : { msg }),
    };
  }

  /**
   * The live agent in a block now (ADR 0307): its program reports a status, and the process in
   * front isn't a shell, so an agent that exited back to its shell is gone even if its last
   * word stands. Its pid is part of who it is.
   */
  async function occupied(target: Target): Promise<Occupied | undefined> {
    const status = await statusOf(target);
    if (status === undefined) return undefined;
    const front = record(record(await blockCall(target, "process"))?.foreground);
    const pid = front?.pid;
    const name = text(front?.name);
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || name === undefined)
      return undefined;
    if (isShell({ name })) return undefined;
    const cwd = text(front?.cwd);
    return {
      record: status,
      foreground: name,
      ...(cwd === undefined ? {} : { cwd }),
      occupant: {
        pid,
        root: false,
        key: JSON.stringify([target.session, target.block, pid, status.app ?? name]),
      },
    };
  }

  async function guarded<T>(work: () => Promise<T>, unavailable: (detail: string, error?: RexError) => T) {
    try {
      await supported();
      return await work();
    } catch (error) {
      return unavailable(detailOf(error), error instanceof RexError ? error : undefined);
    }
  }

  return {
    async list() {
      try {
        await supported();
        const listed = record(await json(["ls", "--json"]))?.sessions;
        const sessions = (Array.isArray(listed) ? listed : []).map(record).slice(0, SESSION_MAX);
        const agents: RexAgent[] = [];
        for (const session of sessions) {
          const sessionId = text(session?.session_id);
          const sessionKey = sessionId?.match(/^session:([A-Za-z0-9][A-Za-z0-9-]{0,63})$/u)?.[1];
          if (sessionId === undefined || sessionKey === undefined) continue;
          const answer = await json(["block", "ls", "-s", sessionId, "--json"]);
          const blocks = Array.isArray(answer) ? answer : record(answer)?.blocks;
          for (const entry of (Array.isArray(blocks) ? blocks : []).map(record).slice(0, BLOCK_MAX)) {
            const blockId = text(entry?.block_id);
            const blockKey = blockId?.match(/^block:([A-Za-z0-9][A-Za-z0-9-]{0,63})$/u)?.[1];
            const creator = text(entry?.creator_name);
            if (blockId === undefined || blockKey === undefined) continue;
            if (creator !== undefined && creator !== TERMINAL_CREATOR) continue;
            const target = { session: sessionId, block: blockId };
            // allow-swallowed-rejection -- a block that won't answer is left out, not the whole list.
            const live = await occupied(target).catch(() => undefined);
            if (live === undefined) continue;
            const title = text(entry?.label) ?? text(session?.label);
            const harness = live.record.app ?? live.foreground;
            agents.push({
              block: `${sessionKey}/${blockKey}`,
              harness: harness.slice(0, 128),
              ...(title === undefined ? {} : { title: title.slice(0, 200) }),
              ...(live.cwd === undefined ? {} : { workingDirectory: fileUrlPath(live.cwd).slice(0, 4096) }),
              status: live.record.state,
              ...(live.record.msg === undefined ? {} : { doing: live.record.msg.slice(0, 512) }),
            });
          }
        }
        return { status: "listed", agents };
      } catch (error) {
        return {
          status: "unavailable",
          reason: error instanceof RexError ? error.reason : "failed",
          detail: detailOf(error),
        };
      }
    },

    async read(block) {
      const target = parse(block);
      return guarded<RexRead>(
        async () => {
          const live = await occupied(target);
          if (live === undefined) {
            scope.forget(block);
            return { status: "unavailable", detail: NO_AGENT };
          }
          const { occupant } = live;
          const changed = async () => (await occupied(target))?.occupant.key !== occupant.key;
          // Claude Code and Codex are read from their own session transcript, never their screen
          // (ADR 0307, #328): terminal text has no author per line. No certain session is a refusal.
          const harness = transcriptHarness(live.record.app);
          if (harness !== undefined) {
            const found = await nativeSessionForProcess(harness, occupant.pid, options.nativeSession);
            let entries: Awaited<ReturnType<typeof readProcessSession>> | undefined;
            try {
              entries = found === undefined ? undefined : await readProcessSession(harness, found);
            } finally {
              await found?.file.close();
            }
            if (await changed()) {
              scope.forget(block);
              return {
                status: "unavailable",
                detail: "The agent in that block changed while it was read; read it again.",
              };
            }
            if (found === undefined || entries === undefined)
              return { status: "unavailable", detail: TRANSCRIPT_READ_REFUSED };
            const birthOf = options.nativeSession?.birth ?? observeNativeBirth;
            if (!sameLifetime(await birthOf(occupant.pid), found.birth))
              return { status: "unavailable", detail: TRANSCRIPT_READ_REFUSED };
            const said = transcriptReadText(entries);
            const waiting =
              live.record.state === "blocked" ? transcriptWaiting(entries, undefined) : undefined;
            const whole = waiting === undefined ? said : `${said}\n\n${waiting}`;
            return { status: "read", text: capped(whole), detail: OWNER_AGENT_READ_DETAIL };
          }
          const history = withoutFinalNewline(
            await run(["capture", "-s", target.session, "-b", target.block, "--format", "text"]),
          );
          const screen = text(record(await blockCall(target, "format", { format: "text" }))?.content) ?? "";
          // Read only if the same agent held the block on both sides of the reads.
          if (await changed()) {
            scope.forget(block);
            return {
              status: "unavailable",
              detail: "The agent in that block changed while it was read; read it again.",
            };
          }
          const shown = scope.bound(block, occupant, history, withoutFinalNewline(screen));
          return {
            status: "read",
            text: capped(shown.text),
            ...(shown.detail === undefined ? {} : { detail: shown.detail }),
          };
        },
        (detail) => ({ status: "unavailable", detail }),
      );
    },

    async send(block, message) {
      const target = parse(block);
      return guarded<RexSent>(
        async () => {
          const live = await occupied(target);
          if (live === undefined) return { status: "not_delivered", detail: `${NO_AGENT} Nothing was sent.` };
          if (live.record.state === "blocked")
            return {
              status: "not_delivered",
              detail: `It is waiting on ${live.record.kind === undefined ? "a prompt" : `a ${live.record.kind} prompt`}, and text would answer it. Read it and press keys instead. Nothing was sent.`,
            };
          if (live.record.state === "error")
            return {
              status: "not_delivered",
              detail: "It reported an error and stopped. Read it before sending anything. Nothing was sent.",
            };
          const working = watchWorking(target);
          try {
            try {
              // One paste event, so a message with line breaks arrives whole rather than as Enters.
              await run(
                ["api", "call", "block.event", "-"],
                JSON.stringify({
                  session_id: target.session,
                  block_id: target.block,
                  event: { type: "paste", payload: { text: message } },
                }),
              );
            } catch (error) {
              // No other way in: a failed structured send is never retried as typing (ADR 0207).
              return {
                status: "not_delivered",
                detail: `Rex didn't take the message: ${detailOf(error)} Nothing was sent.`,
              };
            }
            try {
              await run(["send-key", "-s", target.session, "-b", target.block, "enter"]);
            } catch (error) {
              return {
                status: "unconfirmed",
                detail: `The text went in but Enter didn't (${detailOf(error)}). Read the agent before sending again.`,
              };
            }
            if (live.record.state === "working")
              return {
                status: "queued",
                detail: "It went in while the agent was working; it waits until this turn ends.",
              };
            if (await working.seen(confirmMs))
              return { status: "delivered", detail: "The agent took it and started working." };
            // The stream can miss a change it started after; ask once more.
            // allow-swallowed-rejection -- an unanswered last check leaves the send unconfirmed, as said below.
            const now = await statusOf(target).catch(() => undefined);
            return now?.state === "working"
              ? { status: "delivered", detail: "The agent took it and started working." }
              : {
                  status: "unconfirmed",
                  detail:
                    "It went in, but the agent wasn't seen starting work. Read it before sending again.",
                };
          } finally {
            working.stop();
          }
        },
        (detail) => ({ status: "not_delivered", detail: `${detail} Nothing was sent.` }),
      );
    },

    async keys(block, keys, current = () => true) {
      const target = parse(block);
      return guarded<KeyPressResult>(
        async () => {
          if ((await occupied(target)) === undefined) return { outcome: "unavailable", message: NO_AGENT };
          let pressed = 0;
          for (const key of keys) {
            if (!current())
              return pressed === 0
                ? { outcome: "refused", message: "Pressing keys was turned off. Nothing was pressed." }
                : {
                    outcome: "uncertain",
                    message: `Stopped after ${pressed} of ${keys.length} keys: pressing keys was turned off. Read the agent first.`,
                  };
            try {
              await run(["send-key", "-s", target.session, "-b", target.block, rexKey(key)]);
            } catch (error) {
              return pressed === 0 && error instanceof RexError && error.exitCode === 3
                ? { outcome: "unavailable", message: `Rex couldn't find that block. Nothing was pressed.` }
                : {
                    outcome: "uncertain",
                    message: `Some keys may have gone in (${detailOf(error)}). Read the agent first.`,
                  };
            }
            pressed += 1;
          }
          return { outcome: "pressed", message: `Pressed ${keys.join(", ")}.` };
        },
        (message) => ({ outcome: "unavailable", message }),
      );
    },

    async close(block) {
      const target = parse(block);
      return guarded<RexClosed>(
        async () => {
          const answer = await json(["block", "ls", "-s", target.session, "--json"]);
          const blocks =
            (Array.isArray(answer) ? answer : (record(answer)?.blocks as unknown[] | undefined)) ?? [];
          const entry = blocks.map(record).find((candidate) => text(candidate?.block_id) === target.block);
          if (entry === undefined) return { status: "unavailable", detail: "Rex has no such block now." };
          // Only a block Clankie started for a hire; whatever the owner runs in Rex is theirs.
          if (!(text(entry.label) ?? "").startsWith(REX_SEAT_LABEL_PREFIX))
            return {
              status: "refused",
              detail: "The owner started that Rex block, so it stays open. Nothing was closed.",
            };
          const live = await occupied(target);
          if (live?.record.state === "working" || live?.record.state === "blocked")
            return {
              status: "refused",
              detail: `Its agent is ${live.record.state === "working" ? "mid-turn" : "waiting on a prompt"}. Nothing was closed.`,
            };
          try {
            await run(["block", "close", "-s", target.session, target.block]);
          } catch (error) {
            return { status: "unavailable", detail: `Rex didn't close it: ${detailOf(error)}` };
          }
          return { status: "closed", detail: "Rex closed the block and the program in it." };
        },
        (detail) => ({ status: "unavailable", detail }),
      );
    },
  };

  /** Watches one session's event stream for this block's root status turning `working`. */
  function watchWorking(target: Target): { seen(ms: number): Promise<boolean>; stop(): void } {
    let child: ReturnType<typeof spawn> | undefined;
    let found = false;
    let wake: (() => void) | undefined;
    try {
      child = spawn(command, [...prefix(), "events", "-s", target.session, "--json"], {
        env: childEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.on("error", () => {});
      createInterface({ input: child.stdout! }).on("line", (line) => {
        if (workingEvent(line, target)) {
          found = true;
          wake?.();
        }
      });
    } catch {
      child = undefined;
    }
    return {
      seen: (ms) =>
        found
          ? Promise.resolve(true)
          : new Promise((resolve) => {
              const timer = setTimeout(() => resolve(found), ms);
              wake = () => {
                clearTimeout(timer);
                resolve(true);
              };
            }),
      stop: () => {
        child?.kill("SIGTERM");
      },
    };
  }
}

/** An event line saying this block's root status record is now `working`. */
function workingEvent(line: string, target: Target): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  const outer = record(parsed);
  if (outer?.type !== "session_event") return false;
  const session = record(outer.payload);
  if (session?.session_id !== target.session) return false;
  const event = record(session.event);
  if (event?.type !== "block_event") return false;
  const block = record(event.payload);
  if (block?.block_id !== target.block || block.name !== "program_status_changed") return false;
  const change = record(block.payload);
  return text(change?.id) === undefined && record(change?.record)?.state === "working";
}

/** A `REX_SERVER` value that names this Mac's own socket, or undefined for anything else. */
function localSocket(server: string): string | undefined {
  if (server.startsWith("unix://")) return server.length > "unix://".length ? server : undefined;
  if (server.startsWith("/")) return `unix://${server}`;
  return undefined;
}

/** Clankie's key names in Rex's key syntax (Rex writes escape in full). */
function rexKey(key: string): string {
  return key.replace(/(^|\+)esc$/u, "$1escape");
}

/** A public block id back into Rex's own ids. */
function parse(block: string): Target {
  const slash = block.indexOf("/");
  return { session: `session:${block.slice(0, slash)}`, block: `block:${block.slice(slash + 1)}` };
}

function transcriptHarness(app: string | undefined): "claude" | "codex" | undefined {
  return app === "claude-code" || app === "claude" ? "claude" : app === "codex" ? "codex" : undefined;
}

function revisionOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** A status message as one plain line: base64 UTF-8 per the protocol, else as it came. */
function statusMessage(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  let said = raw;
  if (/^[A-Za-z0-9+/]+={0,2}$/u.test(raw) && raw.length % 4 === 0) {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64") === raw) said = decoded;
  }
  // The protocol refuses a message with a control character; so does Clankie.
  return /\p{Cc}/u.test(said) ? undefined : said;
}

function fileUrlPath(value: string): string {
  if (!value.startsWith("file://")) return value;
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return value;
  }
}

function withoutFinalNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function capped(value: string): string {
  return value.length > OPERATOR_TERMINAL_READ_MAX ? value.slice(-OPERATOR_TERMINAL_READ_MAX) : value;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function oneLine(value: string): string | undefined {
  const line = value
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line?.slice(0, 300);
}

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 900);
}
