/** One driver's observe/decide/act/verify/remember loop; the host owns its lease. */
import { randomUUID } from "node:crypto";
import {
  openPlayJournalSink,
  runPlayKernel,
  settlePlayDecision,
  playFailureBackoff,
  playSpeechReady,
  InterjectionQueue,
  PlayJourneyIdSchema,
  emptyFreePlayUsage,
  unreportedFreePlayUsage,
  addFreePlayUsage,
} from "@clankie/play";
import { createBrokeredPlayVoiceClient, type PlayVoiceClient } from "@clankie/play-voice";
import {
  MinecraftObservationSchema,
  MinecraftActionStatusSchema,
  MinecraftSessionRefSchema,
  type MinecraftObservation,
  type MinecraftActionStatus,
  type MinecraftActionRequest,
  type MinecraftSessionRef,
} from "@clankie/protocol";
import { roomEvent } from "@clankie/game-extension";
import {
  MinecraftPlayDecisionSchema,
  MinecraftPlayMindError,
  withAbort,
  type MinecraftPlayDecision,
  type MinecraftPlayMind,
  type MinecraftPlayUsage,
} from "./minecraft-play-mind.ts";

interface MinecraftPlayBody {
  observe(): Promise<MinecraftObservation>;
  /** Active phase + exact connection/driver generation identity, or an inactive phase. */
  mode(): Promise<string>;
  act(request: MinecraftActionRequest): Promise<MinecraftActionStatus>;
  actionStatus(actionId: string): Promise<MinecraftActionStatus | null>;
  cancel(actionId: string): Promise<MinecraftActionStatus>;
}
export type MinecraftPlayNotable = {
  kind: "stuck" | "objective_retired_twice" | "mind_unavailable" | "world_ended";
  session: MinecraftSessionRef;
  turn: number;
  objective: string | null;
};
type MinecraftPlayOutcome = "stopped" | "budget_exhausted" | "idle" | "mind_unavailable" | "world_ended";
export interface MinecraftPlayTurn {
  turn: number;
  decision: MinecraftPlayDecision | null;
  outcome: "settled" | "waited" | "mind_failed" | "stale_decision" | "action_failed" | "budget_exhausted";
  effect: string;
  action: MinecraftActionStatus | null;
  preemptions: number;
  usage: MinecraftPlayUsage[];
}
export interface RunMinecraftPlayInput {
  session: MinecraftSessionRef;
  journeyId: string;
  body: MinecraftPlayBody;
  mind: MinecraftPlayMind;
  journalRoot: string;
  budget: { maxTokens: number; maxCostUsd: number; maxTurns?: number; maxDurationMs?: number };
  shouldStop: () => boolean;
  signal?: AbortSignal;
  interjections?: InterjectionQueue;
  createVoice?: () => Promise<PlayVoiceClient | undefined>;
  onNotable?: (event: MinecraftPlayNotable) => void | Promise<void>;
  onTurn?: (turn: MinecraftPlayTurn) => void;
  turnIntervalMs?: number;
  idleBackoffMs?: number;
  idleStopMs?: number;
  actionSliceMs?: number;
  failureBackoffMs?: number;
  maxMindFailures?: number;
  speakCooldownTurns?: number;
  initialNotes?: string | null;
  initialObjective?: string | null;
}
export interface MinecraftPlayResult {
  outcome: MinecraftPlayOutcome;
  turnsTaken: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  unknownUsageCalls: number;
  journalPath: string;
  notes: string | null;
  objective: string | null;
}
export async function runMinecraftPlay(input: RunMinecraftPlayInput): Promise<MinecraftPlayResult> {
  MinecraftSessionRefSchema.parse(input.session);
  PlayJourneyIdSchema.parse(input.journeyId);
  if (
    !Number.isFinite(input.budget.maxTokens) ||
    input.budget.maxTokens <= 0 ||
    !Number.isFinite(input.budget.maxCostUsd) ||
    input.budget.maxCostUsd <= 0
  )
    throw new Error("Minecraft play budget invalid");
  const startedAt = Date.now();
  const runId = randomUUID();
  const journal = openPlayJournalSink({
    rootDir: input.journalRoot,
    identity: {
      runId,
      journeyId: input.journeyId,
      environmentId: "minecraft",
      environmentSessionId: input.session.sessionId,
      venue: "world",
    },
  });
  const journalPath = journal.path;
  const append = (value: { kind: string; [key: string]: unknown }) =>
    journal.append({
      ...value,
      connectionGeneration: input.session.connectionGeneration,
    });
  append({
    kind: "header",
    scenarioId: "free-play",
    resumedFromCheckpointId: null,
    startedAt: new Date(startedAt).toISOString(),
    budget: input.budget,
  });
  const interjections = input.interjections ?? new InterjectionQueue();
  const voice = await (input.createVoice ?? createBrokeredPlayVoiceClient)();
  const unsubscribe = voice?.subscribe((utterance) => interjections.offer(utterance));
  let notes = input.initialNotes ?? null;
  let objective = input.initialObjective ?? null;
  const retiredObjectives: string[] = [];
  const history: { turn: number; intent: string; outcome: string; effect: string }[] = [];
  let inputTokens = 0,
    outputTokens = 0,
    costUsd = 0,
    unknownUsageCalls = 0;
  const totalUsage = emptyFreePlayUsage();
  let accepted = 0;
  let heard: string | null = null;
  let speakSuppressed = false;
  let turn = 0,
    mindFailures = 0,
    actionFailures = 0,
    stalledForTurns = 0,
    unchangedTurns = 0;
  let lastSpoke: number | null = null;
  let lastProgress = "";
  let lastPresenceAt = startedAt;
  let activeAction: string | null = null;
  let outcome: MinecraftPlayOutcome = "stopped";
  const stop = () => input.shouldStop() || input.signal?.aborted === true;
  const exhausted = () =>
    inputTokens + outputTokens >= input.budget.maxTokens ||
    costUsd >= input.budget.maxCostUsd ||
    turn >= (input.budget.maxTurns ?? Number.MAX_SAFE_INTEGER) ||
    (input.budget.maxDurationMs !== undefined && Date.now() - startedAt >= input.budget.maxDurationMs);
  const account = (usage: MinecraftPlayUsage) => {
    if (!usage.known) {
      addFreePlayUsage(totalUsage, unreportedFreePlayUsage());
      unknownUsageCalls++;
      append({ kind: "usage", turn, usage });
      return;
    }
    if (
      !Number.isSafeInteger(usage.inputTokens) ||
      usage.inputTokens < 0 ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < 0 ||
      !Number.isFinite(usage.costUsd) ||
      usage.costUsd < 0
    )
      throw new Error("Minecraft play usage invalid");
    addFreePlayUsage(totalUsage, {
      calls: 1,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      chargedTokens: usage.inputTokens + usage.outputTokens,
      estimatedCostUsd: usage.costUsd,
      unreportedCalls: 0,
    });
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    costUsd += usage.costUsd;
    append({ kind: "usage", turn, usage });
  };
  const notable = (kind: MinecraftPlayNotable["kind"]) => {
    const event = { kind, session: input.session, turn, objective };
    append({ kind: "notable", event });
    void Promise.resolve()
      .then(() => input.onNotable?.(event))
      .catch(() => {});
  };
  const unavailableWorld = () => {
    if (stop()) outcome = "stopped";
    else {
      outcome = "world_ended";
      notable("world_ended");
    }
  };
  const worldEnded = () => outcome === "world_ended";
  const wait = async (ms: number, wakeForMessages = false) => {
    const end = Date.now() + Math.max(0, ms);
    while (!stop() && !exhausted() && Date.now() < end && !(wakeForMessages && interjections.hasPending()))
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, end - Date.now())));
  };
  const observe = async () => {
    const observation = MinecraftObservationSchema.parse(await input.body.observe());
    if (
      observation.session.sessionId !== input.session.sessionId ||
      observation.session.connectionGeneration !== input.session.connectionGeneration
    )
      throw new Error("Minecraft play observation stale");
    return observation;
  };
  const settled = (
    record: MinecraftPlayTurn,
    before: MinecraftObservation,
    after?: MinecraftObservation,
    narration?: { event: string; speechDeliveryId?: string },
  ) => {
    append({
      kind: "turn",
      turn: record,
      before,
      memory: { notes, objective },
      interjection: heard,
      speakSuppressed,
      ...(after ? { after } : {}),
      ...(narration ? { narrationEvent: narration.event, speechDeliveryId: narration.speechDeliveryId } : {}),
    });
    if (record.decision)
      history.push({
        turn: record.turn,
        intent: record.decision.intent,
        outcome: record.outcome,
        effect: record.effect,
      });
    if (history.length > 12) history.shift();
    input.onTurn?.(record);
    turn++;
  };
  try {
    await runPlayKernel({
      maxTurns: input.budget.maxTurns ?? Number.MAX_SAFE_INTEGER,
      shouldStop: () => stop() || worldEnded(),
      budgetReached: exhausted,
      prepare: async () => {
        let observation: MinecraftObservation;
        let mode: string;
        try {
          observation = await observe();
          mode = await input.body.mode();
        } catch {
          unavailableWorld();
          return null;
        }
        if (!mode.startsWith("active")) {
          unavailableWorld();
          return null;
        }
        const self =
          observation.facts.find((entry) => entry.fact.type === "health")?.fact ??
          observation.facts.find((entry) => entry.fact.type === "position")?.fact;
        const players = observation.facts.filter(
          (entry) =>
            entry.fact.type === "position" &&
            !(self && "player" in self && entry.fact.player === self.player),
        ).length;
        if (players > 0 || interjections.hasPending()) lastPresenceAt = Date.now();
        if (players === 0 && Date.now() - lastPresenceAt >= (input.idleStopMs ?? 900000)) {
          outcome = "idle";
          return null;
        }
        const progress = progressKey(observation);
        unchangedTurns = progress === lastProgress ? unchangedTurns + 1 : 0;
        lastProgress = progress;
        let interjection = interjections.take();
        heard = interjection;
        speakSuppressed = false;
        const record: MinecraftPlayTurn = {
          turn,
          decision: null,
          outcome: "mind_failed",
          effect: "No decision settled.",
          action: null,
          preemptions: 0,
          usage: [],
        };
        let fresh!: MinecraftObservation;
        let freshMode!: string;
        let decision!: MinecraftPlayDecision;
        let after!: MinecraftObservation;
        return {
          decide: async () => {
            let failed = false;
            let accountingUnavailable = false;
            await settlePlayDecision({
              interjections,
              abortOnInterjection: false,
              signal: input.signal,
              monitorStop: true,
              shouldStop: () => stop() || exhausted(),
              propose: async (signal) => {
                let usageRecorded = false;
                try {
                  const result = await withAbort(
                    input.mind.decide(
                      {
                        turn,
                        observation,
                        mode,
                        nearbyPlayers: players,
                        interjection,
                        notes,
                        objective,
                        turnsSinceSpoke: lastSpoke === null ? null : turn - lastSpoke,
                        stalledForTurns,
                        retiredObjectives: [...retiredObjectives],
                        history: [...history],
                        remainingBudget: {
                          tokens: Math.max(1, input.budget.maxTokens - inputTokens - outputTokens),
                          costUsd: Math.max(0, input.budget.maxCostUsd - costUsd),
                        },
                      },
                      signal,
                    ),
                    signal,
                  );
                  account(result.usage);
                  record.usage.push(result.usage);
                  usageRecorded = true;
                  if (!result.usage.known) throw new Error("Minecraft play usage unavailable");
                  record.decision = MinecraftPlayDecisionSchema.parse(result.decision);
                  append({
                    kind: "decision",
                    turn,
                    attempt: record.preemptions,
                    mode,
                    interjection,
                    observation,
                    decision: record.decision,
                  });
                  failed = false;
                } catch (error) {
                  const usage =
                    error instanceof MinecraftPlayMindError
                      ? error.usage
                      : { inputTokens: 0, outputTokens: 0, costUsd: 0, known: false };
                  if (!usageRecorded) {
                    account(usage);
                    record.usage.push(usage);
                  }
                  accountingUnavailable = record.usage.at(-1)?.known !== true;
                  failed = true;
                }
              },
              inspect: async (attempt) => {
                if (accountingUnavailable) {
                  if (attempt.interrupted) record.preemptions++;
                  return "settled";
                }
                return attempt.interrupted && attempt.mayPreempt ? "interjection" : "settled";
              },
              onCounters: (preemptions) => {
                record.preemptions = preemptions;
              },
              retry: async () => {
                interjection = interjections.take() ?? interjection;
                heard = interjection;
                try {
                  observation = await observe();
                  mode = await input.body.mode();
                  if (!mode.startsWith("active")) {
                    unavailableWorld();
                    return false;
                  }
                } catch {
                  unavailableWorld();
                  return false;
                }
              },
            });
            if (stop()) return "stop";
            if (worldEnded()) return "stop";
            if (exhausted()) {
              record.outcome = "budget_exhausted";
              record.effect = "Decision usage reached the session budget; no action issued.";
              settled(record, observation);
              outcome = "budget_exhausted";
              return "stop";
            }
            if (accountingUnavailable) {
              record.effect = "Decision usage unavailable; no further calls or actions issued.";
              settled(record, observation);
              outcome = "mind_unavailable";
              notable("mind_unavailable");
              return "stop";
            }
            if (failed || !record.decision) {
              mindFailures++;
              settled(record, observation);
              if (mindFailures >= (input.maxMindFailures ?? 3)) {
                outcome = "mind_unavailable";
                notable("mind_unavailable");
                return "stop";
              }
              await wait(playFailureBackoff(mindFailures, input.failureBackoffMs ?? 1000, 30000));
              return "skip";
            }
            mindFailures = 0;
            try {
              fresh = await observe();
              freshMode = await input.body.mode();
            } catch {
              unavailableWorld();
              return "stop";
            }
            if (freshMode !== mode || healthMode(fresh) !== healthMode(observation)) {
              record.outcome = "stale_decision";
              record.effect = "World mode changed while deciding; no action issued.";
              settled(record, observation, fresh);
              return "skip";
            }
            decision = record.decision;
            if (objective && objective !== decision.objective) {
              retiredObjectives.push(objective);
              if (retiredObjectives.length > 8) retiredObjectives.shift();
              if (retiredObjectives.length === 2) notable("objective_retired_twice");
            }
            objective = decision.objective;
            notes = decision.notes ?? notes;
            after = fresh;
            return "act";
          },
          act: async () => {
            if (decision.action) {
              try {
                const actionId = randomUUID();
                activeAction = actionId;
                const validateStatus = (value: unknown) => {
                  const status = MinecraftActionStatusSchema.parse(value);
                  if (
                    status.actionId !== actionId ||
                    status.session.sessionId !== input.session.sessionId ||
                    status.session.connectionGeneration !== input.session.connectionGeneration ||
                    JSON.stringify(status.requested) !== JSON.stringify(decision.action)
                  )
                    throw new Error("Minecraft play action status stale");
                  return status;
                };
                let status = validateStatus(
                  await input.body.act({ session: input.session, actionId, action: decision.action }),
                );
                const actionStarted = Date.now();
                while (
                  ["running", "cancel_requested"].includes(status.state) &&
                  !stop() &&
                  !exhausted() &&
                  Date.now() - actionStarted < (input.actionSliceMs ?? 10000)
                ) {
                  await wait(100);
                  const updated = await input.body.actionStatus(actionId);
                  if (!updated) throw new Error("Minecraft action status missing");
                  status = validateStatus(updated);
                }
                if (["running", "cancel_requested"].includes(status.state))
                  status = validateStatus(await input.body.cancel(actionId));
                activeAction = null;
                record.action = status;
                if (status.state === "completed") accepted++;
                record.outcome = "settled";
                record.effect =
                  status.evidence.outcome === "unknown"
                    ? `Effect unknown (${status.evidence.reason}); action ${status.state}.`
                    : `Effect ${status.evidence.outcome}: ${JSON.stringify(status.evidence.checks).slice(0, 1000)}`;
                after = await observe();
                actionFailures = 0;
              } catch {
                actionFailures++;
                record.outcome = "action_failed";
                record.effect = "Action or its verification became unavailable; no success inferred.";
                if (activeAction) {
                  try {
                    await input.body.cancel(activeAction);
                    activeAction = null;
                  } catch {
                    unavailableWorld();
                  }
                }
              }
            } else {
              record.outcome = "waited";
              record.effect = "Chose to wait; no action issued.";
            }
          },
          verify: async () => {
            const changed =
              progressKey(after) !== progressKey(fresh) || record.action?.evidence.outcome === "verified";
            stalledForTurns = changed ? 0 : stalledForTurns + 1;
            if (stalledForTurns === 6) notable("stuck");
          },
          remember: async () => {
            const event = roomEvent({
              turn,
              monologue: decision.monologue,
              effect: record.effect,
              objective,
              intent: decision.intent,
            });
            let narration: { event: string; speechDeliveryId?: string } | undefined;
            if (event && voice?.roomListening) {
              const speakWanted =
                decision.speakWanted &&
                (interjection !== null || playSpeechReady(lastSpoke, turn, input.speakCooldownTurns ?? 4));
              speakSuppressed = decision.speakWanted && !speakWanted;
              const speechDeliveryId = speakWanted ? randomUUID() : undefined;
              if (speakWanted) lastSpoke = turn;
              narration = { event, ...(speechDeliveryId ? { speechDeliveryId } : {}) };
              void voice
                .narrate(event, {
                  respond: speakWanted,
                  ...(speechDeliveryId ? { deliveryId: speechDeliveryId } : {}),
                })
                .catch(() => {});
            }
            settled(record, observation, after, narration);
          },
          pace: async () => {
            if (worldEnded()) return;

            const delay =
              actionFailures > 0
                ? playFailureBackoff(Math.min(actionFailures, 6), input.failureBackoffMs ?? 1000, 30000)
                : players === 0
                  ? Math.min(
                      60000,
                      Math.max(input.turnIntervalMs ?? 2000, input.idleBackoffMs ?? 15000) *
                        2 ** Math.min(unchangedTurns, 2),
                    )
                  : unchangedTurns > 2
                    ? Math.min(30000, (input.turnIntervalMs ?? 2000) * 2 ** Math.min(unchangedTurns - 2, 3))
                    : (input.turnIntervalMs ?? 2000);
            await wait(delay, true);
          },
        };
      },
    });
    if (exhausted() && outcome === "stopped" && !stop()) outcome = "budget_exhausted";
    const result = {
      outcome,
      turnsTaken: turn,
      inputTokens,
      outputTokens,
      costUsd,
      unknownUsageCalls,
      journalPath,
      notes,
      objective,
    };
    append({ kind: "summary", ...result, accepted, usage: totalUsage, durationMs: Date.now() - startedAt });
    return result;
  } finally {
    if (activeAction) await input.body.cancel(activeAction).catch(() => {});
    unsubscribe?.();
    voice?.close();
  }
}
function healthMode(observation: MinecraftObservation): string {
  const fact = observation.facts.find((entry) => entry.fact.type === "health")?.fact;
  if (fact?.type !== "health") return "unknown";
  return fact.health === 0 ? "dead" : fact.health <= 6 ? "danger" : "alive";
}
function progressKey(observation: MinecraftObservation): string {
  return JSON.stringify(
    observation.facts.filter((entry) => entry.fact.type !== "chat").map((entry) => entry.fact),
  );
}
