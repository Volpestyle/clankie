import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  claudeConfigRoots,
  resolveHerdrSeatTranscriptPathAsync,
  type HerdrAgentSession,
} from "@clankie/agent-transcript";
import { observeNativeBirth, type NativeBirth } from "../local-fleet-process.ts";

// An agent the owner started in a desktop-app terminal has no session Clankie named (#530).
// Its harness's own files say which session that exact process writes. Anything short of one
// certain answer is no answer, and the read is then refused, never taken from the screen.

const LSOF_MS = 5_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** A Codex rollout, as Codex lays out its sessions: `sessions/YYYY/MM/DD/rollout-<when>-<id>.jsonl`. */
const ROLLOUT =
  /[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-[^\\/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;

/** A file a process holds open, and whether it may write to it. */
interface OpenFile {
  readonly path: string;
  readonly writable: boolean;
}

export interface NativeSessionLookup {
  /** The process's kernel identity and birth; a pid whose lifetime changes is no longer the agent. */
  readonly birth?: (pid: number) => Promise<NativeBirth | undefined>;
  /** The files the process holds open. */
  readonly openFiles?: (pid: number) => Promise<readonly OpenFile[]>;
}

/** The session a live process writes, with the lifetime it was proved against. */
export interface ProcessSession {
  readonly session: HerdrAgentSession;
  readonly birth: NativeBirth;
}

/** The session a live Claude Code or Codex process is writing now, or undefined when it isn't certain. */
export async function nativeSessionForProcess(
  harness: "claude" | "codex",
  pid: number,
  lookup: NativeSessionLookup = {},
): Promise<ProcessSession | undefined> {
  const birthOf = lookup.birth ?? ((value: number) => observeNativeBirth(value));
  try {
    // The lifetime is fixed before anything is looked up; the caller checks it again after the read.
    const birth = await birthOf(pid);
    if (birth === undefined) return undefined;
    const found =
      harness === "claude"
        ? await claudeTranscript(pid, birth)
        : await codexTranscript(pid, lookup.openFiles ?? openFilesOf);
    if (found === undefined || !(await canonicalOwnFile(found.path))) return undefined;
    return { session: { source: `herdr:${harness}`, kind: "path", value: found.path }, birth };
  } catch {
    // allow-swallowed-rejection -- an unreadable harness file is no session; the read is refused.
    return undefined;
  }
}

/** Whether the process holds the same lifetime it was proved against: same birth and kernel identity. */
export function sameLifetime(now: NativeBirth | undefined, then: NativeBirth): boolean {
  return (
    now !== undefined &&
    now[0] === then[0] &&
    now[1] === then[1] &&
    now.kernelIdentity === then.kernelIdentity
  );
}

/** A regular file the owner owns, at its canonical path: no symlink anywhere along it, itself included. */
async function canonicalOwnFile(path: string): Promise<boolean> {
  if ((await realpath(path)) !== path) return false;
  const stats = await lstat(path);
  return stats.isFile() && stats.uid === process.getuid?.();
}

/**
 * Claude Code writes `sessions/<pid>.json` in its config home while it runs: its session id,
 * when it started (`startedAt`, ms since the epoch) and its process's start as `ps -o lstart`
 * prints it in UTC (`procStart`). The record is this lifetime's only if `procStart` is this
 * process's kernel birth in that form and `startedAt` is at or after that birth, which no earlier
 * process on the pid can be: it ended before this one was born. Claude holds no file open that
 * would tie the session to the process, so the record's session claim stands as its writer made
 * it; that writer is the owner's account (ADR 0307's accepted exception).
 */
async function claudeTranscript(pid: number, birth: NativeBirth): Promise<{ path: string } | undefined> {
  const bornMs = Number(birth[0]) * 1000 + Math.floor(Number(birth[1]) / 1000);
  const printed = utcLstart(Number(birth[0]));
  const found = new Set<string>();
  for (const root of claudeConfigRoots()) {
    let raw: string;
    try {
      raw = await readFile(join(root, "sessions", `${String(pid)}.json`), "utf8");
    } catch {
      continue;
    }
    const record = JSON.parse(raw) as {
      pid?: unknown;
      sessionId?: unknown;
      procStart?: unknown;
      startedAt?: unknown;
    };
    if (record.pid !== pid || typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId))
      continue;
    if (record.procStart !== printed) continue;
    if (
      typeof record.startedAt !== "number" ||
      !Number.isFinite(record.startedAt) ||
      record.startedAt < bornMs
    )
      continue;
    found.add(record.sessionId.toLowerCase());
  }
  // Two config homes naming different sessions for one process can't both be right.
  const only = found.size === 1 ? [...found][0] : undefined;
  if (only === undefined) return undefined;
  const path = await resolveHerdrSeatTranscriptPathAsync("claude", {
    source: "herdr:claude",
    kind: "id",
    value: only,
  });
  return path === undefined ? undefined : { path };
}

/**
 * Codex holds its session's rollout open for writing while it runs. Exactly one such rollout
 * names the session, and only if Codex's own lookup by that id finds that same file.
 */
async function codexTranscript(
  pid: number,
  openFiles: (pid: number) => Promise<readonly OpenFile[]>,
): Promise<{ path: string } | undefined> {
  const rollouts = new Map<string, string>();
  for (const file of await openFiles(pid)) {
    const id = file.writable ? ROLLOUT.exec(file.path)?.[1]?.toLowerCase() : undefined;
    if (id !== undefined) rollouts.set(id, file.path);
  }
  const only = rollouts.size === 1 ? [...rollouts][0] : undefined;
  if (only === undefined) return undefined;
  const [id, open] = only;
  const found = await resolveHerdrSeatTranscriptPathAsync("codex", {
    source: "herdr:codex",
    kind: "id",
    value: id,
  });
  return found === open ? { path: open } : undefined;
}

/** The files a process holds open and their access, as `lsof` reports them for that one pid. */
async function openFilesOf(pid: number): Promise<readonly OpenFile[]> {
  const { stdout } = await promisify(execFile)("lsof", ["-nP", "-a", "-p", String(pid), "-Fan"], {
    timeout: LSOF_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  const files: OpenFile[] = [];
  let access = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("f")) access = "";
    else if (line.startsWith("a")) access = line.slice(1);
    else if (line.startsWith("n/"))
      files.push({ path: line.slice(1), writable: access === "w" || access === "u" });
  }
  return files;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A start in seconds as `ps -o lstart` prints it in UTC (`Tue Nov  3 16:35:23 2026`). */
function utcLstart(seconds: number): string {
  const at = new Date(seconds * 1000);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${DAYS[at.getUTCDay()]} ${MONTHS[at.getUTCMonth()]} ${String(at.getUTCDate()).padStart(2, " ")} ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}:${two(at.getUTCSeconds())} ${at.getUTCFullYear()}`;
}
