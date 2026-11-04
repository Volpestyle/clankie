import type {
  AutoPlanCapacity,
  AutoProjectStaffing,
  AutoStaffingTotals,
  AutoWorkQueue,
  AutoRound,
  ProjectVelocity,
} from "@clankie/protocol/auto-rounds";
import type { ClankieSettings } from "@clankie/settings";
import type { Project } from "@clankie/protocol/projects";
import type { OperatorFleetSeat } from "@clankie/protocol";
import { usageWindowPace } from "@clankie/protocol/worker-accounts";
import { accountTier } from "./account-allocation.ts";
import { liveIssueHolders } from "../work-item-holders.ts";
import type { MachineWorkerAccounts } from "./harness-accounts.ts";

/** Preserve the actual observation and pace. Neither a reset timestamp nor an alias creates capacity. */
export function autoPlanCapacity(
  reports: readonly MachineWorkerAccounts[],
  now = Date.now(),
): AutoPlanCapacity[] {
  return reports.flatMap((report) =>
    report.accounts.map((account) => {
      const observedAt = account.usage?.observedAt ?? null;
      const observed = observedAt === null ? NaN : Date.parse(observedAt);
      const reportAt = Date.parse(report.observedAt);
      const fresh =
        Number.isFinite(observed) &&
        observed <= now &&
        now - observed <= 5 * 60_000 &&
        Number.isFinite(reportAt) &&
        reportAt <= now &&
        now - reportAt <= 5 * 60_000;
      const windows = (account.usage?.windows ?? []).map((window) => {
        const pace = usageWindowPace(window, Number.isFinite(observed) ? observed : now);
        return {
          id: window.id,
          left: 1 - window.usedPercent / 100,
          resetsAt: window.resetsAt ?? null,
          daysToReset:
            window.resetsAt && Number.isFinite(observed) && Number.isFinite(Date.parse(window.resetsAt))
              ? Math.max(0, (Date.parse(window.resetsAt) - observed) / 86400000)
              : null,
          burnPerDay: pace.burnPerDay ?? null,
          sparePerDay:
            window.resetsAt && Date.parse(window.resetsAt) > observed
              ? pace.left / Math.max(pace.daysToReset, 1 / 24) - (pace.burnPerDay ?? 0) / 100
              : null,
        };
      });
      const general = windows.filter((window) => !window.id.includes(":"));
      const state = account.held
        ? "held"
        : account.signedIn === false || !account.usable
          ? "unavailable"
          : !fresh ||
              account.signedIn !== true ||
              !general.length ||
              general.some((window) => window.sparePerDay === null)
            ? "unknown"
            : general.some((window) => window.left <= 0.1 || window.sparePerDay! <= 0)
              ? "reserve"
              : "headroom";
      return {
        machine: report.machine,
        harness: account.harness,
        label: account.accountKey ?? account.label,
        plan: accountTier(account) ?? null,
        observedAt,
        windows,
        state,
      };
    }),
  );
}

export interface StaffingSeat {
  readonly machine: string;
  readonly directory?: string | undefined;
  readonly status: string;
  /** The issue the seat holds now (#318), only when its key names one issue anywhere (#387). */
  readonly issue?: string;
}

/**
 * A key that names one tracker issue wherever it appears: `TEAM-n`, `LOCAL-TEAM-n` or
 * `owner/repo#n`. A bare `#n` names an issue only within its repo, so it never attributes.
 */
function unambiguousIssueKey(key: string): string | undefined {
  const trimmed = key.trim();
  if (/^(?:LOCAL-)?[A-Z][A-Z0-9]*-\d+$/iu.test(trimmed)) return trimmed.toUpperCase();
  const github = /^([\w.-]+\/[\w.-]+)#(\d+)$/u.exec(trimmed);
  return github ? `${github[1]!.toLowerCase()}#${github[2]!}` : undefined;
}

/** A project's issue keys, as `unambiguousIssueKey` normalizes them. */
export function projectIssueKeys(keys: Iterable<string>): Set<string> {
  return new Set([...keys].flatMap((key) => unambiguousIssueKey(key) ?? []));
}
/** Project machine IDs are routing IDs, never the census's display hostname. */
export function autoStaffingSeats(
  seats: readonly (Pick<
    OperatorFleetSeat,
    "seatId" | "occupantId" | "fleet" | "machine" | "workingDirectory" | "status"
  > &
    Partial<OperatorFleetSeat>)[],
  localFleets: readonly string[] = [],
  machineId: (id: string) => string = (id) => id,
): StaffingSeat[] {
  const seen = new Set<string>();
  return seats.flatMap((seat) => {
    const machine =
      !seat.fleet || seat.fleet === "default" || localFleets.includes(seat.fleet)
        ? "local"
        : machineId(seat.fleet);
    const key = JSON.stringify([machine, seat.occupantId ?? seat.seatId]);
    if (seen.has(key)) return [];
    seen.add(key);
    // liveIssueHolders reads only the optional assignment and report fields a census seat may lack.
    const held = liveIssueHolders([seat as OperatorFleetSeat])[0]?.itemId;
    const issue = held === undefined ? undefined : unambiguousIssueKey(held);
    return [{ machine, directory: seat.workingDirectory, status: seat.status, ...(issue ? { issue } : {}) }];
  });
}
/**
 * Measurement only: use the owner's registered machine IDs, never display hostnames.
 * One responding route covers a failed alias only for the very same remote Herdr session.
 * A different failed session on that PC remains an incomplete census. Nothing rebinds settings.
 */
export function autoStaffingCensus(
  seats: Parameters<typeof autoStaffingSeats>[0],
  settings: Pick<ClankieSettings, "machines" | "execution">,
  unavailableSources: ReadonlySet<string>,
  localFleets: readonly string[] = [],
) {
  const ids = new Map<string, string>();
  for (const machine of settings.machines)
    for (const id of [machine.id, ...machine.aliases]) ids.set(id, machine.id);
  for (const connection of settings.execution.connections)
    if (connection.machine !== undefined) ids.set(connection.id, connection.machine);
  const machineId = (id: string) =>
    id === "default" || localFleets.includes(id) ? "local" : (ids.get(id) ?? id);
  const failed = new Set(
    [...unavailableSources].filter((s) => s.startsWith("herdr:")).map((s) => s.slice(6)),
  );
  const healthy = settings.execution.connections.filter((c) => c.enabled !== false && !failed.has(c.id));
  const unavailableMachines = new Set<string>();
  for (const id of failed) {
    const connection = settings.execution.connections.find((c) => c.id === id);
    const covered =
      connection?.ssh !== undefined &&
      healthy.some(
        (c) => c.ssh !== undefined && machineId(c.id) === machineId(id) && c.session === connection.session,
      );
    if (!covered) unavailableMachines.add(machineId(id));
  }
  return {
    seats: autoStaffingSeats(
      seats.filter((seat) => !failed.has(seat.fleet ?? "default")),
      localFleets,
      machineId,
    ),
    unavailableMachines,
    machineId,
    project: (project: Project): Project => ({
      ...project,
      workspaces: project.workspaces.map((root) => ({ ...root, machineId: machineId(root.machineId) })),
      worktreeRoots: project.worktreeRoots.map((root) => ({ ...root, machineId: machineId(root.machineId) })),
    }),
    connection: (id: string) => healthy.find((c) => machineId(c.id) === machineId(id))?.id ?? id,
  };
}
const inside = (root: string, directory: string, windows: boolean) => {
  const clean = (value: string) => {
    const normalized = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return windows ? normalized.toLowerCase() : normalized;
  };
  const a = clean(root),
    b = clean(directory);
  return b === a || b.startsWith(`${a}/`);
};

/**
 * Shared attribution for each project, the prompt and aggregate census: seats in its
 * workspaces, and seats elsewhere holding one of its issues (#387), from `issueKeys`.
 */
export function projectStaffingSeats(
  project: Project,
  seats: readonly StaffingSeat[],
  issueKeys?: ReadonlySet<string>,
): StaffingSeat[] {
  const roots = [...project.workspaces, ...project.worktreeRoots];
  return seats.filter(
    (seat) =>
      (seat.issue !== undefined && issueKeys?.has(seat.issue) === true) ||
      (seat.directory !== undefined &&
        roots.some(
          (root) =>
            root.machineId === seat.machine &&
            inside(root.path, seat.directory!, root.platform === "windows"),
        )),
  );
}

/** A measured tick, not an agent's assessment. Missing sources stay unknown. This never hires or parks work. */
export function projectStaffing(input: {
  project: Project;
  queue: AutoWorkQueue;
  seats: readonly StaffingSeat[];
  plans: readonly AutoPlanCapacity[];
  started: ProjectVelocity["started"];
  previous?: AutoRound;
  unavailableMachines?: ReadonlySet<string>;
  /** The project's issue keys, so a seat on one of them in another repo counts (#387). */
  issueKeys?: ReadonlySet<string>;
}): AutoProjectStaffing {
  const { project, queue } = input;
  const roots = [...project.workspaces, ...project.worktreeRoots];
  const seats = projectStaffingSeats(project, input.seats, input.issueKeys);
  const censusKnown =
    !roots.some((root) => input.unavailableMachines?.has(root.machineId)) &&
    !seats.some((seat) => seat.status === "unknown");
  const activeSeats = seats.filter((seat) => seat.status === "working").length;
  const idleSeats = seats.filter((seat) => seat.status === "idle" || seat.status === "done").length;
  const occupiedSeats = seats.length;
  const machines = new Set(roots.map((root) => root.machineId));
  const policy = project.hiring;
  const pinnedModel = policy?.worker?.model;
  const modelExcluded =
    pinnedModel !== undefined &&
    (policy?.excludedModels?.includes(pinnedModel) ||
      (policy?.allowedModels !== undefined && !policy.allowedModels.includes(pinnedModel)));
  const noAllowedModel =
    policy?.allowedModels?.every((model) => policy.excludedModels?.includes(model)) === true;
  const plans = input.plans.filter((plan) => {
    const key = `${plan.harness}:${plan.plan}`;
    return (
      !modelExcluded &&
      !noAllowedModel &&
      machines.has(plan.machine) &&
      (!policy?.allowedPlans || policy.allowedPlans.includes(key)) &&
      !policy?.excludedPlans?.includes(key) &&
      (!policy?.worker?.harness || policy.worker.harness === plan.harness)
    );
  });
  const workerCap = project.workerCap ?? null;
  const wipCap = project.wipCap ?? null;
  const started = input.started.state === "known" ? input.started.total : null;
  const workerRoom =
    workerCap === null ? Infinity : occupiedSeats > workerCap ? 0 : workerCap - occupiedSeats + idleSeats;
  const wipRoom = wipCap === null ? Infinity : started === null ? null : Math.max(0, wipCap - started);
  const room = wipRoom === null ? null : Math.min(workerRoom, wipRoom);
  const spareSeats = room === null || !Number.isFinite(room) ? null : room;
  const headroom = plans.some((plan) => plan.state === "headroom");
  const reason = !censusKnown
    ? "unknown"
    : workerRoom <= 0 || wipRoom === 0
      ? "cap_reached"
      : queue.state === "unknown" || wipRoom === null
        ? "unknown"
        : !headroom
          ? plans.some((plan) => plan.state === "unknown") || !plans.length
            ? "unknown"
            : "plan_reserve"
          : queue.ready.length === 0
            ? "no_ready_work"
            : "capacity_available";
  const signal =
    reason === "capacity_available"
      ? "under_staffed"
      : censusKnown && headroom && queue.state === "known" && queue.ready.length === 0
        ? "backlog_not_ready"
        : null;
  const previous = input.previous?.projects.find((entry) => entry.projectId === project.id)?.staffing;
  const check: AutoProjectStaffing["check"] = previous?.signal
    ? {
        roundId: input.previous!.roundId,
        state:
          censusKnown && previous.activeSeats !== null && activeSeats > previous.activeSeats
            ? ("staffed" as const)
            : reason === "capacity_available"
              ? ("unresolved" as const)
              : reason,
      }
    : undefined;
  return {
    queue,
    activeSeats: censusKnown ? activeSeats : null,
    idleSeats: censusKnown ? idleSeats : null,
    occupiedSeats: censusKnown ? occupiedSeats : null,
    workerCap,
    wipCap,
    started,
    spareSeats: censusKnown ? spareSeats : null,
    plans,
    signal,
    reason,
    ...(check ? { check } : {}),
  };
}

export function staffingTotals(
  projects: readonly ProjectVelocity[],
  plans: readonly AutoPlanCapacity[],
  context?: {
    seats: readonly StaffingSeat[];
    projects: readonly Project[];
    issueKeys?: ReadonlyMap<string, ReadonlySet<string>>;
  },
): AutoStaffingTotals {
  const snapshots = projects.flatMap((project) => (project.staffing ? [project.staffing] : []));
  const sum = (
    field: "activeSeats" | "idleSeats" | "occupiedSeats" | "spareSeats" | "workerCap" | "wipCap" | "started",
  ) =>
    snapshots.length === projects.length && snapshots.every((s) => s[field] !== null)
      ? snapshots.reduce((total, s) => total + s[field]!, 0)
      : null;
  const coveredSeats = context?.seats.filter((seat) =>
    context.projects.some(
      (project) => projectStaffingSeats(project, [seat], context.issueKeys?.get(project.id)).length > 0,
    ),
  );
  const censusKnown = snapshots.every((s) => s.activeSeats !== null);
  return {
    readyIssues:
      snapshots.length === projects.length && snapshots.every((s) => s.queue.state === "known")
        ? snapshots.reduce((sum, s) => sum + (s.queue.state === "known" ? s.queue.ready.length : 0), 0)
        : null,
    activeSeats: !censusKnown
      ? null
      : coveredSeats
        ? coveredSeats.filter((s) => s.status === "working").length
        : sum("activeSeats"),
    idleSeats: !censusKnown
      ? null
      : coveredSeats
        ? coveredSeats.filter((s) => s.status === "idle" || s.status === "done").length
        : sum("idleSeats"),
    occupiedSeats: !censusKnown ? null : coveredSeats ? coveredSeats.length : sum("occupiedSeats"),
    spareSeats: sum("spareSeats"),
    workerCap: sum("workerCap"),
    wipCap: sum("wipCap"),
    started: sum("started"),
    plans: [...plans],
  };
}

export function staffingSignals(staffing: AutoProjectStaffing | undefined): string[] {
  return [
    ...(staffing?.signal ? [staffing.signal] : []),
    ...(staffing?.check?.state === "unresolved" ? ["staffing_unresolved"] : []),
  ];
}
export function staffingSection(projects: readonly ProjectVelocity[]): string[] {
  const rows = projects.flatMap((project) => {
    const s = project.staffing;
    if (!s) return [];
    return [
      `- ${project.name}: ready ${s.queue.state === "known" ? s.queue.ready.length : "unknown"}; active ${s.activeSeats ?? "unknown"}, idle ${s.idleSeats ?? "unknown"}, occupied ${s.occupiedSeats ?? "unknown"}, worker cap ${s.workerCap ?? "unset"}; started ${s.started ?? "unknown"}, WIP cap ${s.wipCap ?? "unset"}; ${s.signal ?? s.reason}.`,
      ...(s.signal === "under_staffed"
        ? [
            `  Staff ready work now within the caps, project policy, machine authority and fresh plan reserve. Reuse suitable idle owned seats or hire for independent results. Owner-blocked work does not block unrelated ready issues: ${s.queue.state === "known" ? s.queue.ready.join(", ") : "unknown"}.`,
          ]
        : []),
      ...(s.signal === "backlog_not_ready"
        ? [
            "  Plan backlog items into ready, independent issues in this round instead of idling. Record any genuine owner dependency against only the issues it blocks; continue unrelated work.",
          ]
        : []),
      ...(s.check
        ? [
            `  Previous staffing round ${s.check.roundId}: ${s.check.state}. The service checked active seats and current ready work, caps and plan reserve; unresolved needs correction this round.`,
          ]
        : []),
      ...(s.queue.state === "known"
        ? s.queue.blocked.map(
            (blocker) =>
              `  Blocked ${blocker.issue}: ${blocker.reason}; blocks ${blocker.blocks.join(", ") || "no linked issues"}.`,
          )
        : [`  Queue unknown: ${s.queue.reason}.`]),
    ];
  });
  return rows.length
    ? ["", "Fleet utilization (service measurement; correct unused capacity in this Auto round):", ...rows]
    : [];
}
