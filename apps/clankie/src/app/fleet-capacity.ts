import {
  FLEET_REVIEW_BUDGET,
  FleetCapacitySchema,
  FleetResourceSnapshotSchema,
  type FleetCapacity,
  type FleetCapacityBurn,
} from "@clankie/protocol";
import type { TrackerRequestBudgetReport } from "@clankie/protocol/tracker-request-budget";
import {
  UsageHistory,
  claudeAccountHomes,
  projectUsageBurn,
  readClaudeSessionBurn,
  type SessionBurn,
} from "./usage-burn.ts";

/** How long a successful account read is reused, matching the usage meter's cache. */
const ACCOUNT_CACHE_MS = 60_000;

interface AccountWindow {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly windowMinutes?: number | undefined;
  readonly resetsAt?: string | undefined;
}

/** The fields a worker-account reading may carry. Secret fields are accepted and dropped. */
export interface FleetCapacityAccountSource {
  readonly harness: string;
  readonly label: string;
  readonly home?: string | undefined;
  readonly homes?: readonly { readonly home: string }[] | undefined;
  readonly identity?: string | undefined;
  readonly accountKey?: string | undefined;
  readonly displayName?: string | undefined;
  readonly plan?: string | undefined;
  readonly tier?: string | undefined;
  readonly signedIn: boolean | null;
  readonly headroom: number | null;
  readonly resetsAt?: string | undefined;
  readonly usage?:
    | {
        readonly source: "claude-usage" | "codex-rate-limits";
        readonly observedAt: string;
        readonly windows: readonly AccountWindow[];
      }
    | undefined;
  readonly spend?:
    | {
        readonly today: { readonly costUsd: number; readonly tokens: number };
        readonly week: { readonly costUsd: number; readonly tokens: number };
      }
    | undefined;
  readonly sharesLimitsWith?: { readonly harness: "claude" | "codex"; readonly label: string } | undefined;
  readonly held?: { readonly reason?: string | undefined } | undefined;
  readonly usable: boolean;
  readonly reason?: string | undefined;
  readonly chatgptAccountId?: string | undefined;
}

export interface FleetCapacityMachineSource {
  readonly machine: string;
  readonly observedAt?: string | undefined;
  readonly accounts?: readonly FleetCapacityAccountSource[] | undefined;
  readonly unavailable?: Readonly<Partial<Record<string, string>>> | undefined;
  readonly allocation?:
    | {
        readonly accounts: readonly {
          readonly harness: string;
          readonly label: string;
          readonly sparePerDay: number | null;
          readonly resetsAt?: string | undefined;
        }[];
      }
    | undefined;
  /** The machine's account read did not answer. */
  readonly unread?: boolean | undefined;
}

export interface FleetCapacitySeatSource {
  readonly seatId: string;
  readonly occupantId?: string | undefined;
  readonly harness: string;
  readonly title: string;
  readonly machine?: string | undefined;
  readonly fleet?: string | undefined;
  readonly account?: { readonly label: string; readonly home?: string | undefined } | undefined;
  readonly owner?: { readonly hired: boolean } | undefined;
  readonly efficiency?:
    | { readonly contextTokens?: number | undefined; readonly contextPercent?: number | undefined }
    | undefined;
}

const text = (value: string | undefined, max: number): string | undefined =>
  value !== undefined && value.length > 0 && value.length <= max ? value : undefined;

const instant = (value: string | undefined): string | undefined => {
  if (value === undefined || !Number.isFinite(Date.parse(value))) return undefined;
  const parsed = new Date(value).toISOString();
  return parsed.endsWith("Z") ? parsed : undefined;
};

const fraction = (value: number | null | undefined): number | "unknown" =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : "unknown";

const percent = (value: number | undefined): number | "unknown" =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : "unknown";

const count = (value: number | undefined): number | "unknown" =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : "unknown";

const finite = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * The connector's capacity view. Copies only the fields a lead needs, and
 * writes "unknown" wherever the source has no number. Homes, emails, account
 * keys and credential material on the source are not read into the result.
 */
export function projectFleetCapacity(input: {
  readonly observedAt: string;
  readonly machines: readonly FleetCapacityMachineSource[];
  readonly seats: readonly FleetCapacitySeatSource[];
  readonly leadSeatId?: string;
  readonly heavy?: unknown;
  readonly tracker?: TrackerRequestBudgetReport;
  readonly burn?: readonly FleetCapacityBurn[];
  readonly burnNotices?: readonly string[];
}): FleetCapacity {
  const notices: string[] = [...(input.burnNotices ?? [])];
  const accounts = input.machines.flatMap((machine) => {
    if (machine.unread === true) {
      notices.push(`Accounts on ${machine.machine} couldn't be read.`);
      return [];
    }
    for (const [harness, reason] of Object.entries(machine.unavailable ?? {})) {
      if (reason !== undefined && reason.length > 0)
        notices.push(`${harness} on ${machine.machine}: ${reason}`.slice(0, 400));
    }
    return (machine.accounts ?? []).flatMap((account) => {
      const label = text(account.label, 128);
      const harness = text(account.harness, 32);
      if (label === undefined || harness === undefined) {
        notices.push(`An account on ${machine.machine} had no usable name.`);
        return [];
      }
      const spare = machine.allocation?.accounts.find(
        (entry) => entry.harness === account.harness && entry.label === account.label,
      );
      const usage = projectUsage(account);
      const spend = projectSpend(account);
      return [
        {
          machine: machine.machine.slice(0, 64),
          harness,
          account: label,
          plan: text(account.plan, 64) ?? "unknown",
          tier: text(account.tier, 64) ?? "unknown",
          signedIn: account.signedIn === null ? "unknown" : account.signedIn,
          usable: account.usable,
          held: account.held !== undefined,
          remaining: fraction(account.headroom),
          resetsAt: instant(account.resetsAt) ?? instant(spare?.resetsAt) ?? "unknown",
          sparePerDay: finite(spare?.sparePerDay ?? undefined) ?? "unknown",
          usage,
          spend,
          ...(account.sharesLimitsWith === undefined ||
          text(account.sharesLimitsWith.label, 128) === undefined
            ? {}
            : {
                sharesLimitsWith: {
                  harness: account.sharesLimitsWith.harness,
                  label: account.sharesLimitsWith.label,
                },
              }),
        },
      ];
    });
  });
  const panes = input.seats.flatMap((seat) => {
    const agent = text(seat.seatId, 256);
    const harness = text(seat.harness, 80);
    if (agent === undefined || harness === undefined) return [];
    const machine = text(seat.machine, 200) ?? text(seat.fleet, 200);
    const account = text(seat.account?.label, 64);
    const reviewBudgetTokens =
      input.leadSeatId !== undefined && seat.seatId === input.leadSeatId
        ? FLEET_REVIEW_BUDGET.lead
        : seat.owner?.hired === true
          ? FLEET_REVIEW_BUDGET.worker
          : "unknown";
    return [
      {
        agent,
        machine: machine ?? "unknown",
        harness,
        account: account ?? "unknown",
        title: seat.title.slice(0, 200),
        contextTokens: count(seat.efficiency?.contextTokens),
        contextPercentOfWindow: percent(seat.efficiency?.contextPercent),
        reviewBudgetTokens,
      },
    ];
  });
  if (accounts.length > 256) notices.push("Some accounts were left out because the list is full.");
  if (panes.length > 768) notices.push("Some panes were left out because the list is full.");
  return FleetCapacitySchema.parse({
    observedAt: input.observedAt,
    reviewBudgets: {
      leadTokens: FLEET_REVIEW_BUDGET.lead,
      workerTokens: FLEET_REVIEW_BUDGET.worker,
    },
    accounts: accounts.slice(0, 256),
    ...(input.burn === undefined ? {} : { burn: input.burn.slice(0, 64) }),
    panes: panes.slice(0, 768),
    heavy: projectHeavy(input.heavy),
    tracker: input.tracker === undefined ? "unknown" : projectTracker(input.tracker),
    notices: notices.slice(0, 32),
  });
}

function projectUsage(account: FleetCapacityAccountSource): FleetCapacity["accounts"][number]["usage"] {
  const usage = account.usage;
  const observedAt = instant(usage?.observedAt);
  if (
    usage === undefined ||
    observedAt === undefined ||
    (usage.source !== "claude-usage" && usage.source !== "codex-rate-limits")
  )
    return "unknown";
  const windows = usage.windows.flatMap((window) => {
    const id = text(window.id, 80);
    const label = text(window.label, 96);
    if (
      id === undefined ||
      label === undefined ||
      !Number.isFinite(window.usedPercent) ||
      window.usedPercent < 0 ||
      window.usedPercent > 100
    )
      return [];
    return [
      {
        id,
        label,
        usedPercent: window.usedPercent,
        resetsAt: instant(window.resetsAt) ?? "unknown",
      },
    ];
  });
  return { source: usage.source, observedAt, windows };
}

function projectSpend(account: FleetCapacityAccountSource): FleetCapacity["accounts"][number]["spend"] {
  const spend = account.spend;
  if (spend === undefined) return "unknown";
  const amounts = [spend.today.costUsd, spend.week.costUsd];
  const tokens = [spend.today.tokens, spend.week.tokens];
  if (amounts.some((value) => !Number.isFinite(value) || value < 0)) return "unknown";
  if (tokens.some((value) => !Number.isSafeInteger(value) || value < 0)) return "unknown";
  return {
    todayCostUsd: spend.today.costUsd,
    todayTokens: spend.today.tokens,
    weekCostUsd: spend.week.costUsd,
    weekTokens: spend.week.tokens,
  };
}

function projectHeavy(value: unknown): FleetCapacity["heavy"] {
  const parsed = FleetResourceSnapshotSchema.safeParse(value);
  if (!parsed.success) return "unknown";
  const snapshot = parsed.data;
  const lightSlots = snapshot.capacity.lightSlots;
  const lightUsed = snapshot.capacity.lightUsed;
  return {
    slots: snapshot.capacity.heavySlots,
    used: snapshot.capacity.used,
    remaining: snapshot.capacity.heavySlots - snapshot.capacity.used,
    queued: snapshot.queue.filter((entry) => entry.kind === "heavy").length,
    lightSlots: lightSlots === undefined ? "unknown" : lightSlots,
    lightUsed: lightUsed === undefined ? "unknown" : lightUsed,
    healthy: snapshot.pressure.healthy,
    loadRatio: snapshot.pressure.loadRatio,
    availableMemoryMb: snapshot.pressure.availableMemoryMb,
    pressureReason: snapshot.pressure.reason ?? "unknown",
  };
}

function projectTracker(report: TrackerRequestBudgetReport): FleetCapacity["tracker"] {
  const bucket = (entry: TrackerRequestBudgetReport["actors"][number]["interactive"]) => ({
    requests: entry.requests,
    requestLimit: entry.requestLimit,
    writes: entry.writes,
    writeLimit: entry.writeLimit,
    refusing: entry.retryAt !== undefined,
    ...(entry.retryAt === undefined ? {} : { retryAt: entry.retryAt }),
  });
  return {
    requestWindowMs: report.requestWindowMs,
    writeWindowMs: report.writeWindowMs,
    actors: report.actors.slice(0, 256).map((actor) => ({
      actor: (actor.name ?? actor.actorId).slice(0, 256),
      role: actor.role ?? "unknown",
      interactive: bucket(actor.interactive),
      background: bucket(actor.background),
    })),
  };
}

interface CapacityConnection {
  readonly id: string;
  readonly enabled: boolean;
  readonly ssh?: unknown;
  readonly socketPath?: string | undefined;
}

/**
 * Reads the accounts, live panes, heavy permits and tracker budgets Clankie
 * already keeps. Account reads are reused for a minute so a lead polling this
 * does not spawn every profile's CLI each time.
 */
export function createFleetCapacityReader(input: {
  readonly now?: () => number;
  readonly settings: () => Promise<{
    readonly execution: { readonly connections: readonly CapacityConnection[] };
  }>;
  readonly accounts: (fleetId?: string) => Promise<FleetCapacityMachineSource>;
  readonly seats: () => Promise<readonly FleetCapacitySeatSource[]>;
  readonly leadSeatId: () => string | undefined;
  readonly heavy: () => unknown;
  readonly tracker: () => TrackerRequestBudgetReport | undefined;
  /** Clankie's own usage readings; every account read here is recorded too. */
  readonly history?: UsageHistory;
  /** Reads local Claude session burn under these homes; defaults to the transcripts themselves. */
  readonly sessionBurn?: (
    homes: readonly string[],
    now: number,
  ) => Promise<{ sessions: SessionBurn[]; truncated: boolean }>;
}): () => Promise<FleetCapacity> {
  const now = input.now ?? Date.now;
  const history = input.history ?? new UsageHistory();
  const sessionBurn = input.sessionBurn ?? readClaudeSessionBurn;
  const cache = new Map<string, { at: number; report: FleetCapacityMachineSource }>();
  const readMachine = async (fleetId: string | undefined, machine: string) => {
    const key = fleetId ?? "local";
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < ACCOUNT_CACHE_MS) return { ...hit.report, machine };
    try {
      const report = await input.accounts(fleetId);
      const stored = { ...report, machine, unread: false as const };
      cache.set(key, { at: now(), report: stored });
      return stored;
    } catch {
      return { machine, unread: true as const };
    }
  };
  return async () => {
    const settings = await input.settings();
    const remotes = settings.execution.connections.filter(
      (connection) =>
        connection.enabled && connection.ssh !== undefined && connection.socketPath === undefined,
    );
    const [local, ...remote] = await Promise.all([
      readMachine(undefined, "local"),
      ...remotes.map((connection) => readMachine(connection.id, connection.id)),
    ]);
    const at = now();
    const observedAt = new Date(at).toISOString();
    const leadSeatId = input.leadSeatId();
    const tracker = input.tracker();
    const seats = await input.seats();
    const machines = [local, ...remote];
    const readable = machines.flatMap((machine) =>
      machine.unread === true ? [] : [{ machine: machine.machine, accounts: machine.accounts ?? [] }],
    );
    await history.record(readable.flatMap((machine) => machine.accounts)).catch(() => undefined);
    const localBurn = new Map<string, { sessions: SessionBurn[]; truncated: boolean }>();
    const burnNotices: string[] = [];
    for (const [label, homes] of claudeAccountHomes(local.unread === true ? [] : (local.accounts ?? []))) {
      try {
        localBurn.set(label, await sessionBurn(homes, at));
      } catch {
        burnNotices.push(`This Mac's Claude transcripts for ${label} couldn't be read.`);
      }
    }
    const burn = await projectUsageBurn({
      now: at,
      machines: readable,
      history,
      local: localBurn,
      seats: seats.flatMap((seat) =>
        seat.occupantId === undefined
          ? []
          : [{ seatId: seat.seatId, occupantId: seat.occupantId, title: seat.title }],
      ),
    });
    return projectFleetCapacity({
      observedAt,
      machines,
      seats,
      ...(leadSeatId === undefined ? {} : { leadSeatId }),
      heavy: input.heavy(),
      ...(tracker === undefined ? {} : { tracker }),
      burn: burn.burn,
      burnNotices: [...burnNotices, ...burn.notices],
    });
  };
}
