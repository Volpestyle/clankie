import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * After launcher crash recovery restarts this service (ADR 0055, 2026-10-06),
 * `CLANKIE_CRASH_REPORT` names the launcher's recovery record. Tell the owner
 * once, through the runtime-health alert path, then mark what was told beside
 * the record — the launcher never writes that file, so the two cannot race.
 */
interface CrashEntry {
  readonly detectedAt: string;
  readonly logTail?: string;
}

const MAX_RECORD_BYTES = 256 * 1024;

function crashAlertText(
  record: { readonly id?: unknown; readonly crashes?: unknown },
  alertedThrough: string | undefined,
): { readonly text: string; readonly through: string } | undefined {
  if (!Array.isArray(record.crashes)) return undefined;
  const crashes = (record.crashes as CrashEntry[]).filter(
    (crash) =>
      typeof crash?.detectedAt === "string" &&
      (alertedThrough === undefined || crash.detectedAt > alertedThrough),
  );
  const last = crashes.at(-1);
  if (last === undefined) return undefined;
  const lines = (last.logTail ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const named =
    lines.find((line) => /^(?:[A-Z][A-Za-z]*Error|Error)\b|Unhandled|FATAL|panic/u.test(line)) ??
    lines.at(-1) ??
    "no log output";
  const error = named.length > 240 ? `${named.slice(0, 237)}…` : named;
  const service = typeof record.id === "string" ? record.id : "A service";
  const count = crashes.length === 1 ? "crashed" : `crashed ${String(crashes.length)} times`;
  return {
    text: `${service} ${count} and the launcher restarted it (last at ${last.detectedAt}). Last error: ${error}. \`clankie status\` shows the history.`,
    through: last.detectedAt,
  };
}

export async function alertRecoveredCrash(
  reportPath: string | undefined,
  notify: (text: string) => Promise<boolean>,
): Promise<boolean> {
  if (reportPath === undefined || !reportPath.endsWith("-recovery.json")) return false;
  const alertedPath = reportPath.replace(/-recovery\.json$/u, "-recovery-alerted.json");
  let record: { readonly id?: unknown; readonly crashes?: unknown };
  let through: string | undefined;
  try {
    const raw = readFileSync(reportPath, "utf8");
    if (raw.length > MAX_RECORD_BYTES) return false;
    record = JSON.parse(raw) as typeof record;
  } catch {
    return false;
  }
  try {
    const marker = JSON.parse(readFileSync(alertedPath, "utf8")) as { through?: unknown };
    through = typeof marker.through === "string" ? marker.through : undefined;
  } catch {
    through = undefined;
  }
  const alert = crashAlertText(record, through);
  if (alert === undefined) return false;
  // Mark first: a notice that fails to send is not resent on every later boot.
  const temporary = `${alertedPath}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ through: alert.through })}\n`, { mode: 0o600 });
  renameSync(temporary, alertedPath);
  return await notify(alert.text).catch(() => false);
}
