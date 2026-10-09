import type {
  AccountAllocation,
  AllocationRecommendation,
  MachineAllocation,
  UsageWindow,
} from "@clankie/protocol/worker-accounts";
import type { MachineWorkerAccounts, WorkerAccountStatus } from "./harness-accounts.ts";

/**
 * How Clankie spreads hires over one machine's Claude and Codex accounts
 * (VUH-1974). Usage alone misleads: 16% left of a Max 20x week is more than
 * all of a 5x week, and 30% left with a day to go is spent by a pace that 30%
 * left with six days to go is not. So each eligible account is ranked by its
 * spare capacity per day:
 *
 *   planWeight × min over all-model windows of (left / days to reset − used per day)
 *
 * High spare is capacity that goes unused at reset unless someone hires on it;
 * negative spare is an account on pace to run out before its reset. Pace is
 * the window's own average (percent used over the time it has run), measured
 * once 5% of the window has passed; earlier it is unknown and counts as none.
 * A window with no reported reset counts as a whole window away. Model-scoped
 * windows bound only hires on that model, so they are named, and warned on,
 * but never rank. Unknown usage ranks after every known reading and an
 * unreported plan tier counts as the base plan; neither is guessed.
 */

const DAY_MS = 86_400_000;
/** Pace is unknown until this share of a window has passed. */
const PACE_MIN_ELAPSED = 0.05;
const PACE_MIN_ELAPSED_MS = 3_600_000;

/** Plan size against each harness's base paid plan. */
const PLAN_WEIGHTS: Record<"claude" | "codex", Record<string, number>> = {
  claude: { pro: 0.2, max_5x: 1, max_20x: 4 },
  codex: { plus: 1, pro: 6 },
};
const PLAN_NAMES: Record<string, string> = {
  pro: "Pro",
  max_5x: "Max 5x",
  max_20x: "Max 20x",
  plus: "Plus",
};

/** The plan tier an account reports, normalised to a `PLAN_WEIGHTS` key when known. */
export function accountTier(
  account: Pick<WorkerAccountStatus, "harness" | "plan" | "tier">,
): string | undefined {
  if (account.harness === "claude") {
    const reported = account.tier ?? "";
    const match =
      /max_20x|max_5x/u.exec(reported)?.[0] ?? (/(^|_)pro($|_)/u.test(reported) ? "pro" : undefined);
    // `subscriptionType: max` does not say which Max.
    return match ?? (account.plan === "pro" ? "pro" : undefined);
  }
  return account.plan;
}

function planWeight(account: WorkerAccountStatus): number | null {
  if (account.harness !== "claude" && account.harness !== "codex") return null;
  const tier = accountTier(account);
  return tier === undefined ? null : (PLAN_WEIGHTS[account.harness][tier] ?? null);
}

interface WindowPace {
  readonly window: UsageWindow;
  readonly left: number;
  readonly daysToReset: number;
  readonly burnPerDay?: number;
  readonly runsOutAt?: number;
  readonly resetsAt?: number;
}

function pace(window: UsageWindow, now: number): WindowPace {
  const reset = window.resetsAt === undefined ? undefined : Date.parse(window.resetsAt);
  const lengthMs = (window.windowMinutes ?? 10_080) * 60_000;
  if (reset !== undefined && reset <= now) return { window, left: 1, daysToReset: lengthMs / DAY_MS };
  const left = 1 - window.usedPercent / 100;
  const remainingMs = reset === undefined ? lengthMs : reset - now;
  const elapsedMs = reset === undefined || window.windowMinutes === undefined ? 0 : lengthMs - remainingMs;
  if (elapsedMs < Math.max(PACE_MIN_ELAPSED_MS, lengthMs * PACE_MIN_ELAPSED))
    return {
      window,
      left,
      daysToReset: remainingMs / DAY_MS,
      ...(reset === undefined ? {} : { resetsAt: reset }),
    };
  const perMs = window.usedPercent / elapsedMs;
  const outMs = perMs > 0 ? (100 - window.usedPercent) / perMs : Infinity;
  return {
    window,
    left,
    daysToReset: remainingMs / DAY_MS,
    burnPerDay: perMs * DAY_MS,
    resetsAt: reset!,
    ...(outMs < remainingMs ? { runsOutAt: now + outMs } : {}),
  };
}

function spare(entry: WindowPace): number {
  return entry.left / Math.max(entry.daysToReset, 1 / 24) - (entry.burnPerDay ?? 0) / 100;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const days = (ms: number) => {
  const hours = ms / 3_600_000;
  return hours < 36 ? `${Math.max(1, Math.round(hours))}h` : `${(hours / 24).toFixed(1)} days`;
};
function windowName(window: UsageWindow): string {
  if (window.id === "session") return "session";
  if (window.id === "week") return "week";
  return window.label;
}

function describe(account: WorkerAccountStatus, tier: string | undefined, weight: number | null): string {
  const plan = tier === undefined ? undefined : (PLAN_NAMES[tier] ?? tier);
  return `${account.label} (${plan ?? (weight === null ? "plan size unknown" : (account.plan ?? "plan"))})`;
}

/** Every Claude and Codex account on the machine, ranked per harness. */
export function allocateAccounts(report: MachineWorkerAccounts, now = Date.now()): MachineAllocation {
  const accounts: AccountAllocation[] = [];
  const recommendations: AllocationRecommendation[] = [];
  for (const harness of ["claude", "codex"] as const) {
    const scored = report.accounts
      .filter((account) => account.harness === harness)
      .map((account, index) => {
        const tier = accountTier(account);
        const weight = planWeight(account);
        const windows = (account.usage?.windows ?? []).map((window) => pace(window, now));
        const general = windows.filter((entry) => !entry.window.id.includes(":"));
        const binding = general.length ? general.reduce((a, b) => (spare(b) < spare(a) ? b : a)) : undefined;
        const sparePerDay = binding === undefined ? null : (weight ?? 1) * spare(binding);
        const remaining = general.length ? Math.min(...general.map((entry) => entry.left)) : null;
        const runsOut = windows
          .filter((entry) => entry.runsOutAt !== undefined)
          .map((entry) => ({
            window: entry.window.id,
            label: entry.window.label,
            at: new Date(entry.runsOutAt!).toISOString(),
            resetsAt: new Date(entry.resetsAt!).toISOString(),
          }));
        const eligible = account.usable && !account.held;
        const name = describe(account, tier, weight);
        let reason: string;
        if (account.held)
          reason = `${account.label}: set aside by the owner${account.held.reason ? ` (${account.held.reason})` : ""}`;
        else if (!account.usable) reason = `${account.label}: ${account.reason ?? "cannot take work"}`;
        else if (binding === undefined)
          reason = `${name}: usage not reported, so it ranks after accounts with a reading`;
        else {
          const out = binding.runsOutAt;
          reason =
            `${name}: ${percent(binding.left)} of its ${windowName(binding.window)} left, ` +
            `${binding.resetsAt === undefined ? "reset unknown" : `${days(binding.resetsAt - now)} to reset`}` +
            (out !== undefined
              ? `; at ${Math.round(binding.burnPerDay!)}%/day it runs out in ${days(out - now)}, ${days(binding.resetsAt! - out)} before it resets`
              : "");
        }
        const scoped = windows.filter(
          (entry) => entry.window.id.includes(":") && (entry.runsOutAt !== undefined || entry.left <= 0.1),
        );
        if (eligible && scoped.length)
          reason += `; ${scoped
            .map(
              (entry) =>
                `${entry.window.label} ${percent(1 - entry.left)} used${entry.runsOutAt === undefined ? "" : `, out in ${days(entry.runsOutAt - now)}`}`,
            )
            .join("; ")} (only hires on that model)`;
        return {
          index,
          entry: {
            harness,
            label: account.label,
            planWeight: weight,
            ...(tier === undefined ? {} : { tier }),
            eligible,
            remaining,
            sparePerDay,
            ...(binding === undefined ? {} : { window: binding.window.id }),
            ...(binding?.burnPerDay === undefined
              ? {}
              : { burnPerDay: Math.round(binding.burnPerDay * 10) / 10 }),
            ...(binding?.resetsAt === undefined
              ? {}
              : { resetsAt: new Date(binding.resetsAt).toISOString() }),
            ...(runsOut.length ? { runsOut } : {}),
            reason: reason.slice(0, 400),
          } satisfies AccountAllocation,
        };
      });
    const ranked = scored
      .filter((item) => item.entry.eligible)
      .sort(
        (a, b) =>
          (a.entry.sparePerDay === null ? 1 : 0) - (b.entry.sparePerDay === null ? 1 : 0) ||
          (b.entry.sparePerDay ?? 0) - (a.entry.sparePerDay ?? 0) ||
          a.index - b.index,
      );
    ranked.forEach((item, position) => Object.assign(item.entry, { rank: position + 1 }));
    accounts.push(...scored.map((item) => item.entry));
    if (!scored.length) continue;
    const noun = harness === "claude" ? "Claude" : "Codex";
    const first = ranked[0]?.entry;
    const others = ranked
      .slice(1)
      .filter((item) => item.entry.runsOut?.some((out) => !out.window.includes(":")))
      .map((item) => item.entry.reason);
    recommendations.push(
      first === undefined
        ? {
            harness,
            reason:
              `No ${noun} account can take a hire on its own: ${scored.map((item) => item.entry.reason).join("; ")}`.slice(
                0,
                600,
              ),
          }
        : {
            harness,
            label: first.label,
            reason:
              `next ${noun} hire → ${first.reason}${others.length ? `. Meanwhile ${others.join("; ")}` : ""}`.slice(
                0,
                600,
              ),
          },
    );
  }
  return { accounts, recommendations };
}

/** The ranked accounts of one harness, best first, from a report's allocation or computed now. */
export function rankedAccounts(
  report: MachineWorkerAccounts,
  harness: "claude" | "codex",
  now = Date.now(),
): readonly AccountAllocation[] {
  const allocation = report.allocation ?? allocateAccounts(report, now);
  return allocation.accounts
    .filter((entry) => entry.harness === harness && entry.rank !== undefined)
    .sort((a, b) => a.rank! - b.rank!);
}

export interface RunOutWarning {
  /** Stable for one window's one reset, so it is told once. */
  readonly key: string;
  readonly text: string;
}

/**
 * Weekly windows on pace to run out at least `hours` before they reset, each
 * once per reset. The text names the account, the window, when, and where the
 * next hires should go instead. Nothing is moved or stopped.
 */
export function runOutWarnings(
  report: MachineWorkerAccounts,
  settings: { readonly runOutWarning: boolean; readonly runOutWarningHours: number },
  now = Date.now(),
): RunOutWarning[] {
  if (!settings.runOutWarning) return [];
  const allocation = report.allocation ?? allocateAccounts(report, now);
  const warnings: RunOutWarning[] = [];
  for (const entry of allocation.accounts) {
    const account = report.accounts.find((a) => a.harness === entry.harness && a.label === entry.label);
    if (!account || account.held || account.signedIn !== true) continue;
    for (const out of entry.runsOut ?? []) {
      const window = account.usage?.windows.find((w) => w.id === out.window);
      if (!window || (window.windowMinutes ?? 0) < 1440) continue;
      if (Date.parse(out.resetsAt) - Date.parse(out.at) < settings.runOutWarningHours * 3_600_000) continue;
      const noun = entry.harness === "claude" ? "Claude" : "Codex";
      const next = allocation.recommendations.find((r) => r.harness === entry.harness);
      const elsewhere =
        next?.label !== undefined && next.label !== entry.label
          ? `Put the next ${noun} hires on ${next.label}`
          : `No other ${noun} account has more room; prefer the other harness for the next hires`;
      const scoped = out.window.includes(":") ? ` Only hires on that model draw on this limit.` : "";
      warnings.push({
        key: `${report.machine}:${entry.harness}:${entry.label}:${out.window}:${out.resetsAt}`,
        text:
          `Usage warning: ${noun} account ${entry.label}${account.identity ? ` (${account.identity})` : ""} on ${report.machine} ` +
          `is on pace to run out of ${out.label} around ${out.at}, ${days(Date.parse(out.resetsAt) - Date.parse(out.at))} before it resets at ${out.resetsAt} ` +
          `(${Math.round(window.usedPercent)}% used).${scoped} ${elsewhere}, and hand long-running seats on ${entry.label} off at their next checkpoint. ` +
          "Nothing was moved or stopped; live seats stay where they are unless you move them.",
      });
    }
  }
  return warnings;
}
