import { execFile } from "node:child_process";
import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { clankieStateHome } from "../src/state-home.ts";
import { updateHoldingServices } from "./runtime-updater.ts";
import {
  readRecordedServicePid,
  SERVICE_LOCK_BUSY,
  SERVICE_ORDER,
  serviceLogFile,
  serviceProcessIsAlive,
  withServiceLock,
  type ServiceId,
} from "./service-supervisor.ts";
import {
  managedService,
  resolveRestartTargets,
  restartTargetHoldingLock,
  type ServiceOutcome,
  type ServiceRegistryOptions,
} from "./services.ts";

/**
 * Crash recovery for launcher-owned services (ADR 0055, 2026-10-06).
 *
 * A start writes a pid record; only a deliberate stop removes it. A record whose
 * pid is dead is therefore a service that exited on its own, and the recovery
 * pass restarts it through the ordinary dependency-ordered restart. Restarting
 * after a crash never fights intent: an accepted update owns the process graph,
 * another launcher operation holds the service lock, and a deliberate stop has
 * already removed the record. A crash loop backs off and then gives up, leaving
 * the service stopped with a reason in `clankie status` and `clankie doctor`.
 */

/** Crashes inside this window count toward backoff and giving up. */
const CRASH_WINDOW_MS = 30 * 60_000;
/** Wait before restart attempt N (1-based) within the window. */
const RESTART_BACKOFF_MS = [0, 30_000, 2 * 60_000, 5 * 60_000] as const;
/** Crashes within the window after which recovery leaves the service stopped. */
export const GIVE_UP_AFTER = 5;
const LOG_TAIL_BYTES = 4_096;
const KEPT_CRASHES = 20;

interface CrashEntry {
  /** The dead process, or 0 for a recovery restart that failed before it was healthy. */
  readonly pid: number;
  readonly detectedAt: string;
  /** The last lines its log held when the crash was noticed. */
  readonly logTail: string;
  /** What recovery did about it. */
  readonly restart?: "restarted" | "failed" | "waiting" | "gave_up";
  readonly error?: string;
}

export interface RecoveryRecord {
  readonly version: 1;
  readonly id: ServiceId;
  readonly crashes: readonly CrashEntry[];
  /** Recovery stopped trying at this time; a deliberate start or restart clears it. */
  readonly gaveUpAt?: string;
  /** A recovery restart failed, so no pid record remains; keep retrying it. */
  readonly pending?: boolean;
  /** The give-up notice already went out. */
  readonly notifiedAt?: string;
  /** The owner's last deliberate start, restart or stop; crashes before it no longer count. */
  readonly resetAt?: string;
}

interface RecoveryAction {
  readonly id: ServiceId;
  readonly action: "restarted" | "failed" | "waiting" | "gave_up";
  readonly detectedAt: string;
  readonly retryAt?: string;
  readonly outcomes?: readonly ServiceOutcome[];
}

export interface RecoveryPass {
  readonly ok: true;
  readonly skipped?: "update" | "busy";
  readonly actions: readonly RecoveryAction[];
}

export interface RecoveryOptions {
  readonly now?: () => number;
  /** Test seam for the owner notice when recovery gives up. */
  readonly notify?: (text: string) => Promise<void>;
  /** Test seam for the update hold. */
  readonly updateHeld?: () => boolean;
  /** Test seam: restart in place of the supervisor's dependency-ordered restart. */
  readonly restart?: (id: ServiceId) => Promise<readonly ServiceOutcome[]>;
}

function recoveryDirectory(env: NodeJS.ProcessEnv): string {
  return join(clankieStateHome(env), "clankie");
}

export function recoveryRecordPath(id: ServiceId, env: NodeJS.ProcessEnv = process.env): string {
  return join(recoveryDirectory(env), `${id}-recovery.json`);
}

/** Written by the restarted service once it has told the owner, so the launcher never writes it twice. */
export function recoveryAlertedPath(id: ServiceId, env: NodeJS.ProcessEnv = process.env): string {
  return join(recoveryDirectory(env), `${id}-recovery-alerted.json`);
}

export function readRecoveryRecord(id: ServiceId, env: NodeJS.ProcessEnv = process.env): RecoveryRecord {
  try {
    const value = JSON.parse(readFileSync(recoveryRecordPath(id, env), "utf8")) as Partial<RecoveryRecord>;
    if (value.version === 1 && value.id === id && Array.isArray(value.crashes))
      return value as RecoveryRecord;
  } catch {
    // Missing or damaged: no crash history.
  }
  return { version: 1, id, crashes: [] };
}

function writeRecoveryRecord(record: RecoveryRecord, env: NodeJS.ProcessEnv): void {
  const path = recoveryRecordPath(record.id, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Consumed by the rename.
    }
  }
}

/**
 * A deliberate start, restart or stop is the owner's intent: it ends backoff
 * and a give-up. The crash history stays for `status` and the boot alert.
 */
export function clearRecoveryIntent(ids: readonly ServiceId[], env: NodeJS.ProcessEnv = process.env): void {
  for (const id of ids) {
    const record = readRecoveryRecord(id, env);
    if (record.crashes.length === 0) continue;
    const { gaveUpAt: _gaveUp, pending: _pending, notifiedAt: _notified, ...rest } = record;
    writeRecoveryRecord({ ...rest, resetAt: new Date().toISOString() }, env);
  }
}

function logTail(id: ServiceId, env: NodeJS.ProcessEnv): string {
  try {
    const fd = openSync(serviceLogFile(id, env), "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const lines = buffer.toString("utf8").split("\n");
      // The first line is usually cut mid-way; keep whole lines only.
      return (size > length ? lines.slice(1) : lines).join("\n").trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** One plain line that names the failure, for an owner notice. */
function crashSummary(tail: string): string {
  const lines = tail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const named =
    lines.find((line) => /^(?:[A-Z][A-Za-z]*Error|Error)\b|Unhandled|FATAL|panic/u.test(line)) ??
    lines.findLast((line) => /exit (?:status|code)/iu.test(line)) ??
    lines.at(-1) ??
    "no log output";
  return named.length > 240 ? `${named.slice(0, 237)}…` : named;
}

/** Crashes whose clock started after the owner's last deliberate action. */
function windowed(record: RecoveryRecord, now: number): readonly CrashEntry[] {
  const reset = Date.parse(record.resetAt ?? "") || 0;
  return record.crashes.filter((crash) => {
    const at = Date.parse(crash.detectedAt);
    return at > reset && now - at <= CRASH_WINDOW_MS;
  });
}

function macNotify(text: string): Promise<void> {
  if (process.platform !== "darwin") return Promise.resolve();
  const script = `display notification ${JSON.stringify(text)} with title "Clankie stopped"`;
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 5_000 }, () => resolve());
  });
}

/**
 * One recovery pass: restart every launcher-owned service whose recorded
 * process died, oldest dependency first. Never waits for the service lock —
 * an owner or update operation in progress owns the graph this tick.
 */
export async function recoverServices(
  registry: ServiceRegistryOptions,
  options: RecoveryOptions = {},
): Promise<RecoveryPass> {
  const env = registry.env ?? process.env;
  const now = options.now ?? Date.now;
  if ((options.updateHeld ?? (() => updateHoldingServices(env) !== undefined))()) {
    return { ok: true, skipped: "update", actions: [] };
  }
  const result = await withServiceLock(env, async () => await recoveryPass(registry, env, now, options), {
    wait: false,
  });
  if (result === SERVICE_LOCK_BUSY) return { ok: true, skipped: "busy", actions: [] };
  return result;
}

async function recoveryPass(
  registry: ServiceRegistryOptions,
  env: NodeJS.ProcessEnv,
  now: () => number,
  options: RecoveryOptions,
): Promise<RecoveryPass> {
  const actions: RecoveryAction[] = [];
  const covered = new Set<ServiceId>();
  for (const id of SERVICE_ORDER) {
    if (covered.has(id)) continue;
    if (managedService(id).enabled?.(env) === false) continue;
    const pid = readRecordedServicePid(id, env);
    const record = readRecoveryRecord(id, env);
    const died = pid !== undefined && !serviceProcessIsAlive(pid);
    if (!died && record.pending !== true) continue;
    // A pending retry with a live record means something else already started it.
    if (!died && pid !== undefined) continue;
    if (record.gaveUpAt !== undefined) continue;

    const at = now();
    const detectedAt = new Date(at).toISOString();
    const last = record.crashes.at(-1);
    const fresh = died && last?.pid !== pid;
    let crashes = fresh
      ? [...record.crashes, { pid: pid!, detectedAt, logTail: logTail(id, env) }]
      : [...record.crashes];
    const recent = windowed({ ...record, crashes }, at);

    if (recent.length >= GIVE_UP_AFTER) {
      crashes = mark(crashes, "gave_up");
      const text =
        `${managedService(id).label} crashed ${recent.length} times in ${CRASH_WINDOW_MS / 60_000} minutes ` +
        `and was left stopped. Last error: ${crashSummary(crashes.at(-1)?.logTail ?? "")}. ` +
        "Run `clankie status`, then `clankie restart`.";
      const notifiedAt = record.notifiedAt ?? detectedAt;
      writeRecoveryRecord(
        {
          ...record,
          crashes: crashes.slice(-KEPT_CRASHES),
          gaveUpAt: detectedAt,
          notifiedAt,
          pending: false,
        },
        env,
      );
      if (record.notifiedAt === undefined) await (options.notify ?? macNotify)(text).catch(() => undefined);
      actions.push({ id, action: "gave_up", detectedAt });
      continue;
    }

    const wait = RESTART_BACKOFF_MS[Math.min(recent.length, RESTART_BACKOFF_MS.length) - 1] ?? 0;
    const since = at - Date.parse(crashes.at(-1)?.detectedAt ?? detectedAt);
    if (since < wait) {
      writeRecoveryRecord({ ...record, crashes: mark(crashes, "waiting").slice(-KEPT_CRASHES) }, env);
      actions.push({
        id,
        action: "waiting",
        detectedAt,
        retryAt: new Date(at + (wait - since)).toISOString(),
      });
      continue;
    }

    const targets = resolveRestartTargets(id);
    for (const target of targets) covered.add(target);
    let outcomes: readonly ServiceOutcome[];
    try {
      outcomes = await (
        options.restart ??
        ((target: ServiceId) =>
          restartTargetHoldingLock(target, {
            ...registry,
            // The restarted service tells the owner what happened (once), through
            // its own runtime-health alert path.
            env: { ...env, CLANKIE_CRASH_REPORT: recoveryRecordPath(target, env) },
          }))
      )(id);
    } catch (error) {
      outcomes = [
        {
          id,
          label: managedService(id).label,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      ];
    }
    const ok = outcomes.length > 0 && outcomes.every((outcome) => outcome.ok);
    const error = outcomes.find((outcome) => !outcome.ok)?.error;
    crashes = mark(crashes, ok ? "restarted" : "failed", error);
    if (!ok) {
      // A restart that died before it was healthy removed its own pid record;
      // count it as another crash so the loop still backs off and gives up.
      crashes = [
        ...crashes,
        {
          pid: 0,
          detectedAt: new Date(now()).toISOString(),
          logTail: logTail(id, env),
          restart: "failed",
          ...(error === undefined ? {} : { error }),
        },
      ];
    }
    writeRecoveryRecord({ ...record, crashes: crashes.slice(-KEPT_CRASHES), pending: !ok }, env);
    actions.push({ id, action: ok ? "restarted" : "failed", detectedAt, outcomes });
  }
  return { ok: true, actions };
}

function mark(
  crashes: readonly CrashEntry[],
  restart: NonNullable<CrashEntry["restart"]>,
  error?: string,
): CrashEntry[] {
  const last = crashes.at(-1);
  if (last === undefined) return [...crashes];
  return [
    ...crashes.slice(0, -1),
    { ...last, restart, ...(error === undefined ? {} : { error: error.slice(0, 512) }) },
  ];
}

export interface ServiceRecoverySummary {
  readonly id: ServiceId;
  readonly state: "gave_up" | "retrying" | "recovered";
  readonly crashes: number;
  readonly lastCrashAt: string;
  readonly lastError: string;
}

/** What `status` and `doctor` show: services that crashed in the last day or are left stopped. */
export function summarizeRecovery(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): readonly ServiceRecoverySummary[] {
  const summaries: ServiceRecoverySummary[] = [];
  for (const id of SERVICE_ORDER) {
    const record = readRecoveryRecord(id, env);
    const last = record.crashes.at(-1);
    if (last === undefined) continue;
    const recentDay = record.crashes.filter(
      (crash) => now - Date.parse(crash.detectedAt) <= 24 * 60 * 60_000,
    );
    if (record.gaveUpAt === undefined && recentDay.length === 0) continue;
    summaries.push({
      id,
      state: record.gaveUpAt !== undefined ? "gave_up" : record.pending === true ? "retrying" : "recovered",
      crashes: recentDay.length,
      lastCrashAt: last.detectedAt,
      lastError: crashSummary(last.logTail),
    });
  }
  return summaries;
}
