import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { usageWindowPace } from "@clankie/protocol/worker-accounts";
import {
  FleetCapacityBurnSchema,
  type FleetCapacityBurn,
  type FleetCapacityBurnSession,
  type FleetCapacityBurnWindow,
} from "@clankie/protocol";
import { occupantIdForHerdrSession } from "../captain/herdr-census.ts";

/**
 * How fast each metered account is being spent (ADR 0324). Clankie keeps his
 * own usage readings so a lead can see the recent pace, not only the window's
 * average, and sums the last hour of each local Claude session's transcript so
 * the pace can be traced to the agents spending it. Only counts leave here.
 */

const HOUR = 3_600_000;
const SAMPLE_EVERY_MS = 5 * 60_000;
const KEEP_MS = 8 * 24 * HOUR;
const MAX_SAMPLES = 3_000;
const RECENT_MIN_MS = 30 * 60_000;
const RECENT_MAX_MS = 3 * HOUR;
/** Claude reports resets to the hour; a reading within this of the last is the same window. */
const SAME_RESET_MS = 90 * 60_000;
const TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPTS = 400;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

interface Sample {
  readonly at: number;
  readonly used: number;
  readonly resetsAt?: number;
}

interface BurnWindowSource {
  readonly id: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly windowMinutes?: number | undefined;
  readonly resetsAt?: string | undefined;
}

export interface BurnAccountSource {
  readonly harness: string;
  readonly label: string;
  readonly plan?: string | undefined;
  readonly tier?: string | undefined;
  readonly home?: string | undefined;
  readonly homes?: readonly { readonly home: string }[] | undefined;
  readonly usage?:
    | {
        readonly source: string;
        readonly observedAt: string;
        readonly windows: readonly BurnWindowSource[];
      }
    | undefined;
}

const finiteTime = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Clankie's own usage readings, one series per account window, kept for a
 * week. A reading is kept when it moved or five minutes have passed.
 */
export class UsageHistory {
  private readonly series = new Map<string, Sample[]>();
  private loaded: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private readonly path: string | undefined;

  public constructor(path?: string) {
    this.path = path;
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (this.path === undefined) return;
      try {
        const raw = JSON.parse(await readFile(this.path, "utf8")) as unknown;
        const series = (raw as { series?: Record<string, unknown> }).series ?? {};
        for (const [key, value] of Object.entries(series)) {
          if (!Array.isArray(value)) continue;
          const samples = value.flatMap((entry): Sample[] => {
            const sample = entry as Partial<Sample>;
            return typeof sample.at === "number" &&
              Number.isFinite(sample.at) &&
              typeof sample.used === "number" &&
              sample.used >= 0 &&
              sample.used <= 100
              ? [
                  {
                    at: sample.at,
                    used: sample.used,
                    ...(typeof sample.resetsAt === "number" && Number.isFinite(sample.resetsAt)
                      ? { resetsAt: sample.resetsAt }
                      : {}),
                  },
                ]
              : [];
          });
          if (samples.length) this.series.set(key, samples.slice(-MAX_SAMPLES));
        }
      } catch {
        // No history yet, or an unreadable one: start over.
      }
    })();
    return this.loaded;
  }

  private static key(harness: string, label: string, window: string): string {
    return `${harness}\0${label}\0${window}`;
  }

  /** Records every usage window an account read carried. */
  public async record(accounts: readonly BurnAccountSource[]): Promise<void> {
    await this.load();
    for (const account of accounts) {
      const usage = account.usage;
      const at = finiteTime(usage?.observedAt);
      if (usage === undefined || at === undefined) continue;
      for (const window of usage.windows) {
        if (!Number.isFinite(window.usedPercent)) continue;
        const key = UsageHistory.key(account.harness, account.label, window.id);
        const samples = this.series.get(key) ?? [];
        const last = samples.at(-1);
        const resetsAt = finiteTime(window.resetsAt);
        if (last !== undefined && at <= last.at) continue;
        if (
          last !== undefined &&
          last.used === window.usedPercent &&
          last.resetsAt === resetsAt &&
          at - last.at < SAMPLE_EVERY_MS
        )
          continue;
        samples.push({ at, used: window.usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) });
        while (samples.length > MAX_SAMPLES || (samples[0] !== undefined && at - samples[0].at > KEEP_MS))
          samples.shift();
        this.series.set(key, samples);
        this.dirty = true;
      }
    }
    if (this.dirty) await this.save();
  }

  private save(): Promise<void> {
    const path = this.path;
    if (path === undefined) {
      this.dirty = false;
      return Promise.resolve();
    }
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        if (!this.dirty) return;
        this.dirty = false;
        const body = JSON.stringify({ version: 1, series: Object.fromEntries(this.series) });
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, body, { mode: 0o600 });
        await rename(temporary, path);
      });
    return this.writing.catch(() => undefined);
  }

  /**
   * The change since the oldest reading of the same window between half an
   * hour and three hours before `at`, per hour.
   */
  public async recent(
    harness: string,
    label: string,
    window: { id: string; usedPercent: number; resetsAt?: string | undefined },
    at: number,
  ): Promise<{ perHour: number; overMinutes: number } | undefined> {
    await this.load();
    const resetsAt = finiteTime(window.resetsAt);
    const samples = this.series.get(UsageHistory.key(harness, label, window.id)) ?? [];
    const base = samples.find(
      (sample) =>
        at - sample.at >= RECENT_MIN_MS &&
        at - sample.at <= RECENT_MAX_MS &&
        sample.used <= window.usedPercent &&
        (resetsAt === undefined ||
          sample.resetsAt === undefined ||
          Math.abs(sample.resetsAt - resetsAt) <= SAME_RESET_MS),
    );
    if (base === undefined) return undefined;
    const span = at - base.at;
    return {
      perHour: ((window.usedPercent - base.used) * HOUR) / span,
      overMinutes: Math.round(span / 60_000),
    };
  }
}

type Tokens = { input: number; output: number; cacheWrite: number; cacheRead: number };
const zero = (): Tokens => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const add = (into: Tokens, from: Tokens) => {
  into.input += from.input;
  into.output += from.output;
  into.cacheWrite += from.cacheWrite;
  into.cacheRead += from.cacheRead;
};

export interface SessionBurn {
  readonly sessionId: string;
  readonly lastActiveAt: number;
  readonly tokens: Tokens;
  /** The earliest moment this session's count covers. */
  readonly coveredFrom: number;
}

/** Complete JSON lines of the last `maxBytes` of a file. */
async function tailLines(path: string, maxBytes: number): Promise<{ lines: string[]; whole: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = await handle.stat();
    const from = Math.max(0, size - maxBytes);
    const bytes = Buffer.alloc(size - from);
    const read = await handle.read(bytes, 0, bytes.length, from);
    let text = bytes.subarray(0, read.bytesRead).toString("utf8");
    if (from > 0) text = text.slice(text.indexOf("\n") + 1);
    return { lines: text.split("\n"), whole: from === 0 };
  } finally {
    await handle.close();
  }
}

/**
 * Tokens one Claude transcript (with its own subagent transcripts) spent
 * since `since`. Each native message counts once, by its message id, however
 * many content blocks it was written as.
 */
async function transcriptBurn(
  files: readonly string[],
  since: number,
): Promise<{ tokens: Tokens; lastActiveAt: number; coveredFrom: number } | undefined> {
  const tokens = zero();
  const seen = new Set<string>();
  let lastActiveAt = 0;
  let coveredFrom = since;
  for (const file of files) {
    let tail: { lines: string[]; whole: boolean };
    try {
      tail = await tailLines(file, TRANSCRIPT_TAIL_BYTES);
    } catch {
      continue;
    }
    let first: number | undefined;
    for (const line of tail.lines) {
      if (!line.includes('"usage"')) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
      if (!Number.isFinite(at)) continue;
      first ??= at;
      if (record.type !== "assistant" || at < since) continue;
      const message = (record.message ?? {}) as Record<string, unknown>;
      const usage = (message.usage ?? undefined) as Record<string, unknown> | undefined;
      if (usage === undefined) continue;
      const id = typeof message.id === "string" ? message.id : `${file}:${String(record.uuid)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      add(tokens, {
        input: count(usage.input_tokens),
        output: count(usage.output_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
      });
      if (at > lastActiveAt) lastActiveAt = at;
    }
    if (!tail.whole && first !== undefined && first > coveredFrom) coveredFrom = first;
  }
  return seen.size === 0 ? undefined : { tokens, lastActiveAt, coveredFrom };
}

/**
 * The last hour of every Claude session under the given profile homes, read
 * from transcripts written to in that hour. Main transcripts are
 * `projects/<dir>/<session>.jsonl`; a session's subagents write under
 * `projects/<dir>/<session>/subagents/`, and count toward that session.
 */
export async function readClaudeSessionBurn(
  homes: readonly string[],
  now: number,
  windowMs = HOUR,
): Promise<{ sessions: SessionBurn[]; truncated: boolean }> {
  const since = now - windowMs;
  const bySession = new Map<string, string[]>();
  let considered = 0;
  let truncated = false;
  const recentFile = async (path: string) => {
    try {
      const info = await stat(path);
      return info.isFile() && info.mtimeMs >= since;
    } catch {
      return false;
    }
  };
  for (const home of new Set(homes)) {
    const projects = join(home, "projects");
    let dirs: string[];
    try {
      dirs = await readdir(projects);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const root = join(projects, dir);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const session =
          entry.isFile() && entry.name.endsWith(".jsonl") ? entry.name.slice(0, -6) : entry.name;
        if (!UUID.test(session)) continue;
        const candidates: string[] = [];
        if (entry.isFile()) candidates.push(join(root, entry.name));
        else if (entry.isDirectory()) {
          try {
            for (const child of await readdir(join(root, session, "subagents")))
              if (child.endsWith(".jsonl")) candidates.push(join(root, session, "subagents", child));
          } catch {
            // No subagents.
          }
        }
        for (const file of candidates) {
          if (!(await recentFile(file))) continue;
          if (++considered > MAX_TRANSCRIPTS) {
            truncated = true;
            break;
          }
          const key = session.toLowerCase();
          bySession.set(key, [...(bySession.get(key) ?? []), file]);
        }
      }
    }
  }
  const sessions: SessionBurn[] = [];
  for (const [sessionId, files] of bySession) {
    const burn = await transcriptBurn(files, since);
    if (burn !== undefined) sessions.push({ sessionId, ...burn });
  }
  sessions.sort((a, b) => b.tokens.output - a.tokens.output || b.lastActiveAt - a.lastActiveAt);
  return { sessions, truncated };
}

export interface BurnSeat {
  readonly seatId: string;
  readonly occupantId: string;
  readonly title: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * One row per Claude or Codex account with a usage reading, merged across the
 * machines that report it. Window rates come from the account's own reading
 * and Clankie's history; the last hour comes from this Mac's transcripts.
 */
export async function projectUsageBurn(input: {
  readonly now: number;
  readonly machines: readonly { readonly machine: string; readonly accounts: readonly BurnAccountSource[] }[];
  readonly history: UsageHistory;
  /** Local Claude session burn per account label, when this Mac's transcripts were read. */
  readonly local?: ReadonlyMap<string, { sessions: readonly SessionBurn[]; truncated: boolean }>;
  readonly seats: readonly BurnSeat[];
}): Promise<{ burn: FleetCapacityBurn[]; notices: string[] }> {
  const notices: string[] = [];
  const seatByOccupant = new Map(input.seats.map((seat) => [seat.occupantId, seat]));
  const rows = new Map<string, { account: BurnAccountSource; machines: string[] }>();
  for (const machine of input.machines) {
    for (const account of machine.accounts) {
      if (account.harness !== "claude" && account.harness !== "codex") continue;
      if (account.usage === undefined || finiteTime(account.usage.observedAt) === undefined) continue;
      const key = `${account.harness}\0${account.label}`;
      const row = rows.get(key);
      if (row === undefined) rows.set(key, { account, machines: [machine.machine] });
      else {
        row.machines.push(machine.machine);
        // The freshest reading of the same account speaks for it.
        if (finiteTime(account.usage.observedAt)! > finiteTime(row.account.usage!.observedAt)!)
          row.account = account;
      }
    }
  }
  const burn: FleetCapacityBurn[] = [];
  for (const { account, machines } of rows.values()) {
    const usage = account.usage!;
    const observedAt = finiteTime(usage.observedAt)!;
    const windows: FleetCapacityBurnWindow[] = [];
    for (const window of usage.windows) {
      const resetsAt = finiteTime(window.resetsAt);
      const live = resetsAt !== undefined && resetsAt > input.now ? resetsAt : undefined;
      const hoursToReset = live === undefined ? undefined : (live - input.now) / HOUR;
      const pace = usageWindowPace(
        {
          id: window.id,
          label: window.label,
          usedPercent: window.usedPercent,
          ...(window.windowMinutes === undefined ? {} : { windowMinutes: window.windowMinutes }),
          ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        },
        input.now,
      );
      const average = pace.burnPerDay === undefined ? undefined : pace.burnPerDay / 24;
      const recent = await input.history.recent(account.harness, account.label, window, observedAt);
      const rate = recent?.perHour ?? average;
      const left = 100 - window.usedPercent;
      let runsOutAt: FleetCapacityBurnWindow["runsOutAt"] = "unknown";
      if (rate !== undefined && hoursToReset !== undefined) {
        const hoursLeft = rate > 0 ? left / rate : Infinity;
        runsOutAt = hoursLeft < hoursToReset ? iso(input.now + hoursLeft * HOUR) : "not before reset";
      }
      windows.push({
        id: window.id.slice(0, 80),
        label: window.label.slice(0, 96),
        usedPercent: window.usedPercent,
        resetsAt: live === undefined ? "unknown" : iso(live),
        hoursToReset: hoursToReset === undefined ? "unknown" : round(hoursToReset, 2),
        percentPerHour: {
          recent: recent === undefined ? "unknown" : round(Math.max(0, recent.perHour), 3),
          recentOverMinutes: recent === undefined ? "unknown" : recent.overMinutes,
          windowAverage: average === undefined ? "unknown" : round(average, 3),
          toUseAllByReset:
            hoursToReset === undefined ? "unknown" : round(left / Math.max(hoursToReset, 1 / 60), 3),
        },
        projectedUsedAtReset:
          rate === undefined || hoursToReset === undefined
            ? "unknown"
            : round(window.usedPercent + Math.max(0, rate) * hoursToReset, 1),
        runsOutAt,
      });
    }
    let lastHour: FleetCapacityBurn["lastHour"] = "unknown";
    const local = account.harness === "claude" ? input.local?.get(account.label) : undefined;
    if (local !== undefined) {
      const tokens = zero();
      let coveredFrom = input.now - HOUR;
      for (const session of local.sessions) {
        add(tokens, session.tokens);
        if (session.coveredFrom > coveredFrom) coveredFrom = session.coveredFrom;
      }
      const bySession: FleetCapacityBurnSession[] = local.sessions.slice(0, 32).map((session) => {
        const seat = seatByOccupant.get(
          occupantIdForHerdrSession({ source: "herdr:claude", kind: "id", value: session.sessionId }),
        );
        return {
          agent: seat === undefined ? "unknown" : seat.seatId.slice(0, 256),
          ...(seat === undefined ? {} : { title: seat.title.slice(0, 200) }),
          lastActiveAt: iso(session.lastActiveAt),
          tokens: { ...session.tokens },
        };
      });
      lastHour = { since: iso(coveredFrom), sessions: local.sessions.length, tokens, bySession };
      if (local.truncated)
        notices.push(`Only the first ${MAX_TRANSCRIPTS} recent transcripts of ${account.label} were read.`);
    }
    burn.push(
      FleetCapacityBurnSchema.parse({
        harness: account.harness,
        account: account.label.slice(0, 128),
        plan:
          account.tier !== undefined && account.tier.length > 0 && account.tier.length <= 64
            ? account.tier
            : account.plan !== undefined && account.plan.length > 0 && account.plan.length <= 64
              ? account.plan
              : "unknown",
        machines: [...new Set(machines)].slice(0, 16).map((machine) => machine.slice(0, 64)),
        observedAt: iso(observedAt),
        windows: windows.slice(0, 16),
        lastHour,
      }),
    );
  }
  return { burn: burn.slice(0, 64), notices };
}

const round = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** The profile homes of one machine's signed-in Claude accounts, by account label. */
export function claudeAccountHomes(accounts: readonly BurnAccountSource[]): Map<string, string[]> {
  const homes = new Map<string, string[]>();
  for (const account of accounts) {
    if (account.harness !== "claude") continue;
    const list = [
      ...(account.home === undefined ? [] : [account.home]),
      ...(account.homes ?? []).map((entry) => entry.home),
    ].filter((home) => home.length > 0);
    if (list.length) homes.set(account.label, [...new Set([...(homes.get(account.label) ?? []), ...list])]);
  }
  return homes;
}
