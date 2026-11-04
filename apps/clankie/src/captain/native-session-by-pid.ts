import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
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

export interface NativeSessionLookup {
  /** The process's kernel birth, so a file left by an earlier process on a reused pid is refused. */
  readonly birth?: (pid: number) => Promise<NativeBirth | undefined>;
  /** Paths of the files the process holds open. */
  readonly openFiles?: (pid: number) => Promise<readonly string[]>;
}

/** The session a live Claude Code or Codex process is writing now, or undefined when it isn't certain. */
export async function nativeSessionForProcess(
  harness: "claude" | "codex",
  pid: number,
  lookup: NativeSessionLookup = {},
): Promise<HerdrAgentSession | undefined> {
  try {
    return harness === "claude"
      ? await claudeSession(pid, lookup.birth ?? ((value) => observeNativeBirth(value)))
      : await codexSession(pid, lookup.openFiles ?? openFilesOf);
  } catch {
    // allow-swallowed-rejection -- an unreadable harness file is no session; the read is refused.
    return undefined;
  }
}

/**
 * Claude Code writes `sessions/<pid>.json` in its config home while it runs, with the session
 * id and its process's start (`procStart`, as `ps -o lstart` prints it). The file names this
 * process only if that start is this pid's kernel birth, to the second.
 */
async function claudeSession(
  pid: number,
  birth: (pid: number) => Promise<NativeBirth | undefined>,
): Promise<HerdrAgentSession | undefined> {
  const born = await birth(pid);
  if (born === undefined) return undefined;
  const bornSecond = Number(born[0]);
  const found = new Set<string>();
  for (const root of claudeConfigRoots()) {
    let raw: string;
    try {
      raw = await readFile(join(root, "sessions", `${String(pid)}.json`), "utf8");
    } catch {
      continue;
    }
    const record = JSON.parse(raw) as { pid?: unknown; sessionId?: unknown; procStart?: unknown };
    if (record.pid !== pid || typeof record.sessionId !== "string" || !SESSION_ID.test(record.sessionId))
      continue;
    const started = typeof record.procStart === "string" ? Date.parse(record.procStart) : Number.NaN;
    if (!Number.isFinite(started) || Math.floor(started / 1000) !== bornSecond) continue;
    found.add(record.sessionId.toLowerCase());
  }
  // Two config homes naming different sessions for one process can't both be right.
  if (found.size !== 1) return undefined;
  return { source: "herdr:claude", kind: "id", value: [...found][0]! };
}

/**
 * Codex holds its session's rollout open while it runs. Exactly one open rollout names the
 * session, and only if Codex's own lookup by that id finds that same file in its homes.
 */
async function codexSession(
  pid: number,
  openFiles: (pid: number) => Promise<readonly string[]>,
): Promise<HerdrAgentSession | undefined> {
  const rollouts = new Map<string, string>();
  for (const path of await openFiles(pid)) {
    const id = ROLLOUT.exec(path)?.[1]?.toLowerCase();
    if (id !== undefined) rollouts.set(id, path);
  }
  const only = rollouts.size === 1 ? [...rollouts][0] : undefined;
  if (only === undefined) return undefined;
  const [id, open] = only;
  const session: HerdrAgentSession = { source: "herdr:codex", kind: "id", value: id };
  const found = await resolveHerdrSeatTranscriptPathAsync("codex", session);
  if (found === undefined || (await realpath(found)) !== (await realpath(open))) return undefined;
  return session;
}

/** The files a process holds open, as `lsof` names them for that one pid. */
async function openFilesOf(pid: number): Promise<readonly string[]> {
  const { stdout } = await promisify(execFile)("lsof", ["-nP", "-a", "-p", String(pid), "-Fn"], {
    timeout: LSOF_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => (line.startsWith("n/") ? [line.slice(1)] : []));
}
