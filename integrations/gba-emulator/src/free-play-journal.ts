/**
 * The durable trail of a playthrough: every decided turn, then a summary.
 *
 * `FreePlayTurn` already records what matters — monologue, intent, objective,
 * notes, action, outcome, effect — but until this journal existed the
 * production path built each record, pushed one overlay frame, and threw it
 * away. A playthrough you cannot reconstruct afterwards ("why did he spend
 * forty turns in Oak's lab?") is a playthrough that never generates feedback,
 * so the journal is append-only, one file per run, written as each turn
 * settles rather than at the end a crash would erase.
 *
 * Deliberately a sibling of the environment-session record, not a replacement:
 * that record is the runtime's operational state (lease, idempotency,
 * per-action outcomes) and rolls under retention; this journal is the
 * observability artifact and is never rewritten or pruned by code.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  FreePlayTurnEvidenceSchema,
  FreePlayTurnSchema,
  type FreePlayResult,
  type FreePlayTurn,
  type FreePlayTurnEvidence,
} from "./free-play.ts";

export const FreePlayJournalHeaderV1Schema = z
  .object({
    kind: z.literal("header"),
    schemaVersion: z.literal(1),
    /** The embodiment session (ADR 0063) or other run identity this journal names. */
    runId: z.string().min(1).max(200),
    /** The environment session the turns dispatched through. */
    environmentSessionId: z.string().min(1).max(200),
    scenarioId: z.string().min(1).max(200),
    startedAt: z.string().datetime(),
    resumedFromCheckpointId: z.string().max(200).nullable(),
  })
  .strict();
export const FreePlayJournalHeaderV2Schema = FreePlayJournalHeaderV1Schema.extend({
  schemaVersion: z.literal(2),
});
export const FreePlayJournalHeaderSchema = z.union([
  FreePlayJournalHeaderV1Schema,
  FreePlayJournalHeaderV2Schema,
]);
export type FreePlayJournalHeader = z.infer<typeof FreePlayJournalHeaderSchema>;

export const FreePlayJournalScreenshotSchema = z
  .object({
    /** Relative to the journal directory; image bytes stay out of the JSONL. */
    path: z.string().regex(/^\.screenshots\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.png$/u),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(512 * 1_024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    width: z.number().int().positive().max(4_096),
    height: z.number().int().positive().max(4_096),
    reasons: z
      .array(
        z.enum([
          "initial",
          "interval",
          "map_change",
          "scene_change",
          "objective_change",
          "noteworthy",
          "failure",
          "terminal",
        ]),
      )
      .min(1),
  })
  .strict();
export type FreePlayJournalScreenshot = z.infer<typeof FreePlayJournalScreenshotSchema>;

export const FreePlayJournalTurnV1Schema = z
  .object({
    kind: z.literal("turn"),
    schemaVersion: z.literal(1),
    /** When the turn settled. The turn record itself is deliberately clock-free. */
    at: z.string().datetime(),
    turn: FreePlayTurnSchema,
    /**
     * Join key for the possessor-voice delivery of this turn's room report.
     * Absent when the turn was not worth reporting. Same id as the voice
     * submission / response / suppressed receipts.
     */
    speechDeliveryId: z.string().min(1).max(128).regex(/^\S+$/u).optional(),
  })
  .strict();
export const FreePlayJournalTurnV2Schema = FreePlayJournalTurnV1Schema.extend({
  schemaVersion: z.literal(2),
  evidence: FreePlayTurnEvidenceSchema,
  screenshot: FreePlayJournalScreenshotSchema.optional(),
  /** Exact bounded event offered to the room, never the words the room generated. */
  narrationEvent: z.string().min(1).max(512).optional(),
}).superRefine((line, context) => {
  if ((line.speechDeliveryId === undefined) !== (line.narrationEvent === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["speechDeliveryId"],
      message: "speechDeliveryId and narrationEvent must be recorded together",
    });
  }
});
export const FreePlayJournalTurnSchema = z.union([FreePlayJournalTurnV1Schema, FreePlayJournalTurnV2Schema]);
export type FreePlayJournalTurn = z.infer<typeof FreePlayJournalTurnSchema>;

export const FreePlayJournalSummaryV1Schema = z
  .object({
    kind: z.literal("summary"),
    schemaVersion: z.literal(1),
    at: z.string().datetime(),
    outcome: z.string().min(1).max(64),
    turnsTaken: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    framesPublished: z.number().int().nonnegative(),
    framesDropped: z.number().int().nonnegative(),
    checkpointId: z.string().max(200).nullable(),
    progress: z
      .object({
        distinctTiles: z.number().int().nonnegative(),
        maps: z.array(z.string()),
        turnsSinceNewTile: z.number().int().nonnegative(),
        actionsPerNewTile: z.number().nullable(),
      })
      .strict(),
    volition: z
      .object({
        offered: z.number().int().nonnegative(),
        taken: z.number().int().nonnegative(),
        suppressed: z.number().int().nonnegative(),
        // Defaulted, not required: journals written before the consultation
        // gate existed carry no skip count, and they must keep parsing.
        skipped: z.number().int().nonnegative().default(0),
      })
      .strict(),
    coherence: z.number().min(0).max(1).nullable(),
    // Defaulted for the same reason the volition skip count is: journals
    // written before the repeat counter existed must keep parsing.
    longestUnchangedRun: z.number().int().nonnegative().default(0),
    longestRecurringRun: z.number().int().nonnegative().default(0),
    objectivesRetired: z.number().int().nonnegative().default(0),
  })
  .strict();
export const FreePlayJournalSummaryV2Schema = FreePlayJournalSummaryV1Schema.extend({
  schemaVersion: z.literal(2),
  screenshot: FreePlayJournalScreenshotSchema.optional(),
});
export const FreePlayJournalSummarySchema = z.union([
  FreePlayJournalSummaryV1Schema,
  FreePlayJournalSummaryV2Schema,
]);
export type FreePlayJournalSummary = z.infer<typeof FreePlayJournalSummarySchema>;

export const FreePlayJournalLineSchema = z.union([
  FreePlayJournalHeaderV1Schema,
  FreePlayJournalHeaderV2Schema,
  FreePlayJournalTurnV1Schema,
  FreePlayJournalTurnV2Schema,
  FreePlayJournalSummaryV1Schema,
  FreePlayJournalSummaryV2Schema,
]);
export type FreePlayJournalLine = z.infer<typeof FreePlayJournalLineSchema>;

/** Mirrors `defaultGbaBodyRootDir`: one well-known operator-local home. */
export function defaultGbaPlayJournalDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CLANKIE_GBA_PLAY_JOURNAL_DIR"];
  if (override !== undefined && override.length > 0) {
    mkdirSync(override, { recursive: true });
    return override;
  }
  const stateHome =
    env["XDG_STATE_HOME"] !== undefined && env["XDG_STATE_HOME"].length > 0
      ? env["XDG_STATE_HOME"]
      : path.join(homedir(), ".local", "state");
  const root = path.join(stateHome, "clankie", "gba-play");
  mkdirSync(root, { recursive: true });
  return root;
}

export interface OpenFreePlayJournalInput {
  rootDir: string;
  runId: string;
  environmentSessionId: string;
  scenarioId: string;
  resumedFromCheckpointId?: string | undefined;
  clock?: () => Date;
  /**
   * Where a failed append lands. Opening throws — a journal that cannot be
   * created should be decided about by the caller — but once play is running a
   * full disk must cost the record, never the playthrough, so appends report
   * here instead of throwing. Absent, append errors propagate.
   */
  onError?: (error: unknown) => void;
}

export interface FreePlayJournal {
  readonly path: string;
  turn(
    turn: FreePlayTurn,
    evidence: FreePlayTurnEvidence,
    extras?: {
      readonly speechDeliveryId?: string;
      readonly narrationEvent?: string;
      /** Read lazily only when this turn meets the bounded screenshot policy. */
      readonly framePng?: () => Uint8Array | null;
    },
  ): void;
  summary(input: {
    outcome: string;
    result: FreePlayResult;
    durationMs: number;
    framesPublished: number;
    framesDropped: number;
    checkpointId?: string | undefined;
    framePng?: (() => Uint8Array | null) | undefined;
  }): void;
}

/**
 * One journal per run: the filename carries the start stamp and the run id, so
 * runs never overwrite each other and sorting the directory is sorting history.
 */
export function openFreePlayJournal(input: OpenFreePlayJournalInput): FreePlayJournal {
  const clock = input.clock ?? (() => new Date());
  const startedAt = clock();
  const stamp = startedAt.toISOString().replace(/[:.]/gu, "-");
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 120);
  const journalStem = `${stamp}-${safeRunId}`;
  const journalPath = path.join(input.rootDir, `${journalStem}.jsonl`);
  const screenshotDir = path.join(input.rootDir, ".screenshots", journalStem);
  let turnScreenshots = 0;

  mkdirSync(input.rootDir, { recursive: true });
  appendLine(
    journalPath,
    FreePlayJournalHeaderSchema.parse({
      kind: "header",
      schemaVersion: 2,
      runId: input.runId,
      environmentSessionId: input.environmentSessionId,
      scenarioId: input.scenarioId,
      startedAt: startedAt.toISOString(),
      resumedFromCheckpointId: input.resumedFromCheckpointId ?? null,
    }),
  );

  const append = (line: FreePlayJournalLine): void => {
    try {
      appendLine(journalPath, line);
    } catch (error) {
      if (input.onError === undefined) throw error;
      input.onError(error);
    }
  };

  const screenshot = (
    name: string,
    reasons: FreePlayJournalScreenshot["reasons"],
    framePng: (() => Uint8Array | null) | undefined,
  ): FreePlayJournalScreenshot | undefined => {
    if (framePng === undefined || reasons.length === 0) return undefined;
    try {
      const png = framePng();
      if (png === null) return undefined;
      const bytes = Buffer.from(png);
      const { width, height } = pngDimensions(bytes);
      if (bytes.byteLength > 512 * 1_024) throw new Error("free_play_screenshot_too_large");
      mkdirSync(screenshotDir, { recursive: true, mode: 0o700 });
      const filename = `${name}-${reasons.join("-")}.png`;
      const screenshotPath = path.join(screenshotDir, filename);
      writeFileSync(screenshotPath, bytes, { flag: "wx", mode: 0o600 });
      return FreePlayJournalScreenshotSchema.parse({
        path: path.relative(input.rootDir, screenshotPath).split(path.sep).join(path.posix.sep),
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width,
        height,
        reasons,
      });
    } catch (error) {
      if (input.onError === undefined) throw error;
      input.onError(error);
      return undefined;
    }
  };

  return {
    path: journalPath,
    turn: (turn, evidence, extras) => {
      const reasons = screenshotReasons(turn, evidence);
      const captured =
        turnScreenshots >= 63
          ? undefined
          : screenshot(`turn-${String(turn.turn).padStart(6, "0")}`, reasons, extras?.framePng);
      if (captured !== undefined) turnScreenshots += 1;
      append(
        FreePlayJournalTurnV2Schema.parse({
          kind: "turn",
          schemaVersion: 2,
          at: clock().toISOString(),
          turn,
          evidence,
          ...(captured === undefined ? {} : { screenshot: captured }),
          ...(extras?.speechDeliveryId === undefined ? {} : { speechDeliveryId: extras.speechDeliveryId }),
          ...(extras?.narrationEvent === undefined ? {} : { narrationEvent: extras.narrationEvent }),
        }),
      );
    },
    summary: ({ outcome, result, durationMs, framesPublished, framesDropped, checkpointId, framePng }) => {
      const captured = screenshot("terminal", ["terminal"], framePng);
      append(
        FreePlayJournalSummaryV2Schema.parse({
          kind: "summary",
          schemaVersion: 2,
          at: clock().toISOString(),
          outcome,
          turnsTaken: result.turns.length,
          accepted: result.accepted,
          durationMs,
          framesPublished,
          framesDropped,
          checkpointId: checkpointId ?? null,
          ...(captured === undefined ? {} : { screenshot: captured }),
          progress: result.progress,
          volition: result.volition,
          coherence: result.coherence,
          longestUnchangedRun: result.longestUnchangedRun,
          longestRecurringRun: result.longestRecurringRun,
          objectivesRetired: result.objectivesRetired,
        }),
      );
    },
  };
}

function screenshotReasons(
  turn: FreePlayTurn,
  evidence: FreePlayTurnEvidence,
): FreePlayJournalScreenshot["reasons"] {
  const reasons: FreePlayJournalScreenshot["reasons"] = [];
  if (turn.turn === 0) reasons.push("initial");
  else if (turn.turn % 25 === 0) reasons.push("interval");
  const before = evidence.immediatePreAction?.observations.map((observation) => observation.kind).join(",");
  const after = evidence.postAction?.observations.map((observation) => observation.kind).join(",");
  if (before !== undefined && after !== undefined && before !== after) reasons.push("scene_change");
  const beforeMap = evidence.progressBefore.maps.at(-1);
  const afterMap = evidence.progressAfter?.maps.at(-1);
  if (afterMap !== undefined && beforeMap !== afterMap) reasons.push("map_change");
  if (
    turn.objectiveRetired !== null ||
    (evidence.signals.previousObjective !== null && evidence.signals.previousObjective !== turn.objective)
  ) {
    reasons.push("objective_change");
  }
  if (turn.speakWanted) reasons.push("noteworthy");
  if (turn.outcome !== "accepted") reasons.push("failure");
  return reasons;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("free_play_screenshot_invalid_png");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4_096 || height > 4_096) {
    throw new Error("free_play_screenshot_invalid_dimensions");
  }
  return { width, height };
}

/** Parse a journal file's lines. Corrupt lines throw: a lying record is worse than none. */
export function parseFreePlayJournal(contents: string): FreePlayJournalLine[] {
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => FreePlayJournalLineSchema.parse(JSON.parse(line)));
}

function appendLine(journalPath: string, line: FreePlayJournalLine): void {
  const serialized = `${JSON.stringify(line)}\n`;
  if (Buffer.byteLength(serialized) > 256 * 1_024) throw new Error("free_play_journal_line_too_large");
  appendFileSync(journalPath, serialized, { encoding: "utf8", mode: 0o600 });
}
