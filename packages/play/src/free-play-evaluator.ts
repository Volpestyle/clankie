import { intentMatchesAction, type FreePlayAction, type FreePlayTurnEvidence } from "./free-play.ts";
import { parseFreePlayJournal, type FreePlayJournalLine } from "./free-play-journal.ts";
import { positionOf } from "./free-play-progress.ts";

type Verdict = "aligned" | "misaligned" | "unknown";
type MovementVerdict = "effective" | "ineffective" | "not_applicable" | "unknown";
type AppropriatenessVerdict = "appropriate" | "inappropriate" | "unknown";
type RecoveryVerdict = "recovered" | "changed_without_success" | "repeated" | "not_applicable" | "unknown";
export type NarrationVerdict =
  | "no_attempt"
  | "attempted_no_receipt"
  | "suppressed"
  | "model_silent"
  | "played"
  | "unspoken"
  | "failed"
  | "refused";

export interface EvaluateFreePlayJournalInput {
  readonly journal: string;
  readonly lifecycleEvents?: string;
  readonly voiceReceipts?: string;
}

/** Offline, deterministic projection of a production play journal and optional joined trails. */
export function evaluateFreePlayJournal(input: EvaluateFreePlayJournalInput) {
  const lines = parseFreePlayJournal(input.journal);
  const header = lines.find((line) => line.kind === "header");
  if (header === undefined || header.kind !== "header")
    throw new Error("free_play_evaluation_missing_header");
  const turns = lines.filter((line) => line.kind === "turn");
  const voiceReceipts = parseJsonLines(input.voiceReceipts);
  const lifecycle = terminalLifecycle(input.lifecycleEvents, header.runId);
  const summary = [...lines].reverse().find((line) => line.kind === "summary");

  const perTurn = turns.map((line, index) => {
    const previous = turns[index - 1];
    const next = turns[index + 1];
    const evidence = line.schemaVersion === 2 ? line.evidence : null;
    const start = evidence?.immediatePreAction ? positionOf(evidence.immediatePreAction.observations) : null;
    const end = evidence?.postAction ? positionOf(evidence.postAction.observations) : null;
    const movement = movementEvidence(line.turn.action, line.turn.outcome, start, end);
    return {
      turn: line.turn.turn,
      at: line.at,
      decision: {
        monologue: line.turn.monologue,
        objective: line.turn.objective,
        objectiveRetired: line.turn.objectiveRetired,
        intent: line.turn.intent,
        notes: line.turn.notes,
        action: line.turn.action,
        outcome: line.turn.outcome,
        effect: line.turn.effect,
        effectAdvice: line.turn.effectAdvice,
      },
      evidence,
      movement,
      communication: {
        deliveryId: line.speechDeliveryId ?? null,
        narrationEvent: line.schemaVersion === 2 ? (line.narrationEvent ?? null) : null,
        matchingReceiptTypes:
          line.speechDeliveryId === undefined
            ? []
            : matchingReceiptTypes(line.speechDeliveryId, voiceReceipts),
      },
      verdicts: {
        intentToAction: intentAlignment(line.turn.intent, line.turn.action),
        goalToAction: goalAlignment(line.turn.objective, line.turn.action),
        planContinuity: planContinuity(previous, line),
        sceneActionAppropriateness: sceneAppropriateness(line),
        movementEffectiveness: movement.effectiveness,
        rejectionRecovery: rejectionRecovery(line, next),
        narration: narrationVerdict(line, voiceReceipts),
      },
      timing: timing(evidence?.timing ?? null),
    };
  });

  const summaryLine = summary?.kind === "summary" ? summary : undefined;
  const terminal =
    summaryLine !== undefined
      ? {
          source: "summary" as const,
          outcome: summaryLine.outcome,
          at: summaryLine.at,
          summaryPresent: true,
          lifecycleEventType: lifecycle?.type ?? null,
          lifecycleConsistent:
            lifecycle?.outcome === undefined ? null : lifecycle.outcome === summaryLine.outcome,
        }
      : lifecycle !== null
        ? {
            source: "lifecycle" as const,
            outcome: lifecycle.outcome,
            at: lifecycle.occurredAt,
            summaryPresent: false,
            lifecycleEventType: lifecycle.type,
            lifecycleConsistent: null,
          }
        : {
            source: "unknown" as const,
            outcome: null,
            at: null,
            summaryPresent: false,
            lifecycleEventType: null,
            lifecycleConsistent: null,
          };

  return {
    schemaVersion: 1 as const,
    run: {
      runId: header.runId,
      scenarioId: header.scenarioId,
      journalSchemaVersion: header.schemaVersion,
      startedAt: header.startedAt,
      terminal,
    },
    aggregate: {
      turns: turns.length,
      outcomes: countValues(turns.map((line) => line.turn.outcome)),
      timing: aggregateTiming(perTurn.map((turn) => turn.timing)),
      intentToAction: countValues(perTurn.map((turn) => turn.verdicts.intentToAction)),
      goalToAction: countValues(perTurn.map((turn) => turn.verdicts.goalToAction)),
      movementEffectiveness: countValues(perTurn.map((turn) => turn.verdicts.movementEffectiveness)),
      sceneActionAppropriateness: countValues(
        perTurn.map((turn) => turn.verdicts.sceneActionAppropriateness),
      ),
      rejectionRecovery: countValues(perTurn.map((turn) => turn.verdicts.rejectionRecovery)),
      narration: countValues(perTurn.map((turn) => turn.verdicts.narration)),
      stalls: {
        signalledTurns: perTurn.filter((turn) => typeof turn.evidence?.signals.stalledForTurns === "number")
          .length,
        maxTurnsSinceNewTile: maximum(
          perTurn.map((turn) => turn.evidence?.progressBefore.turnsSinceNewTile ?? null),
        ),
        maxRepeatedTurns: maximum(perTurn.map((turn) => turn.evidence?.signals.repeatingForTurns ?? null)),
        maxRecurringTurns: maximum(perTurn.map((turn) => turn.evidence?.signals.recurringForTurns ?? null)),
      },
      summary: summaryLine ?? null,
    },
    turns: perTurn,
  };
}

function movementEvidence(
  action: FreePlayAction | null,
  outcome: string,
  start: ReturnType<typeof positionOf>,
  end: ReturnType<typeof positionOf>,
) {
  const movement =
    action?.kind === "walk_to" ||
    (action?.kind === "button_press" && ["up", "down", "left", "right"].includes(action.button));
  const target = action?.kind === "walk_to" ? { x: action.x, y: action.y } : null;
  let effectiveness: MovementVerdict = "not_applicable";
  if (movement) {
    if (start === null || end === null) effectiveness = "unknown";
    else if (outcome !== "accepted") effectiveness = "ineffective";
    else if (start.mapId !== end.mapId || start.x !== end.x || start.y !== end.y) effectiveness = "effective";
    else effectiveness = "ineffective";
  }
  return { attempted: movement, start, target, end, effectiveness };
}

// Intent describes the action it is written beside, so alignment is a
// self-consistency check: did he do what he said he was doing. Scoring it
// against the *next* turn's action instead measured plan stickiness, which
// inverted the signal — adapting to a failed press read as misaligned while
// repeating a rejected one read as aligned.
function intentAlignment(intent: string | null, action: FreePlayAction | null): Verdict {
  if (intent === null || action === null) return "unknown";
  return intentMatchesAction(intent, action) ? "aligned" : "misaligned";
}

function goalAlignment(objective: string | null, action: FreePlayAction | null): Verdict {
  if (objective === null || action === null) return "unknown";
  // Objectives are intentionally broader than one input. A keyword match is
  // positive evidence; absence is not proof the action is contrary to the goal.
  return intentMatchesAction(objective, action) ? "aligned" : "unknown";
}

function planContinuity(
  previous: Extract<FreePlayJournalLine, { kind: "turn" }> | undefined,
  current: Extract<FreePlayJournalLine, { kind: "turn" }>,
): "continued" | "changed" | "cleared" | "unknown" {
  if (previous === undefined || previous.turn.objective === null) return "unknown";
  if (current.turn.objective === null) return "cleared";
  return previous.turn.objective === current.turn.objective ? "continued" : "changed";
}

function sceneAppropriateness(line: Extract<FreePlayJournalLine, { kind: "turn" }>): AppropriatenessVerdict {
  if (line.schemaVersion !== 2 || line.turn.action === null) return "unknown";
  const scene = line.evidence.decision.observations.find((observation) => observation.kind === "scene") as
    | { data?: { mode?: string; inputReady?: boolean; waitingForDialogAdvance?: boolean } }
    | undefined;
  const mode = scene?.data?.mode;
  const action = line.turn.action;
  if (mode === undefined) return "unknown";
  if (action.kind === "walk_to")
    return mode === "overworld" && scene?.data?.inputReady === true ? "appropriate" : "inappropriate";
  if (action.kind === "enter_text") return mode === "naming" ? "appropriate" : "inappropriate";
  if (action.kind === "select_menu_entry") return mode === "menu" ? "appropriate" : "inappropriate";
  if (action.kind === "advance_dialog") {
    return mode === "dialog" ||
      mode === "battle" ||
      scene?.data?.waitingForDialogAdvance === true ||
      scene?.data?.inputReady === false
      ? "appropriate"
      : "inappropriate";
  }
  if (mode === "unknown") {
    return action.kind === "button_press" || action.kind === "frame_advance"
      ? "appropriate"
      : "inappropriate";
  }
  return "unknown";
}

function rejectionRecovery(
  line: Extract<FreePlayJournalLine, { kind: "turn" }>,
  next: Extract<FreePlayJournalLine, { kind: "turn" }> | undefined,
): RecoveryVerdict {
  if (line.turn.outcome !== "rejected_by_adapter") return "not_applicable";
  if (next?.turn.action == null || line.turn.action === null) return "unknown";
  if (JSON.stringify(next.turn.action) === JSON.stringify(line.turn.action)) return "repeated";
  return next.turn.outcome === "accepted" ? "recovered" : "changed_without_success";
}

function narrationVerdict(
  line: Extract<FreePlayJournalLine, { kind: "turn" }>,
  receipts: readonly Record<string, unknown>[],
): NarrationVerdict {
  const deliveryId = line.speechDeliveryId;
  if (deliveryId === undefined) {
    if (line.turn.speakSuppressed) return "suppressed";
    if (line.turn.action !== null && !line.turn.speakWanted) return "model_silent";
    return "no_attempt";
  }
  const matching = receipts.filter((receipt) => receiptData(receipt)["deliveryId"] === deliveryId);
  if (matching.some((receipt) => receipt["type"] === "discord.voice.response")) return "played";
  if (matching.some((receipt) => isPlayReceipt(receipt, "narration_suppressed"))) {
    return "suppressed";
  }
  if (matching.some((receipt) => isPlayReceipt(receipt, "refusal"))) return "refused";
  // A narration the gate let through still has a terminal model_response even
  // when nothing was ever audible. Reading it separates "he was asked and
  // answered with nothing" from a genuinely missing trail.
  const settled = matching.filter((receipt) => {
    const phase = receiptData(receipt)["phase"];
    return (
      receipt["type"] === "discord.voice.model_response" && (phase === "completed" || phase === "failed")
    );
  });
  const terminal = settled.at(-1);
  if (terminal !== undefined) {
    return receiptData(terminal)["phase"] === "failed" ? "failed" : "unspoken";
  }
  return "attempted_no_receipt";
}

function isPlayReceipt(
  receipt: Record<string, unknown>,
  suffix: "narration_suppressed" | "refusal",
): boolean {
  return (
    receipt["type"] === `discord.voice.play_${suffix}` ||
    // Historical receipt logs remain evaluable; current runtime writes only play_*.
    receipt["type"] === `discord.voice.possessor_${suffix}`
  );
}

function matchingReceiptTypes(deliveryId: string, receipts: readonly Record<string, unknown>[]): string[] {
  return receipts
    .filter((receipt) => receiptData(receipt)["deliveryId"] === deliveryId)
    .flatMap((receipt) => (typeof receipt["type"] === "string" ? [receipt["type"]] : []));
}

function timing(value: FreePlayTurnEvidence["timing"] | null) {
  if (value === null) return { decisionMs: null, actionMs: null };
  return {
    decisionMs: elapsed(value.decisionStartedAt, value.decisionSettledAt),
    actionMs:
      value.actionStartedAt === null || value.actionSettledAt === null
        ? null
        : elapsed(value.actionStartedAt, value.actionSettledAt),
  };
}

function elapsed(start: string, end: string): number | null {
  const duration = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function aggregateTiming(values: readonly { decisionMs: number | null; actionMs: number | null }[]) {
  return {
    decision: durationSummary(values.map((value) => value.decisionMs)),
    action: durationSummary(values.map((value) => value.actionMs)),
  };
}

function durationSummary(values: readonly (number | null)[]) {
  const known = values.filter((value): value is number => value !== null);
  return {
    known: known.length,
    unknown: values.length - known.length,
    totalMs: known.length === 0 ? null : known.reduce((total, value) => total + value, 0),
    averageMs: known.length === 0 ? null : known.reduce((total, value) => total + value, 0) / known.length,
  };
}

function terminalLifecycle(contents: string | undefined, runId: string) {
  const terminal = parseJsonLines(contents).filter((event) => {
    const type = event["type"];
    const data = receiptData(event);
    return (
      data["sessionId"] === runId &&
      (type === "embodiment.session.stopped" || type === "embodiment.session.failed")
    );
  });
  const event = terminal.at(-1);
  if (event === undefined) return null;
  const data = receiptData(event);
  const type = String(event["type"]);
  return {
    type,
    occurredAt: typeof event["occurredAt"] === "string" ? event["occurredAt"] : null,
    outcome:
      typeof data["outcome"] === "string"
        ? data["outcome"]
        : type === "embodiment.session.failed"
          ? "failed"
          : "stopped",
  };
}

function parseJsonLines(contents: string | undefined): Record<string, unknown>[] {
  if (contents === undefined) return [];
  const records: Record<string, unknown>[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        records.push(value as Record<string, unknown>);
      }
    } catch {
      // Optional operational logs tolerate torn or unrelated lines. The
      // canonical journal remains strict in parseFreePlayJournal.
    }
  }
  return records;
}

function receiptData(receipt: Record<string, unknown>): Record<string, unknown> {
  const data = receipt["data"];
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function countValues(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function maximum(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}
