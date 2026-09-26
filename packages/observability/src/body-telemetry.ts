/**
 * Body telemetry: metadata-only operational events from a hosted body.
 *
 * Off unless `CLANKIE_BODY_TELEMETRY_DIR` names a spool directory; the
 * whole-body command (`clankie-body`) sets it, a Mac never does. Events are
 * appended to hourly JSONL files there. Shipping is a separate process
 * (`clankie telemetry ship`) that the host runs with its own credentials: the
 * body itself holds none and cannot choose whose stream it writes.
 *
 * Every event is one strict schema. A field is an id, a closed code, a finite
 * number or a boolean — never text a person or a model wrote, a path, a
 * command, or an error message. An event that fails its schema is dropped, not
 * repaired, and the shipper parses every line again before it leaves the host.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const BODY_TELEMETRY_DIR_ENV = "CLANKIE_BODY_TELEMETRY_DIR";
/** The spool never holds more than this; the oldest hour goes first. */
export const BODY_TELEMETRY_SPOOL_BYTES_MAX = 1024 * 1024;
const SPOOL_HOURS_MAX = 48;
const LINE_BYTES_MAX = 2048;

/** Credential shapes a code must never resemble, even though codes come from our own constants. */
const KEY_SHAPED = /(?:^|[^a-z0-9])(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat|akia|asia)[_-]/iu;
const Code = z
  .string()
  .regex(/^[a-z0-9_.-]{1,48}$/u)
  .refine((value) => !KEY_SHAPED.test(value), "a code must not look like a credential");
const Count = z.number().int().nonnegative().max(1_000_000);
const DurationMs = z
  .number()
  .int()
  .nonnegative()
  .max(7 * 24 * 3_600_000);
const Percent = z.number().min(0).max(100);
/** Opaque ids only: a gateway request id, a hashed device reference, a grant. */
const OpaqueId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/u)
  .refine((value) => !KEY_SHAPED.test(value), "an id must not look like a credential");

const envelope = { v: z.literal(1), atMs: z.number().int().positive() };

export const BodyTelemetryEventSchema = z.discriminatedUnion("event", [
  z
    .object({
      ...envelope,
      event: z.literal("body.boot"),
      phase: z.enum(["container-start", "clankie-healthy", "relay-healthy", "gateway-connected"]),
      sinceStartMs: DurationMs.optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("body.service"),
      service: Code,
      state: z.enum(["healthy", "unhealthy", "restarting", "crashed"]),
      exitCode: z.number().int().min(-1).max(255).optional(),
      signal: Code.optional(),
      restarts: Count.optional(),
      reason: Code.optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("body.gateway"),
      state: z.enum(["connected", "disconnected", "sign_in_required"]),
      closeCode: z.number().int().min(1000).max(4999).optional(),
      retryInMs: DurationMs.optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("body.turn"),
      outcome: z.enum(["completed", "failed", "interrupted"]),
      durationMs: DurationMs.optional(),
      toolCalls: Count,
      mutatingCalls: Count,
      requestId: OpaqueId.optional(),
      deviceRef: OpaqueId.optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("body.resources"),
      cpuPct: Percent,
      memUsedPct: Percent,
      diskUsedPct: Percent.optional(),
      workspaceUsedPct: Percent.optional(),
      agents: Count.optional(),
      seats: Count.optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("body.heartbeat"),
      busy: z.boolean(),
      reasons: z.array(z.enum(["captain-turn", "herdr-agent", "scheduled-job"])).max(3),
      desired: z.enum(["running", "sleeping", "suspended"]).optional(),
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("body.shutdown"),
      reason: Code,
    })
    .strict(),
  z
    .object({
      ...envelope,
      event: z.literal("body.support"),
      grantId: OpaqueId,
      action: z.enum(["granted", "accessed", "revoked", "expired"]),
      scope: z.enum(["read-state", "shell"]),
      deviceRef: OpaqueId.optional(),
    })
    .strict(),
]);
export type BodyTelemetryEvent = z.infer<typeof BodyTelemetryEventSchema>;

/** What a caller hands in: the envelope is filled here. */
export type BodyTelemetryInput = BodyTelemetryEvent extends infer E
  ? E extends BodyTelemetryEvent
    ? Omit<E, "v" | "atMs"> & { readonly atMs?: number }
    : never
  : never;

export interface BodyTelemetry {
  /** Records one event. Never throws: telemetry must not break the body. */
  emit(event: BodyTelemetryInput): void;
}

/** Parses one spool line. Returns undefined for anything outside the schema. */
export function parseBodyTelemetryLine(line: string): BodyTelemetryEvent | undefined {
  if (line.length === 0 || Buffer.byteLength(line) > LINE_BYTES_MAX) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = BodyTelemetryEventSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** Spool files are `<UTC hour>-<writer>.jsonl`, so a name sorts by age. */
export function spoolFileName(atMs: number, writer: string): string {
  const hour = new Date(atMs).toISOString().slice(0, 13).replace(/[-T]/gu, "");
  return `${hour}-${writer}.jsonl`;
}

export function createBodyTelemetry(input: {
  readonly dir: string;
  /** One file per writing process: `service`, `body`, … */
  readonly writer: string;
  readonly clock?: () => number;
}): BodyTelemetry {
  const clock = input.clock ?? Date.now;
  if (!/^[a-z0-9-]{1,32}$/u.test(input.writer)) throw new Error("telemetry writer must be a short code");
  let currentFile: string | undefined;
  return {
    emit(event) {
      try {
        const parsed = BodyTelemetryEventSchema.safeParse({ ...event, v: 1, atMs: event.atMs ?? clock() });
        if (!parsed.success) return;
        const file = spoolFileName(parsed.data.atMs, input.writer);
        if (file !== currentFile) {
          mkdirSync(input.dir, { recursive: true, mode: 0o755 });
          pruneSpool(input.dir, clock());
          currentFile = file;
        }
        appendFileSync(join(input.dir, file), `${JSON.stringify(parsed.data)}\n`, { mode: 0o644 });
      } catch {
        // A full disk or unwritable spool loses telemetry, never the turn.
      }
    },
  };
}

/** Keeps the spool under its byte and age bounds, oldest hour first. */
export function pruneSpool(dir: string, nowMs: number): void {
  const oldest = spoolFileName(nowMs - SPOOL_HOURS_MAX * 3_600_000, "");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  let total = 0;
  const sized = files.map((name) => {
    const bytes = statSync(join(dir, name)).size;
    total += bytes;
    return { name, bytes };
  });
  for (const { name, bytes } of sized) {
    if (name >= oldest && total <= BODY_TELEMETRY_SPOOL_BYTES_MAX) break;
    rmSync(join(dir, name), { force: true });
    total -= bytes;
  }
}

/** The body's telemetry, or undefined when this process is not a configured body. */
export function bodyTelemetryFromEnv(env: NodeJS.ProcessEnv, writer: string): BodyTelemetry | undefined {
  const dir = env[BODY_TELEMETRY_DIR_ENV];
  return dir === undefined || dir.length === 0 ? undefined : createBodyTelemetry({ dir, writer });
}

/** Maps a settled captain turn to its telemetry: outcome, duration and counts only. */
export function turnTelemetry(metrics: {
  readonly outcome: "completed" | "failed" | "interrupted";
  readonly acceptedAt: string;
  readonly completedAt?: string | undefined;
  readonly failedAt?: string | undefined;
  readonly toolCount: Readonly<Record<string, number>>;
  readonly mutatingCount: number;
}): BodyTelemetryInput {
  const accepted = Date.parse(metrics.acceptedAt);
  const settledAt = metrics.completedAt ?? metrics.failedAt;
  const settled = settledAt === undefined ? Number.NaN : Date.parse(settledAt);
  const durationMs = settled - accepted;
  return {
    event: "body.turn",
    outcome: metrics.outcome,
    ...(Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
    // Counts only: tool names can be MCP server names the owner chose.
    toolCalls: Object.values(metrics.toolCount).reduce((sum, count) => sum + count, 0),
    mutatingCalls: metrics.mutatingCount,
    ...(Number.isFinite(settled) ? { atMs: settled } : {}),
  };
}

/**
 * Samples CPU, memory and disk pressure every `intervalMs` while the body
 * runs. `paths` are the volumes whose fullness matters (state, workspace).
 */
export function startResourceSampler(
  telemetry: BodyTelemetry,
  options: {
    readonly intervalMs?: number;
    readonly statePath?: string;
    readonly workspacePath?: string;
  } = {},
): () => void {
  const usedPct = (path: string | undefined) => {
    if (path === undefined) return undefined;
    try {
      const stats = statfsSync(path);
      return stats.blocks === 0 ? undefined : round((1 - stats.bavail / stats.blocks) * 100);
    } catch {
      return undefined;
    }
  };
  const sample = () => {
    const disk = usedPct(options.statePath);
    const workspace = usedPct(options.workspacePath);
    telemetry.emit({
      event: "body.resources",
      cpuPct: round(Math.min(100, (loadavg()[0]! / Math.max(1, cpus().length)) * 100)),
      memUsedPct: round((1 - freemem() / totalmem()) * 100),
      ...(disk === undefined ? {} : { diskUsedPct: disk }),
      ...(workspace === undefined ? {} : { workspaceUsedPct: workspace }),
    });
  };
  const timer = setInterval(sample, options.intervalMs ?? 5 * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
