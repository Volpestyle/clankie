import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  RoutineCommandSchema,
  RoutineMissedPolicySchema,
  RoutineNameSchema,
  RoutineRunSchema,
  RoutineScheduleSchema,
  RoutineTargetSchema,
  type Routine,
  type RoutineCommand,
  type RoutineRun,
  type RoutineSchedule,
  type RoutineTarget,
  type RoutineTargetInput,
  type RoutinesStatus,
} from "@clankie/protocol";
import { Cron } from "croner";
import { z } from "zod";

/**
 * Routines (ADR 0265): owner-defined recurring jobs with durable schedule
 * state, a run fence and a run log.
 *
 * The fence is one exclusive claim file per routine slot, created before the
 * run starts. A slot is claimed once ever, by one process, so a restart, a
 * deploy that briefly overlaps two services, or a timer that fires twice
 * cannot run it again. Runs are therefore at most once: a run interrupted by a
 * restart is logged as interrupted and is not replayed.
 */

const TICK_MS = 30_000;
/** A slot found later than this after its time was missed (the Mac slept or the service was down). */
const LATE_GRACE_MS = 2 * 60_000;
/** Bounds slot enumeration after a long sleep; a longer gap reports this many and resumes from there. */
const MAX_SLOTS_SCANNED = 10_000;
const CLAIM_RETENTION_MS = 45 * 24 * 60 * 60_000;
const RUN_LOG_COMPACT_LINES = 5_000;
const RUN_LOG_KEEP_RUNS = 2_000;

const PersistedRoutineSchema = z
  .object({
    id: z.string(),
    name: RoutineNameSchema,
    schedule: RoutineScheduleSchema,
    target: RoutineTargetSchema,
    enabled: z.boolean(),
    missed: RoutineMissedPolicySchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    createdBy: z.string().min(1).max(256),
    /** The latest slot claimed or passed over; the schedule resumes after it. */
    cursor: z.string().datetime(),
  })
  .strict();
type PersistedRoutine = z.infer<typeof PersistedRoutineSchema>;
const PersistedStateSchema = z
  .object({ schemaVersion: z.literal(1), routines: z.array(PersistedRoutineSchema) })
  .strict();

/** Who is asking: the owner through the API, or a lead acting for its own conversation. */
export type RoutineActor =
  | { readonly kind: "owner" }
  | { readonly kind: "lead"; readonly conversationId: string };

export interface RoutineExecution {
  readonly ok: boolean;
  readonly detail: string;
  readonly links?: readonly string[];
}

export interface RoutineStoreOptions {
  readonly stateDir: string;
  /** Runs one routine's target with that target conversation's authority. Throws count as failures. */
  readonly execute: (routine: Routine, run: RoutineRun) => Promise<RoutineExecution>;
  /** Refuses a target conversation that cannot hold routine turns. */
  readonly validateTarget: (target: RoutineTarget) => void;
  /** Clankie's main chat, for an owner's target that names none. */
  readonly defaultConversationId: () => string;
  readonly defaultTimeZone?: () => string;
  readonly now?: () => number;
  readonly tickMs?: number;
}

export class RoutineError extends Error {
  public readonly code: "not_found" | "invalid" | "forbidden" | "busy";
  public constructor(code: RoutineError["code"], message: string) {
    super(message);
    this.name = "RoutineError";
    this.code = code;
  }
}

export class RoutineStore {
  private readonly dir: string;
  private readonly statePath: string;
  private readonly runLogPath: string;
  private readonly claimDir: string;
  private readonly now: () => number;
  private routines: PersistedRoutine[];
  private readonly runs = new Map<string, RoutineRun>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private started = false;
  private unreadable = false;

  private readonly options: RoutineStoreOptions;

  public constructor(options: RoutineStoreOptions) {
    this.options = options;
    this.dir = join(options.stateDir, "routines");
    this.statePath = join(this.dir, "routines.json");
    this.runLogPath = join(this.dir, "runs.jsonl");
    this.claimDir = join(this.dir, "claims");
    this.now = options.now ?? Date.now;
    this.routines = this.readState();
    this.readRuns();
  }

  /** Settle runs a previous process left open, then check the schedule now and every tick. */
  public start(): void {
    if (this.started) return;
    this.started = true;
    for (const run of this.runs.values()) {
      if (run.status !== "running" || this.claimHolderAlive(run)) continue;
      this.writeRun({
        ...run,
        status: "interrupted",
        finishedAt: new Date(this.now()).toISOString(),
        detail: "The service stopped during this run; it was not replayed.",
      });
    }
    this.pruneClaims();
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  /** Stops scheduling; runs already under way finish on their own. */
  public close(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
  }

  /** Wait for every run under way (tests and shutdown). */
  public async settled(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled(this.inFlight.values());
  }

  public status(actor: RoutineActor = { kind: "owner" }): RoutinesStatus {
    return {
      schemaVersion: 1,
      ...(this.unreadable ? { error: "state_unreadable" as const } : {}),
      routines: this.visible(actor).map((routine) => this.project(routine)),
    };
  }

  public async command(input: RoutineCommand, actor: RoutineActor): Promise<RoutinesStatus> {
    const command = RoutineCommandSchema.parse(input);
    if (this.unreadable && command.action !== "list" && command.action !== "history")
      throw new RoutineError(
        "busy",
        `The routines file ${this.statePath} is unreadable; fix or move it, then restart.`,
      );
    switch (command.action) {
      case "list":
        return this.status(actor);
      case "add": {
        const target = this.resolveTarget(command.target, actor);
        const schedule = this.resolveSchedule(command.schedule.when, command.schedule.timeZone);
        const now = new Date(this.now()).toISOString();
        const routine: PersistedRoutine = {
          id: `rt_${randomBytes(6).toString("hex")}`,
          name: command.name,
          schedule,
          target,
          enabled: command.enabled ?? true,
          missed: command.missed ?? "catch_up",
          createdAt: now,
          updatedAt: now,
          createdBy: actor.kind === "owner" ? "owner" : actor.conversationId,
          cursor: now,
        };
        this.routines.push(PersistedRoutineSchema.parse(routine));
        this.save();
        return this.changed(routine, actor);
      }
      case "edit": {
        const routine = this.find(command.id, actor);
        const target = command.target === undefined ? undefined : this.resolveTarget(command.target, actor);
        const next: PersistedRoutine = {
          ...routine,
          ...(command.name === undefined ? {} : { name: command.name }),
          ...(target === undefined ? {} : { target }),
          ...(command.missed === undefined ? {} : { missed: command.missed }),
          updatedAt: new Date(this.now()).toISOString(),
        };
        if (command.schedule !== undefined) {
          next.schedule = this.resolveSchedule(
            command.schedule.when,
            command.schedule.timeZone ?? routine.schedule.timeZone,
          );
          // A new schedule starts from now; it never owes runs from before it existed.
          next.cursor = new Date(Math.max(this.now(), Date.parse(routine.cursor))).toISOString();
        }
        this.replace(PersistedRoutineSchema.parse(next));
        return this.changed(next, actor);
      }
      case "pause":
      case "resume": {
        const routine = this.find(command.id, actor);
        const enabled = command.action === "resume";
        const next: PersistedRoutine = {
          ...routine,
          enabled,
          updatedAt: new Date(this.now()).toISOString(),
          // Resuming never replays what came due while paused.
          ...(enabled && !routine.enabled
            ? { cursor: new Date(Math.max(this.now(), Date.parse(routine.cursor))).toISOString() }
            : {}),
        };
        this.replace(next);
        return this.changed(next, actor);
      }
      case "run_now": {
        const routine = this.find(command.id, actor);
        if (this.inFlight.has(routine.id))
          throw new RoutineError("busy", "This routine is already running; a run never overlaps itself.");
        const run = this.begin(routine, "manual", new Date(this.now()), 0);
        if (run === undefined) throw new RoutineError("busy", "That run was already claimed.");
        return { ...this.changed(routine, actor), runs: [run] };
      }
      case "remove": {
        const routine = this.find(command.id, actor);
        this.routines = this.routines.filter((candidate) => candidate.id !== routine.id);
        this.save();
        return this.status(actor);
      }
      case "history": {
        if (command.id !== undefined) this.find(command.id, actor);
        const visible = new Set(this.visible(actor).map((routine) => routine.id));
        const runs = [...this.runs.values()]
          .filter((run) =>
            command.id === undefined ? visible.has(run.routineId) : run.routineId === command.id,
          )
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .slice(0, command.limit ?? 20);
        return { ...this.status(actor), runs };
      }
    }
  }

  /** One pass over every enabled routine: run what is due, apply the missed-run policy. */
  public async tick(): Promise<void> {
    if (this.ticking || this.unreadable) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const routine of this.routines) {
        if (!routine.enabled) continue;
        let due: { latest?: Date; count: number };
        try {
          due = this.dueSlots(routine, now);
        } catch (error) {
          console.warn("Routine schedule unreadable", routine.id, String(error));
          continue;
        }
        const latest = due.latest;
        if (latest === undefined) continue;
        const earlier = due.count - 1;
        const late = now - latest.getTime() > LATE_GRACE_MS;
        if (this.inFlight.has(routine.id)) {
          this.skip(
            routine,
            latest,
            earlier + 1,
            "The previous run was still going; a run never overlaps itself.",
          );
          continue;
        }
        if (late && routine.missed === "skip") {
          this.skip(routine, latest, earlier + 1, "Missed while the Mac slept or the service was down.");
          continue;
        }
        this.begin(routine, late ? "catch_up" : "schedule", latest, late ? earlier + 1 : earlier);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Plain language or five cron fields, in the owner's time zone. */
  public resolveSchedule(when: string, timeZone?: string): RoutineSchedule {
    const zone =
      timeZone ?? this.options.defaultTimeZone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const parsed = parseRoutineWhen(when);
    try {
      new Cron(parsed.cron, { timezone: zone, paused: true });
    } catch (error) {
      throw new RoutineError(
        "invalid",
        `Schedule not understood: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return RoutineScheduleSchema.parse({
      cron: parsed.cron,
      timeZone: zone,
      ...(parsed.text === undefined ? {} : { text: parsed.text }),
    });
  }

  private begin(
    routine: PersistedRoutine,
    trigger: RoutineRun["trigger"],
    slot: Date,
    missed: number,
  ): RoutineRun | undefined {
    const run: RoutineRun = RoutineRunSchema.parse({
      id: randomUUID(),
      routineId: routine.id,
      trigger,
      slot: slot.toISOString(),
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
      ...(missed > 0 ? { missed } : {}),
    });
    const claimed = this.claim(
      routine.id,
      trigger === "manual" ? `manual-${run.id}` : String(slot.getTime()),
      run,
    );
    if (trigger !== "manual") this.advance(routine.id, slot);
    if (!claimed) return undefined;
    this.writeRun(run);
    const job = this.execute(routine, run).finally(() => this.inFlight.delete(routine.id));
    this.inFlight.set(routine.id, job);
    return run;
  }

  private async execute(routine: PersistedRoutine, run: RoutineRun): Promise<void> {
    let result: RoutineExecution;
    try {
      result = await this.options.execute(this.project(routine), run);
    } catch (error) {
      result = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    const finished = this.now();
    this.writeRun({
      ...run,
      status: result.ok ? "succeeded" : "failed",
      finishedAt: new Date(finished).toISOString(),
      durationMs: Math.max(0, finished - Date.parse(run.startedAt)),
      detail: result.detail.slice(0, 4000),
      ...(result.links?.length ? { links: [...result.links].slice(0, 20) } : {}),
    });
  }

  private skip(routine: PersistedRoutine, slot: Date, missed: number, detail: string): void {
    const at = new Date(this.now()).toISOString();
    const run = RoutineRunSchema.parse({
      id: randomUUID(),
      routineId: routine.id,
      trigger: "schedule",
      slot: slot.toISOString(),
      status: "skipped",
      startedAt: at,
      finishedAt: at,
      durationMs: 0,
      detail,
      ...(missed > 0 ? { missed } : {}),
    });
    const claimed = this.claim(routine.id, String(slot.getTime()), run);
    this.advance(routine.id, slot);
    if (claimed) this.writeRun(run);
  }

  /** The latest slot due since the cursor, and how many came due in all. */
  private dueSlots(routine: PersistedRoutine, now: number): { latest?: Date; count: number } {
    const cron = new Cron(routine.schedule.cron, { timezone: routine.schedule.timeZone, paused: true });
    let latest: Date | undefined;
    let count = 0;
    let from = new Date(routine.cursor);
    while (count < MAX_SLOTS_SCANNED) {
      const next = cron.nextRun(from);
      if (next === null || next.getTime() > now) break;
      latest = next;
      count += 1;
      from = next;
    }
    return { ...(latest === undefined ? {} : { latest }), count };
  }

  private nextRunAt(routine: PersistedRoutine): string | undefined {
    if (!routine.enabled) return undefined;
    try {
      const cron = new Cron(routine.schedule.cron, { timezone: routine.schedule.timeZone, paused: true });
      const from = new Date(Math.max(this.now(), Date.parse(routine.cursor)));
      return cron.nextRun(from)?.toISOString();
    } catch {
      return undefined;
    }
  }

  private project(routine: PersistedRoutine): Routine {
    const { cursor: _cursor, ...rest } = routine;
    const lastRun = this.lastRun(routine.id);
    const next = this.nextRunAt(routine);
    return {
      ...rest,
      ...(next === undefined ? {} : { nextRunAt: next }),
      ...(lastRun === undefined ? {} : { lastRun }),
    };
  }

  private lastRun(routineId: string): RoutineRun | undefined {
    let latest: RoutineRun | undefined;
    for (const run of this.runs.values())
      if (run.routineId === routineId && (latest === undefined || run.startedAt >= latest.startedAt))
        latest = run;
    return latest;
  }

  private changed(routine: PersistedRoutine, actor: RoutineActor): RoutinesStatus {
    const current = this.routines.find((candidate) => candidate.id === routine.id) ?? routine;
    return { ...this.status(actor), routine: this.project(current) };
  }

  private visible(actor: RoutineActor): PersistedRoutine[] {
    return actor.kind === "owner"
      ? this.routines
      : this.routines.filter((routine) => routine.target.conversationId === actor.conversationId);
  }

  private find(id: string, actor: RoutineActor): PersistedRoutine {
    const routine = this.visible(actor).find((candidate) => candidate.id === id);
    if (routine === undefined) throw new RoutineError("not_found", `No routine ${id} here`);
    return routine;
  }

  /**
   * A lead's routine acts only in its own conversation: the authority it
   * already has, never more. The owner's may name any chat, else the main one.
   */
  private resolveTarget(input: RoutineTargetInput, actor: RoutineActor): RoutineTarget {
    const conversationId =
      input.conversationId ??
      (actor.kind === "lead" ? actor.conversationId : this.options.defaultConversationId());
    if (actor.kind === "lead" && conversationId !== actor.conversationId)
      throw new RoutineError("forbidden", "A lead's routine must target its own conversation");
    const target = RoutineTargetSchema.parse({ ...input, conversationId });
    this.options.validateTarget(target);
    return target;
  }

  private replace(next: PersistedRoutine): void {
    this.routines = this.routines.map((routine) => (routine.id === next.id ? next : routine));
    this.save();
  }

  private advance(routineId: string, slot: Date): void {
    const routine = this.routines.find((candidate) => candidate.id === routineId);
    if (routine === undefined || Date.parse(routine.cursor) >= slot.getTime()) return;
    this.replace({ ...routine, cursor: slot.toISOString() });
  }

  /** The run fence: an exclusive file per slot, written before the run begins. */
  private claim(routineId: string, key: string, run: RoutineRun): boolean {
    const dir = join(this.claimDir, routineId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(join(dir, key), JSON.stringify({ runId: run.id, pid: process.pid }), {
        flag: "wx",
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }

  /** Whether the process that claimed this run's slot is still alive (an overlapping deploy). */
  private claimHolderAlive(run: RoutineRun): boolean {
    const dir = join(this.claimDir, run.routineId);
    try {
      for (const name of readdirSync(dir)) {
        const claim = z
          .object({ runId: z.string(), pid: z.number().int() })
          .safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
        if (!claim.success || claim.data.runId !== run.id) continue;
        if (claim.data.pid === process.pid) return false;
        try {
          process.kill(claim.data.pid, 0);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  private pruneClaims(): void {
    if (!existsSync(this.claimDir)) return;
    const cutoff = this.now() - CLAIM_RETENTION_MS;
    for (const routineId of readdirSync(this.claimDir)) {
      const dir = join(this.claimDir, routineId);
      const live = this.routines.some((routine) => routine.id === routineId);
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        // Keep recent claims: they are what fences a slot against a second run.
        if (!live || statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
      }
    }
  }

  private writeRun(run: RoutineRun): void {
    const parsed = RoutineRunSchema.parse(run);
    this.runs.set(parsed.id, parsed);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.runLogPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  }

  private readRuns(): void {
    let raw: string;
    try {
      raw = readFileSync(this.runLogPath, "utf8");
    } catch {
      return;
    }
    const lines = raw.split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      try {
        const parsed = RoutineRunSchema.safeParse(JSON.parse(line));
        if (parsed.success) this.runs.set(parsed.data.id, parsed.data);
      } catch {
        // A torn final line from a crash is skipped; every other line still counts.
      }
    }
    if (lines.length <= RUN_LOG_COMPACT_LINES) return;
    const keep = [...this.runs.values()]
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(-RUN_LOG_KEEP_RUNS);
    this.runs.clear();
    for (const run of keep) this.runs.set(run.id, run);
    const temporary = `${this.runLogPath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, keep.map((run) => `${JSON.stringify(run)}\n`).join(""), { mode: 0o600 });
    renameSync(temporary, this.runLogPath);
  }

  private readState(): PersistedRoutine[] {
    if (!existsSync(this.statePath)) return [];
    try {
      return PersistedStateSchema.parse(JSON.parse(readFileSync(this.statePath, "utf8"))).routines;
    } catch (error) {
      // Fail closed: run nothing and never overwrite the owner's routines with an empty list.
      console.warn("Routines file unreadable", this.statePath, String(error));
      this.unreadable = true;
      return [];
    }
  }

  private save(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, routines: this.routines }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.statePath);
  }
}

const DAYS: Record<string, string> = {
  sunday: "0",
  sun: "0",
  monday: "1",
  mon: "1",
  tuesday: "2",
  tue: "2",
  tues: "2",
  wednesday: "3",
  wed: "3",
  thursday: "4",
  thu: "4",
  thurs: "4",
  friday: "5",
  fri: "5",
  saturday: "6",
  sat: "6",
};

/**
 * The plain-language schedules people say, resolved to cron. Anything else
 * must be five cron fields; an unrecognised phrase is refused, never guessed.
 */
function parseRoutineWhen(when: string): { cron: string; text?: string } {
  const text = when.trim().replace(/\s+/gu, " ");
  if (/^[\d*/,-]+( \S+){4}$/u.test(text)) return { cron: text };
  const lower = text.toLowerCase().replace(/^every\s+/u, "every ");
  const fail = (): never => {
    throw new RoutineError(
      "invalid",
      `Schedule not understood: "${text}". Try "every weekday at 9:00", "every friday at 17:30", "every 2 hours", "every 30 minutes", or five cron fields.`,
    );
  };
  let match = /^every (\d{1,2}) ?(?:minutes|mins|min)$/u.exec(lower);
  if (match) {
    const minutes = Number(match[1]);
    if (minutes < 1 || minutes > 59) fail();
    return { cron: `*/${String(minutes)} * * * *`, text };
  }
  if (/^(?:every hour|hourly)$/u.test(lower)) return { cron: "0 * * * *", text };
  match = /^every (\d{1,2}) ?(?:hours|hrs|h)$/u.exec(lower);
  if (match) {
    const hours = Number(match[1]);
    if (hours < 1 || hours > 23) fail();
    return { cron: `0 */${String(hours)} * * *`, text };
  }
  match = /^(?:every )?(.+?)(?: at (.+))?$/u.exec(lower);
  if (!match) return fail();
  const dayPart = match[1]!.trim();
  const time = parseClock(match[2] ?? (/\bevening\b/u.test(dayPart) ? "18:00" : "9:00"));
  if (time === undefined) return fail();
  const days = parseDays(dayPart);
  if (days === undefined) return fail();
  return { cron: `${String(time.minute)} ${String(time.hour)} * * ${days}`, text };
}

function parseDays(part: string): string | undefined {
  const words = part.replace(/\b(?:morning|evening)\b/gu, "").trim();
  if (["day", "daily", "", "night"].includes(words)) return "*";
  if (["weekday", "weekdays", "workday", "workdays"].includes(words)) return "1-5";
  if (["weekend", "weekends"].includes(words)) return "0,6";
  const names = words
    .split(/\s*(?:,|\band\b|&)\s*/u)
    .map((name) => name.replace(/s$/u, ""))
    .filter((name) => name.length > 0);
  if (!names.length) return undefined;
  const numbers = names.map((name) => DAYS[name] ?? DAYS[`${name}s`]);
  if (numbers.some((day) => day === undefined)) return undefined;
  return [...new Set(numbers)].join(",");
}

function parseClock(input: string): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/u.exec(input.trim());
  if (!match) return undefined;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  if (match[3] !== undefined) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (match[3] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}
