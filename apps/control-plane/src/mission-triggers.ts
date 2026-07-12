import {
  MissionTriggerSchema,
  type DomainEvent,
  type MissionTrigger,
  type MissionTriggerSchedule,
} from "@clankie/protocol";
import { z } from "zod";

export const MissionTriggerInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    goal: z.string().min(1),
    context: z.record(z.string(), z.unknown()).default({}),
    schedule: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("cron"), expression: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("once"), at: z.string().datetime() }).strict(),
    ]),
    misfirePolicy: z.enum(["skip", "run_once_late"]),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.schedule.kind !== "cron") return;
    try {
      parseCronExpression(input.schedule.expression);
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["schedule", "expression"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

interface CronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

interface ParsedCron {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  readonly month: CronField;
  readonly dayOfWeek: CronField;
}

const FIELD_RANGES = [
  [0, 59, "minute"],
  [0, 23, "hour"],
  [1, 31, "day-of-month"],
  [1, 12, "month"],
  [0, 6, "day-of-week"],
] as const;

export function parseCronExpression(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) throw new Error("Cron expression must contain exactly five fields");
  const fields = parts.map((part, index) => {
    const range = FIELD_RANGES[index];
    if (range === undefined || part === undefined)
      throw new Error("Cron expression must contain exactly five fields");
    return parseField(part, range[0], range[1], range[2]);
  });
  return {
    minute: fields[0]!,
    hour: fields[1]!,
    dayOfMonth: fields[2]!,
    month: fields[3]!,
    dayOfWeek: fields[4]!,
  };
}

function parseField(source: string, minimum: number, maximum: number, name: string): CronField {
  if (source === "*") return { values: rangeValues(minimum, maximum, 1), wildcard: true };
  const step = /^\*\/(\d+)$/u.exec(source);
  if (step !== null) {
    const amount = Number(step[1]);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > maximum - minimum + 1)
      throw new Error(`Invalid ${name} step`);
    return { values: rangeValues(minimum, maximum, amount), wildcard: true };
  }
  if (!/^\d+(?:,\d+)*$/u.test(source))
    throw new Error(`Unsupported ${name} field; use *, a number, a comma list, or */step`);
  const values = source.split(",").map(Number);
  if (values.some((value) => value < minimum || value > maximum))
    throw new Error(`${name} must be between ${String(minimum)} and ${String(maximum)}`);
  return { values: new Set(values), wildcard: false };
}

function rangeValues(minimum: number, maximum: number, step: number): ReadonlySet<number> {
  const values = new Set<number>();
  for (let value = minimum; value <= maximum; value += step) values.add(value);
  return values;
}

export function nextFireAfter(schedule: MissionTriggerSchedule, after: Date): Date | undefined {
  if (schedule.kind === "once") {
    const at = new Date(schedule.at);
    return at.getTime() > after.getTime() ? at : undefined;
  }
  const cron = parseCronExpression(schedule.expression);
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  const deadline = candidate.getTime() + 366 * 24 * 60 * 60 * 1_000 * 8;
  while (candidate.getTime() <= deadline) {
    if (matches(cron, candidate)) return new Date(candidate);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error("Cron expression has no fire time within eight years");
}

function matches(cron: ParsedCron, date: Date): boolean {
  if (
    !cron.minute.values.has(date.getUTCMinutes()) ||
    !cron.hour.values.has(date.getUTCHours()) ||
    !cron.month.values.has(date.getUTCMonth() + 1)
  )
    return false;
  const dom = cron.dayOfMonth.values.has(date.getUTCDate());
  const dow = cron.dayOfWeek.values.has(date.getUTCDay());
  const dayMatches = cron.dayOfMonth.wildcard ? dow : cron.dayOfWeek.wildcard ? dom : dom || dow;
  return dayMatches;
}

export function applyMissionTriggerEvent(triggers: Map<string, MissionTrigger>, event: DomainEvent): void {
  if (event.type === "mission.trigger.deleted") {
    const triggerId = z.string().min(1).parse(event.data.triggerId);
    triggers.delete(triggerId);
    return;
  }
  if (
    ![
      "mission.trigger.created",
      "mission.trigger.updated",
      "mission.trigger.fired",
      "mission.trigger.skipped",
    ].includes(event.type)
  )
    return;
  const trigger = MissionTriggerSchema.parse(event.data.trigger);
  triggers.set(trigger.id, trigger);
}

export function dueOccurrences(trigger: MissionTrigger, now: Date): readonly Date[] {
  const start = new Date(trigger.lastEvaluatedAt ?? trigger.createdAt);
  const occurrences: Date[] = [];
  let next = nextFireAfter(trigger.schedule, start);
  while (next !== undefined && next.getTime() <= now.getTime() && occurrences.length < 2) {
    occurrences.push(next);
    next = nextFireAfter(trigger.schedule, next);
  }
  return occurrences;
}
