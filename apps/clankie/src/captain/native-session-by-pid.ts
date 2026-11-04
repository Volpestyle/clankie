import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import {
  claudeConfigRoots,
  parseHerdrSeatTranscript,
  resolveHerdrSeatTranscriptPathAsync,
  type HerdrTranscriptEntry,
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

/** A file a process holds open: whether it may write to it, and the file itself (device, inode). */
interface OpenFile {
  readonly path: string;
  readonly writable: boolean;
  readonly device?: number;
  readonly inode?: number;
}

/** A file by identity, whatever path names it. */
interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface NativeSessionLookup {
  /** The process's kernel identity and birth; a pid whose lifetime changes is no longer the agent. */
  readonly birth?: (pid: number) => Promise<NativeBirth | undefined>;
  /** The files the process holds open. */
  readonly openFiles?: (pid: number) => Promise<readonly OpenFile[]>;
  /** Opens the transcript to read, never following a symlink in its last part. */
  readonly open?: (path: string) => Promise<FileHandle>;
}

/**
 * The session a live process writes: the lifetime it was proved against, and its transcript held
 * open. Everything read comes through that handle, the file that passed the proof, whatever its
 * path names later. The caller closes it.
 */
export interface ProcessSession {
  readonly birth: NativeBirth;
  readonly file: FileHandle;
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
    if (found === undefined) return undefined;
    const file = await pinnedOpen(found, lookup.open ?? openNoFollow);
    return file === undefined ? undefined : { birth, file };
  } catch {
    // allow-swallowed-rejection -- an unreadable harness file is no session; the read is refused.
    return undefined;
  }
}

/** The session's entries, read whole through the handle that passed the proof. */
export async function readProcessSession(
  harness: "claude" | "codex",
  session: ProcessSession,
): Promise<HerdrTranscriptEntry[]> {
  return parseHerdrSeatTranscript(harness, await session.file.readFile("utf8"), true);
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

function openNoFollow(path: string): Promise<FileHandle> {
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
}

/**
 * The transcript opened once and pinned. The handle itself must be a regular file the owner owns,
 * and the very file a Codex process holds for writing when it named one. After the open, the path
 * must be canonical (no symlink anywhere along it, its root included) and still name that same
 * file: an ancestor swapped for the open, even one swapped back, leaves the handle on a file the
 * path doesn't name, and is refused.
 */
async function pinnedOpen(
  found: { readonly path: string; readonly held?: FileIdentity },
  openFile: (path: string) => Promise<FileHandle>,
): Promise<FileHandle | undefined> {
  const file = await openFile(found.path);
  try {
    const opened = await file.stat();
    const held =
      found.held === undefined || (opened.dev === found.held.device && opened.ino === found.held.inode);
    if (opened.isFile() && opened.uid === process.getuid?.() && held) {
      if ((await realpath(found.path)) === found.path) {
        const named = await lstat(found.path);
        if (named.dev === opened.dev && named.ino === opened.ino) return file;
      }
    }
  } catch {
    // allow-swallowed-rejection -- a file that can't be checked isn't the session's; closed below.
  }
  await file.close();
  return undefined;
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
  const roots = claudeConfigRoots();
  const found = new Set<string>();
  for (const root of roots) {
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
  // Only under one of Claude's own config homes, the ones the lookup searched.
  return path !== undefined && roots.some((root) => path.startsWith(join(root, "projects") + sep))
    ? { path }
    : undefined;
}

/**
 * Codex holds its session's rollout open for writing while it runs. Exactly one such rollout
 * names the session, and only if Codex's own lookup by that id finds that same path. The file
 * read must then be the one the process holds, by device and inode, not whatever the path names.
 */
async function codexTranscript(
  pid: number,
  openFiles: (pid: number) => Promise<readonly OpenFile[]>,
): Promise<{ path: string; held: FileIdentity } | undefined> {
  const rollouts = new Map<string, OpenFile>();
  for (const file of await openFiles(pid)) {
    const id = file.writable ? ROLLOUT.exec(file.path)?.[1]?.toLowerCase() : undefined;
    if (id !== undefined) rollouts.set(id, file);
  }
  const only = rollouts.size === 1 ? [...rollouts][0] : undefined;
  if (only === undefined) return undefined;
  const [id, { path, device, inode }] = only;
  if (device === undefined || inode === undefined) return undefined;
  const found = await resolveHerdrSeatTranscriptPathAsync("codex", {
    source: "herdr:codex",
    kind: "id",
    value: id,
  });
  return found === path ? { path, held: { device, inode } } : undefined;
}

/** The files a process holds open, their access and identity, as `lsof` reports them for one pid. */
async function openFilesOf(pid: number): Promise<readonly OpenFile[]> {
  const { stdout } = await promisify(execFile)("lsof", ["-nP", "-a", "-p", String(pid), "-FaDin"], {
    timeout: LSOF_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  const files: OpenFile[] = [];
  let access = "";
  let device: number | undefined;
  let inode: number | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("f")) [access, device, inode] = ["", undefined, undefined];
    else if (line.startsWith("a")) access = line.slice(1);
    // lsof prints the device in hex (`0x100000e`) and the inode in decimal.
    else if (line.startsWith("D")) device = Number(line.slice(1));
    else if (line.startsWith("i")) inode = Number(line.slice(1));
    else if (line.startsWith("n/"))
      files.push({
        path: line.slice(1),
        writable: access === "w" || access === "u",
        ...(device !== undefined && Number.isSafeInteger(device) ? { device } : {}),
        ...(inode !== undefined && Number.isSafeInteger(inode) ? { inode } : {}),
      });
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
