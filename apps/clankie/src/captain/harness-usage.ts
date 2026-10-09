import type { AccountUsage, UsageWindow } from "@clankie/protocol/worker-accounts";

/**
 * Usage windows from what each harness reports about its own account
 * (VUH-1961). Claude's come from the profile's `claude -p /usage` lines, which
 * Claude Code answers locally (no model turn) from the same data as its
 * `/usage` screen; Codex's come from `account/rateLimits/read`. Clankie never
 * sees either harness's credentials.
 */

/** The oldest Claude Code verified to answer `-p /usage` as a local command (2026-10-09). */
export const CLAUDE_USAGE_MIN_VERSION = "2.1.295";
/** The probe compares `major * 1e6 + minor * 1e3 + patch`. */
export const CLAUDE_USAGE_MIN_VERSION_NUMBER = 2_001_295;

export interface ClaudeUsageLine {
  readonly label: string;
  readonly usedPercent: number;
  readonly resets?: string | undefined;
}

export interface CodexUsageWindow {
  readonly used_percent?: number | undefined;
  readonly window_minutes?: number | undefined;
  readonly resets_at?: number | null | undefined;
}

/** `Current week (all models): 50% used · resets Oct 13 at 8pm (America/Chicago)`, one per line. */
export function claudeUsageLines(lines: readonly string[]): ClaudeUsageLine[] {
  return lines.flatMap((line) => {
    const match =
      /^\s*(Current [^:]{1,80}):\s*(\d{1,3}(?:\.\d+)?)% used(?:\s*\S\s*resets\s+(.{1,80}?))?\s*$/u.exec(line);
    return match ? [{ label: match[1]!, usedPercent: Number(match[2]), resets: match[3] }] : [];
  });
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
function zoneOffset(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  return (
    Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) -
    Math.floor(instant / 1000) * 1000
  );
}

function wallClock(year: number, month: number, day: number, minutes: number, timeZone: string): number {
  const local = Date.UTC(year, month, day, 0, minutes);
  let instant = local - zoneOffset(local, timeZone);
  instant = local - zoneOffset(instant, timeZone);
  return instant;
}

/**
 * Claude's reset phrase, e.g. `Oct 9 at 1:50pm (America/Chicago)` or
 * `6am (America/Chicago)`, as an instant. Claude names no year, so the next
 * occurrence after `now` (allowing a minute of rounding) is the one meant.
 * Anything else is unknown.
 */
function claudeResetAt(text: string, now: number): string | undefined {
  const match =
    /^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:,\s*\d{4})?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([A-Za-z_+\-/0-9]{1,64})\)$/iu.exec(
      text.trim(),
    );
  if (!match) return undefined;
  const [, monthName, dayText, hourText, minuteText, meridiem, timeZone] = match;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timeZone! });
  } catch {
    return undefined;
  }
  const hour = Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  if (hour < 1 || hour > 12 || minute > 59) return undefined;
  const minutes = ((hour % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0)) * 60 + minute;
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone!,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  })
    .formatToParts(now)
    .reduce<Record<string, number>>((all, part) => ({ ...all, [part.type]: Number(part.value) }), {});
  const earliest = now - 60_000;
  if (monthName === undefined) {
    for (let offset = 0; offset < 2; offset += 1) {
      const instant = wallClock(today.year!, today.month! - 1, today.day! + offset, minutes, timeZone!);
      if (instant >= earliest) return new Date(instant).toISOString();
    }
    return undefined;
  }
  const month = MONTHS.indexOf(monthName.toLowerCase());
  const day = Number(dayText);
  if (month < 0 || day < 1 || day > 31) return undefined;
  for (const year of [today.year!, today.year! + 1]) {
    const instant = wallClock(year, month, day, minutes, timeZone!);
    if (instant >= earliest) return new Date(instant).toISOString();
  }
  return undefined;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 64) || "scoped"
  );
}

/** Claude's `/usage` lines as windows; unrecognised lines are left out rather than guessed. */
export function claudeUsageWindows(lines: readonly ClaudeUsageLine[], now: number): UsageWindow[] {
  const windows: UsageWindow[] = [];
  for (const line of lines) {
    const label = line.label.trim();
    let id: string;
    let windowMinutes: number | undefined;
    if (/^current session$/iu.test(label)) {
      id = "session";
      windowMinutes = 300;
    } else {
      const week = /^current week(?:\s*\(([^)]{1,64})\))?$/iu.exec(label);
      if (!week) continue;
      id = week[1] === undefined || /^all models$/iu.test(week[1]) ? "week" : `week:${slug(week[1])}`;
      windowMinutes = 10_080;
    }
    if (windows.some((window) => window.id === id)) continue;
    const resetsAt = line.resets === undefined ? undefined : claudeResetAt(line.resets, now);
    windows.push({
      id,
      label,
      usedPercent: Math.max(0, Math.min(100, line.usedPercent)),
      windowMinutes,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  return windows;
}

function codexWindow(
  window: CodexUsageWindow | null | undefined,
  scope: string | undefined,
  name: string | undefined,
): UsageWindow | undefined {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent))
    return undefined;
  const minutes =
    typeof window.window_minutes === "number" &&
    Number.isInteger(window.window_minutes) &&
    window.window_minutes > 0
      ? window.window_minutes
      : undefined;
  const short = minutes !== undefined && minutes <= 300;
  const base = short ? "session" : "week";
  const kind = short ? `${Math.round((minutes ?? 300) / 60)}h limit` : "Weekly limit";
  const resetsAt =
    typeof window.resets_at === "number" && Number.isFinite(window.resets_at)
      ? new Date(window.resets_at * 1000).toISOString()
      : undefined;
  return {
    id: scope === undefined ? base : `${base}:${slug(scope)}`,
    label: name === undefined ? kind : `${kind} (${name.slice(0, 64)})`,
    usedPercent: Math.max(0, Math.min(100, window.used_percent)),
    ...(minutes === undefined ? {} : { windowMinutes: minutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/** Codex's all-model windows, then any model-scoped limits it reports beside them. */
export function codexUsageWindows(
  limits: { primary?: CodexUsageWindow | null; secondary?: CodexUsageWindow | null } | undefined,
  scoped: readonly {
    id: string;
    name?: string | null | undefined;
    primary?: CodexUsageWindow | null;
    secondary?: CodexUsageWindow | null;
  }[] = [],
): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const add = (window: UsageWindow | undefined) => {
    if (window && !windows.some((entry) => entry.id === window.id)) windows.push(window);
  };
  add(codexWindow(limits?.primary, undefined, undefined));
  add(codexWindow(limits?.secondary, undefined, undefined));
  for (const limit of scoped) {
    add(codexWindow(limit.primary, limit.id, limit.name ?? limit.id));
    add(codexWindow(limit.secondary, limit.id, limit.name ?? limit.id));
  }
  return windows;
}

/**
 * Remaining fraction of the tightest all-model window; model-scoped windows
 * do not bound every hire. Null when none was reported. Passed resets count
 * as restored.
 */
export function usageHeadroom(usage: AccountUsage | undefined, now: number): number | null {
  const general = (usage?.windows ?? []).filter((window) => !window.id.includes(":"));
  if (!general.length) return null;
  return Math.min(
    ...general.map((window) =>
      window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now ? 1 : 1 - window.usedPercent / 100,
    ),
  );
}

/** When an exhausted account can work again: its latest exhausted all-model reset. */
export function exhaustedUntil(usage: AccountUsage | undefined, now: number): string | undefined {
  const resets = (usage?.windows ?? [])
    .filter(
      (window) => !window.id.includes(":") && window.usedPercent >= 100 && window.resetsAt !== undefined,
    )
    .map((window) => Date.parse(window.resetsAt!))
    .filter((value) => value > now);
  return resets.length ? new Date(Math.max(...resets)).toISOString() : undefined;
}
