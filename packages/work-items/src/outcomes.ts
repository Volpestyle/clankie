import { linearRow, type LinearQuery, type LinearRecord } from "./linear-import.ts";

/**
 * Tracker-side outcome facts for an Auto round (ADR 0270): what closed, what is
 * started now, which milestones finished, which status updates were posted, and
 * optionally each issue's state history. Read-only; classification is the caller's.
 */
export interface OutcomeWindow {
  /** Inclusive ISO instant. */
  readonly since: string;
  /** Exclusive ISO instant. */
  readonly until: string;
}
export interface OutcomeState {
  readonly name: string;
  /** Linear's state type: backlog, unstarted, started, completed, canceled, duplicate, triage. */
  readonly type: string;
}
export interface OutcomeIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly state: OutcomeState;
  readonly completedAt: string | null;
  readonly parent: { readonly id: string; readonly identifier: string } | null;
  readonly hasChildren: boolean;
  readonly milestoneId: string | null;
}
export interface OutcomeMilestone {
  readonly id: string;
  readonly name: string;
  /** Issues that count toward completion: canceled and duplicate issues do not. */
  readonly issues: number;
  readonly done: number;
  readonly complete: boolean;
  /** The last counted issue's completion, when complete. */
  readonly completedAt: string | null;
}
export interface OutcomeStatusUpdate {
  readonly id: string;
  readonly createdAt: string;
  readonly url: string | null;
  readonly health: string | null;
}
export interface OutcomeStateSpan {
  readonly state: OutcomeState;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
export interface OutcomeHistory {
  readonly id: string;
  readonly identifier: string;
  readonly spans: readonly OutcomeStateSpan[];
}
export interface TrackerOutcomes {
  readonly tracker: "linear" | "built-in";
  readonly projectId: string;
  readonly window: OutcomeWindow;
  readonly readAt: string;
  /** Issues now in a completed state whose completion falls inside the window. */
  readonly closed: readonly OutcomeIssue[];
  /** Started-state issues now. */
  readonly started: {
    readonly total: number;
    readonly byState: Readonly<Record<string, number>>;
    readonly issues: readonly OutcomeIssue[];
  };
  readonly milestones: readonly OutcomeMilestone[];
  /** Project status updates created inside the window. */
  readonly statusUpdates: readonly OutcomeStatusUpdate[];
  /**
   * State spans, when requested: every issue that changed since the window began
   * and every issue started now. Any other issue held its current state throughout.
   */
  readonly history?: readonly OutcomeHistory[];
  /** What this read cannot see, so a caller never mistakes a gap for a zero. */
  readonly caveats: readonly string[];
}

const NOT_COUNTED = new Set(["canceled", "duplicate"]);
const inWindow = (at: string | null, window: OutcomeWindow) =>
  at !== null && Date.parse(at) >= Date.parse(window.since) && Date.parse(at) < Date.parse(window.until);

/** The shared projection: the same rules whichever tracker supplied the issues. */
export function summarizeOutcomes(input: {
  tracker: TrackerOutcomes["tracker"];
  projectId: string;
  window: OutcomeWindow;
  readAt: string;
  issues: readonly OutcomeIssue[];
  milestones: readonly { id: string; name: string }[];
  /** Every issue in each milestone, by `milestoneId`. */
  milestoneIssues: readonly OutcomeIssue[];
  statusUpdates: readonly OutcomeStatusUpdate[];
  history?: readonly OutcomeHistory[];
  caveats: readonly string[];
  /** Reconstruct issue states from history at this instant, for a read-only replay. */
  asOf?: string;
}): TrackerOutcomes {
  if (input.asOf !== undefined && input.history === undefined) throw new Error("Replay needs state history");
  const projectAt = (issues: readonly OutcomeIssue[]) =>
    input.asOf === undefined
      ? issues
      : issues.flatMap((issue) => {
          const history = input.history?.find((entry) => entry.id === issue.id);
          if (history === undefined) return [issue]; // Unchanged since the read window began.
          const at = Date.parse(input.asOf!);
          const span = history.spans.find(
            (span) =>
              Date.parse(span.startedAt) <= at && (span.endedAt === null || at < Date.parse(span.endedAt)),
          );
          return span === undefined
            ? []
            : [
                {
                  ...issue,
                  state: span.state,
                  completedAt: span.state.type === "completed" ? span.startedAt : null,
                },
              ];
        });
  const issues = projectAt(input.issues);
  const milestoneIssues = projectAt(input.milestoneIssues);
  const started = issues.filter((issue) => issue.state.type === "started");
  const byState: Record<string, number> = {};
  for (const issue of started) byState[issue.state.name] = (byState[issue.state.name] ?? 0) + 1;
  const byIdentifier = (a: OutcomeIssue, b: OutcomeIssue) =>
    a.identifier.localeCompare(b.identifier, "en", { numeric: true });
  return {
    tracker: input.tracker,
    projectId: input.projectId,
    window: input.window,
    readAt: input.readAt,
    closed: issues
      .filter((issue) => issue.state.type === "completed" && inWindow(issue.completedAt, input.window))
      .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!) || byIdentifier(a, b)),
    started: { total: started.length, byState, issues: started.sort(byIdentifier) },
    milestones: input.milestones.map((milestone) => {
      const counted = milestoneIssues.filter(
        (issue) => issue.milestoneId === milestone.id && !NOT_COUNTED.has(issue.state.type),
      );
      const done = counted.filter((issue) => issue.state.type === "completed");
      const complete = counted.length > 0 && done.length === counted.length;
      return {
        id: milestone.id,
        name: milestone.name,
        issues: counted.length,
        done: done.length,
        complete,
        completedAt: complete
          ? done.map((issue) => issue.completedAt ?? "").reduce((a, b) => (a > b ? a : b)) || null
          : null,
      };
    }),
    statusUpdates: input.statusUpdates
      .filter((update) => inWindow(update.createdAt, input.window))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    ...(input.history === undefined ? {} : { history: input.history }),
    caveats: [
      ...input.caveats,
      ...(input.asOf === undefined
        ? []
        : ["Replay uses historical state spans; project, parent and milestone membership are current."]),
    ],
  };
}

const STATE = "state { name type }";
const SPAN = `startedAt endedAt ${STATE}`;
const OUTCOME_ISSUE = `id identifier title updatedAt completedAt ${STATE} parent { id identifier } children(first:1) { nodes { id } } projectMilestone { id }`;
const WITH_HISTORY = `${OUTCOME_ISSUE} stateHistory(first:25) { nodes { ${SPAN} } pageInfo { hasNextPage } }`;

function outcomeState(value: unknown): OutcomeState {
  const state = linearRow(value);
  return { name: String(state.name), type: String(state.type) };
}
function outcomeSpans(records: readonly Record<string, unknown>[]): OutcomeStateSpan[] {
  return records
    .map((span) => ({
      state: outcomeState(span.state),
      startedAt: String(span.startedAt),
      endedAt: typeof span.endedAt === "string" ? span.endedAt : null,
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
const date = (value: string) => JSON.stringify(new Date(value).toISOString());

/**
 * Every page of one connection under `owner(id)`, with literal `args` (filters,
 * ordering). `stop` ends early once a page shows the rest is out of range.
 */
async function pageConnection(
  query: LinearQuery,
  owner: string,
  id: string,
  field: string,
  args: string,
  fields: string,
  size: number,
  stop?: (nodes: readonly LinearRecord[]) => boolean,
): Promise<LinearRecord[]> {
  const records: LinearRecord[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  for (;;) {
    const data = await query(
      `query($id:String!, $after:String) { ${owner}(id:$id) { ${field}(first:${size}, after:$after${args}) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } } }`,
      { id, after },
    );
    const connection = linearRow(linearRow(data[owner])[field]);
    if (!Array.isArray(connection.nodes)) throw new Error(`Missing Linear ${owner}.${field} connection`);
    const nodes = connection.nodes as LinearRecord[];
    records.push(...nodes);
    const info = linearRow(connection.pageInfo);
    if (info.hasNextPage !== true || stop?.(nodes)) return records;
    if (typeof info.endCursor !== "string" || seen.has(info.endCursor))
      throw new Error("Nonadvancing Linear cursor");
    seen.add(info.endCursor);
    after = info.endCursor;
  }
}

function outcomeIssue(record: LinearRecord, history?: OutcomeHistory): OutcomeIssue {
  const parent = linearRow(record.parent);
  const last = history?.spans.at(-1);
  return {
    id: record.id,
    identifier: String(record.identifier),
    title: String(record.title),
    state: outcomeState(record.state),
    // Linear stamps completedAt apart from the state change (seconds to minutes); history is the transition.
    completedAt:
      last?.state.type === "completed" && last.endedAt === null
        ? last.startedAt
        : typeof record.completedAt === "string"
          ? record.completedAt
          : null,
    parent: typeof parent.id === "string" ? { id: parent.id, identifier: String(parent.identifier) } : null,
    hasChildren: ((linearRow(record.children).nodes ?? []) as unknown[]).length > 0,
    milestoneId: (linearRow(record.projectMilestone).id as string | undefined) ?? null,
  };
}

/**
 * One connected Linear project's outcomes, read through the caller's `query`
 * (the service passes its background-priority connected session). Reads are
 * bounded by server-side filters: completions in the window, started issues,
 * milestones with their issue states, and status updates back to the window.
 * With `history`, it also reads the state spans of every issue that changed
 * since the window began, plus those started now; an issue untouched since then
 * kept its current state throughout.
 */
export async function collectLinearOutcomes(input: {
  projectId: string;
  query: LinearQuery;
  window: OutcomeWindow;
  history?: boolean;
  now?: () => Date;
  asOf?: string;
}): Promise<TrackerOutcomes> {
  const { projectId, query, window } = input;
  const issuePage = (filter: string, fields: string) =>
    pageConnection(
      query,
      "project",
      projectId,
      "issues",
      `, includeArchived:true, filter:${filter}`,
      fields,
      50,
    );
  const started = await issuePage(
    `{ state: { type: { eq: "started" } } }`,
    input.history ? WITH_HISTORY : OUTCOME_ISSUE,
  );
  const changed = input.history
    ? await issuePage(`{ updatedAt: { gte: ${date(window.since)} } }`, WITH_HISTORY)
    : await issuePage(
        `{ state: { type: { eq: "completed" } }, completedAt: { gte: ${date(window.since)}, lt: ${date(window.until)} } }`,
        OUTCOME_ISSUE,
      );
  const records = [...new Map([...started, ...changed].map((record) => [record.id, record])).values()];
  let history: OutcomeHistory[] | undefined;
  if (input.history) {
    history = [];
    for (const record of records) {
      const connection = linearRow(record.stateHistory);
      const spans =
        linearRow(connection.pageInfo).hasNextPage === true
          ? await pageConnection(query, "issue", record.id, "stateHistory", "", SPAN, 50)
          : ((connection.nodes ?? []) as Record<string, unknown>[]);
      history.push({ id: record.id, identifier: String(record.identifier), spans: outcomeSpans(spans) });
    }
  }
  const issues = records.map((record) =>
    outcomeIssue(
      record,
      history?.find((entry) => entry.id === record.id),
    ),
  );

  const milestoneIssues: OutcomeIssue[] = [];
  const milestones = await pageConnection(
    query,
    "project",
    projectId,
    "projectMilestones",
    "",
    "id name issues(first:50) { nodes { id state { name type } completedAt } pageInfo { hasNextPage } }",
    25,
  );
  for (const milestone of milestones) {
    const connection = linearRow(milestone.issues);
    const members =
      linearRow(connection.pageInfo).hasNextPage === true
        ? await pageConnection(
            query,
            "projectMilestone",
            milestone.id,
            "issues",
            "",
            "id state { name type } completedAt",
            100,
          )
        : ((connection.nodes ?? []) as LinearRecord[]);
    for (const member of members)
      milestoneIssues.push({
        id: member.id,
        identifier: "",
        title: "",
        state: outcomeState(member.state),
        completedAt:
          issues.find((issue) => issue.id === member.id)?.completedAt ??
          (typeof member.completedAt === "string" ? member.completedAt : null),
        parent: null,
        hasChildren: false,
        milestoneId: milestone.id,
      });
  }
  const updates = await pageConnection(
    query,
    "project",
    projectId,
    "projectUpdates",
    ", orderBy: createdAt",
    "id createdAt url health",
    50,
    // Newest first: stop once a page reaches back past the window.
    (nodes) => nodes.some((node) => String(node.createdAt) < window.since),
  );
  return summarizeOutcomes({
    tracker: "linear",
    projectId,
    window,
    readAt: (input.now?.() ?? new Date()).toISOString(),
    issues,
    milestones: milestones.map((milestone) => ({ id: milestone.id, name: String(milestone.name) })),
    milestoneIssues,
    statusUpdates: updates.map((update) => ({
      id: update.id,
      createdAt: String(update.createdAt),
      url: typeof update.url === "string" ? update.url : null,
      health: typeof update.health === "string" ? update.health : null,
    })),
    ...(history === undefined ? {} : { history }),
    caveats: LINEAR_CAVEATS,
    ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
  });
}

const LINEAR_CAVEATS = [
  "Project membership is current: an issue that moved projects counts where it sits now.",
];

/** A calendar day in an IANA time zone, as the half-open instant range it covers. */
export interface LocalDay {
  /** YYYY-MM-DD in the zone. */
  readonly date: string;
  readonly start: string;
  readonly end: string;
}

function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const local = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return local - Math.floor(at / 1000) * 1000;
}
function zonedDate(at: number, timeZone: string): [number, number, number] {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date(at))
    .split("-")
    .map(Number);
  return [y!, m!, d!];
}
/** The instant local midnight begins on that zone's calendar date (DST-safe). */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day);
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

/** Every local day that overlaps the window, with full-day boundaries. */
export function localDays(window: OutcomeWindow, timeZone: string): LocalDay[] {
  const until = Date.parse(window.until);
  const days: LocalDay[] = [];
  let [y, m, d] = zonedDate(Date.parse(window.since), timeZone);
  for (;;) {
    const start = zonedMidnight(y, m, d, timeZone);
    if (start >= until) break;
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    [y, m, d] = [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
    const end = zonedMidnight(y, m, d, timeZone);
    days.push({
      date: new Date(Date.UTC(...([y, m - 1, d - 1] as const))).toISOString().slice(0, 10),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    });
  }
  return days;
}

/** Started-state issues at an instant, from state spans. */
export function startedAt(history: readonly OutcomeHistory[], at: string): number {
  const instant = Date.parse(at);
  return history.filter((issue) =>
    issue.spans.some(
      (span) =>
        span.state.type === "started" &&
        Date.parse(span.startedAt) <= instant &&
        (span.endedAt === null || instant < Date.parse(span.endedAt)),
    ),
  ).length;
}

/** The started count at the end of each day; a day still running is read at `readAt`. */
export function startedAtDayEnds(
  history: readonly OutcomeHistory[],
  days: readonly LocalDay[],
  readAt: string,
): { date: string; at: string; started: number }[] {
  return days
    .filter((day) => day.start < readAt)
    .map((day) => {
      const at = day.end < readAt ? day.end : readAt;
      return { date: day.date, at, started: startedAt(history, at) };
    });
}
