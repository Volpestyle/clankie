import {
  type CaptainSessionLaneV2,
  type OperatorConversationActivityPhase,
  type OperatorSeatEventKind,
} from "@clankie/protocol";
import { type ClankieSettings } from "@clankie/settings";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { materializeOwnerAttachments, modelImagesForOwnerAttachments } from "../owner-attachments.ts";
import { AutonomyStore } from "./autonomy.ts";
import { createDraftPacer } from "./captain-draft.ts";
import { enforceGoalBudget } from "./captain-goals.ts";
import {
  formatOperatorToolDetail,
  formatOperatorToolResult,
  operatorSkillName,
  resolveOperatorPrompt,
} from "./captain-operator-format.ts";
import { assistantText, runDurableTurn } from "./captain-session.ts";
import { type CaptainOptions, type LaneSession } from "./captain-types.ts";
import {
  authorizeQuestion,
  questionWorkspaceContext,
  sameQuestionWorkspace,
} from "./conversation-questions.ts";
import { ConversationServiceRun } from "./conversation-run.ts";
import { ConversationStore, type ConversationRunner, type ConversationTurnContext } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { readHerdrSessionCensus, type HerdrCensusFleet } from "./herdr-census.ts";
import { LaneLog } from "./lane-log.ts";
import { SeatOutbox } from "./seat-outbox.ts";
import { invocableSkills } from "./skill-catalog.ts";
import { roomKey } from "./tools.ts";
import {
  contextTokenCount,
  recordPiTurnEvent,
  sessionExecutionIdentity,
  tryAppendTurnSettled,
  TurnMetrics,
  TurnSettledLog,
  type TurnSettledOutcome,
} from "./turn-metrics.ts";

export interface CreateConversationRunnerContext {
  readonly shutdown: AbortController;
  readonly conversations: ConversationStore;
  readonly settings: () => Promise<ClankieSettings>;
  readonly options: CaptainOptions;
  readonly seatEventKind: (
    conversationId: string,
    context: Pick<ConversationTurnContext, "internal" | "origin">,
  ) => OperatorSeatEventKind | undefined;
  readonly seatOutbox: (conversationId: string) => SeatOutbox;
  readonly workingDirectory: string;
  readonly buildSession: (
    lane: CaptainSessionLaneV2,
    sessionManager: SessionManager,
    systemTools: boolean,
    cwd: string,
    sideConversation?: boolean,
    _conversationId?: string,
    run?: ConversationServiceRun,
  ) => Promise<LaneSession>;
  readonly durableSession: (
    key: string,
    lane: CaptainSessionLaneV2,
    dir: string,
    systemTools: boolean,
    cwd: string,
    sideConversation?: boolean,
    run?: ConversationServiceRun,
  ) => Promise<LaneSession>;
  readonly captureEvaluationStart: (
    runId: string,
    conversationId: string,
    session: AgentSession,
    request: string,
  ) => void;
  readonly autonomy: AutonomyStore;
  readonly syncModel: (lane: LaneSession) => Promise<void>;
  readonly laneLog: LaneLog;
  readonly censusFleets: () => Promise<readonly HerdrCensusFleet[]>;
  readonly deps: CaptainDeps;
  readonly turnSettled: TurnSettledLog;
  readonly goalExecutionReason: (conversationId: string) => string | undefined;
  readonly refuseNativeGoal: (conversationId: string) => boolean;
}

export function createConversationRunner(ctx: CreateConversationRunnerContext): ConversationRunner {
  return async (conversationId, incoming, publish, context) => {
    // A queued turn may start after close releases the preceding seat waiter.
    // It must not see an empty outbox and fall through into a fresh Pi turn.
    const signal = AbortSignal.any([context.signal, ctx.shutdown.signal]);
    signal.throwIfAborted();
    const preparation = new ConversationServiceRun(signal);
    let preparedMessage: string | undefined;
    try {
      if (context.inputAnswer) {
        await preparation.wait("question authority", authorizeQuestion(context.ownerAuthority));
        if (!ctx.conversations.questionEligible(conversationId)) throw new Error("question_context_lost");
      }
      // Turning follow off also drops activity still queued behind a live turn.
      if (
        context.origin === "hook" &&
        (!(await preparation.wait("Linear following settings", ctx.settings())).linearWebhook.following ||
          (ctx.options.linearFollowing !== undefined &&
            !(await preparation.wait("Linear following authorization", ctx.options.linearFollowing()))))
      ) {
        ctx.conversations.discardLinearWake(conversationId);
        return;
      }
      // A hook wake is worded when it starts, from whatever arrived until now.
      preparedMessage =
        context.origin === "hook"
          ? ctx.conversations.linearWakePrompt(conversationId, context.runId)
          : incoming;
    } finally {
      preparation.close();
    }
    const message = preparedMessage;
    if (message === undefined) return;
    signal.throwIfAborted();
    if (context.origin === "goal") {
      if (ctx.refuseNativeGoal(conversationId)) return;
      if (
        context.expectedGoal === undefined ||
        ctx.autonomy.getGoal(conversationId) !== context.expectedGoal ||
        context.expectedGoal.status !== "active"
      )
        return;
    }
    return ctx.conversations.runWithConversationDriver<void>(
      conversationId,
      () => {
        const kind = ctx.seatEventKind(conversationId, context);
        if (kind === undefined) return undefined;
        const selectedOutbox = ctx.seatOutbox(conversationId);
        return {
          run: async () => {
            // The harness in his seat opens files by path, the way any worker does.
            const preparation = new ConversationServiceRun(signal);
            let attached: Awaited<ReturnType<typeof materializeOwnerAttachments>> | undefined;
            try {
              attached =
                context.attachments === undefined
                  ? undefined
                  : await preparation.wait(
                      "native owner attachments",
                      materializeOwnerAttachments({
                        workspace: context.workspace ?? ctx.workingDirectory,
                        messageId: context.runId,
                        attachments: context.attachments,
                      }),
                    );
            } finally {
              preparation.close();
            }
            signal.throwIfAborted();
            let queuedAtSeat = false;
            const delivery = await selectedOutbox.deliver({
              ...(context.delivery === undefined ? {} : { delivery: context.delivery }),
              onAdmitted: (state) => {
                if (state === "queued") queuedAtSeat = true;
                context.deliveryOutcome?.({ state });
                if (state !== "queued") publish({ type: "activity", phase: "responding" });
              },
              kind,
              conversationId,
              source: context.surfaceClientId ?? "service",
              content:
                attached === undefined ? message : [message, attached.note].filter(Boolean).join("\n\n"),
              wantsReply: kind === "escalation",
              signal,
            });
            // Shutdown loses the reply target; cancellation must not turn an
            // unanswered accepted native dispatch into a completed turn.
            ctx.shutdown.signal.throwIfAborted();
            if (delivery.outcome === "unconfirmed")
              context.deliveryOutcome?.({ state: "uncertain", detail: delivery.detail });
            if (delivery.outcome === "aborted")
              context.deliveryOutcome?.({
                state: "rejected",
                detail: "The send was cancelled before the seat took it.",
              });
            if (delivery.deliveryStage !== undefined && delivery.outcome !== "unbound")
              context.deliveryReceipt?.(delivery.deliveryStage);
            if (delivery.outcome === "replied") {
              publish({ type: "message", role: "captain", text: delivery.text, streaming: false });
            }
            if (delivery.outcome === "unbound" && queuedAtSeat) {
              context.deliveryOutcome?.({
                state: "rejected",
                detail: "The channel disconnected before taking this message. Nothing was sent.",
              });
              context.deliveryReceipt?.("unavailable");
              return { handled: true as const, result: undefined };
            }
            // A held Queue already belongs to the native turn. Only a definite
            // refusal before admission may choose the service driver instead.
            return delivery.outcome === "unbound"
              ? { handled: false as const }
              : { handled: true as const, result: undefined };
          },
        };
      },
      async (run) => {
        run.signal.throwIfAborted();
        if (context.origin === "goal") {
          if (ctx.refuseNativeGoal(conversationId)) return;
          if (
            context.expectedGoal === undefined ||
            ctx.autonomy.getGoal(conversationId) !== context.expectedGoal ||
            context.expectedGoal.status !== "active"
          )
            return;
        }
        // Native ownership survives gaps in polling. Internal deliveries must
        // wait for that receiver, rather than starting another lead in Pi.
        if (context.internal && ctx.conversations.hasNativeSeat(conversationId)) {
          throw new Error(
            "Native conversation receiver is unavailable; internal service fallback is refused",
          );
        }
        const cwd = context.workspace ?? ctx.workingDirectory;
        const lane = await ctx.durableSession(
          `operator:${conversationId}`,
          "operator",
          join(ctx.options.stateDir, "conversations", conversationId, "pi"),
          true,
          cwd,
          context.side === true,
          run,
        );
        if (ctx.shutdown.signal.aborted) {
          ctx.shutdown.signal.throwIfAborted();
        }
        // Operator interrupt: stop the live model turn. Aborting mid-stream makes
        // pi settle the message as aborted; partial text still publishes below so
        // the transcript shows what he had said before the interrupt.
        if (run.signal.aborted) {
          run.signal.throwIfAborted();
        }
        const onInterrupt = (): void => {
          void lane.session.abort().catch(() => undefined);
        };
        run.signal.addEventListener("abort", onInterrupt, { once: true });
        let releaseStarting: (() => void) | undefined;
        if (lane.running === undefined && lane.starting === undefined && !lane.session.isStreaming) {
          lane.starting = new Promise<void>((resolve) => {
            releaseStarting = resolve;
          });
          lane.capture.media = undefined;
          lane.capture.autonomous = context.internal === true;
        }
        const bodyIdentity = {
          conversationId,
          route: { owner: { conversationId }, mode: "machine" as const },
          current: () =>
            lane.capture.bodyIdentity === bodyIdentity &&
            !run.signal.aborted &&
            ctx.conversations.runsCaptainTurns(conversationId),
          authorize: async () => ctx.conversations.runsCaptainTurns(conversationId),
        };
        lane.capture.bodyIdentity = bodyIdentity;
        lane.capture.conversationAuthority = {
          owner: { conversationId },
          current: bodyIdentity.current,
          authorize: bodyIdentity.authorize,
        };
        lane.capture.proposeProjectCreate =
          context.ownerAuthority && context.questionBinding
            ? (draft) =>
                ctx.conversations.proposeProjectCreate(conversationId, draft, {
                  ...context,
                  questionCurrent: bodyIdentity.current,
                })
            : undefined;
        lane.capture.requestQuestion =
          context.ownerAuthority && context.questionBinding
            ? (draft) =>
                ctx.conversations.requestQuestion(conversationId, draft, {
                  ...context,
                  questionCurrent: bodyIdentity.current,
                })
            : undefined;
        lane.capture.room = roomKey("operator", conversationId);
        lane.capture.targetId = conversationId;
        lane.capture.goalExecutionReason = () => ctx.goalExecutionReason(conversationId);
        lane.capture.publishFile = (input) => ctx.conversations.publishFile({ conversationId, ...input });
        if (releaseStarting === undefined && lane.starting !== undefined)
          try {
            await run.wait("active session preparation", lane.starting);
          } catch (error) {
            run.signal.removeEventListener("abort", onInterrupt);
            throw error;
          }

        const live = lane.running !== undefined || lane.session.isStreaming;
        const operatorTokensStart = contextTokenCount(lane.session.getContextUsage());
        const metrics = live
          ? undefined
          : new TurnMetrics({
              conversationId,
              lane: "operator",
              runId: context.runId,
              acceptedAt: context.acceptedAt,
              ...(operatorTokensStart === undefined ? {} : { contextTokensStart: operatorTokensStart }),
            });
        if (metrics !== undefined)
          ctx.captureEvaluationStart(context.runId, conversationId, lane.session, message);
        const skillCalls = new Map<string, string>();
        const candidateGoal =
          context.origin === "goal"
            ? context.expectedGoal
            : live
              ? undefined
              : ctx.autonomy.getGoal(conversationId);
        const runGoal =
          context.origin === "goal"
            ? candidateGoal
            : candidateGoal?.status === "active"
              ? candidateGoal
              : undefined;
        const releaseGoalBudget =
          runGoal === undefined
            ? () => undefined
            : enforceGoalBudget(
                lane.session,
                ctx.autonomy,
                conversationId,
                runGoal,
                context.origin === "goal",
              );
        let activity: OperatorConversationActivityPhase | undefined;
        const publishActivity = (phase: OperatorConversationActivityPhase): void => {
          if (activity === phase) return;
          activity = phase;
          publish({ type: "activity", phase });
        };
        const drafts = createDraftPacer((text) => {
          if (!run.signal.aborted) context.draft(text);
        });
        const unsubscribeProgress = lane.session.subscribe((event) => run.observe(event));
        const unsubscribe = live
          ? () => undefined
          : lane.session.subscribe((event) => {
              if (run.signal.aborted) return;
              if (metrics !== undefined) recordPiTurnEvent(metrics, event);
              if (event.type === "message_update") {
                if (
                  event.assistantMessageEvent.type === "thinking_start" ||
                  event.assistantMessageEvent.type === "thinking_delta"
                ) {
                  publishActivity("thinking");
                } else if (
                  event.assistantMessageEvent.type === "text_start" ||
                  event.assistantMessageEvent.type === "text_delta"
                ) {
                  publishActivity("responding");
                  drafts.push(assistantText(event.assistantMessageEvent.partial));
                } else if (
                  event.assistantMessageEvent.type === "toolcall_start" ||
                  event.assistantMessageEvent.type === "toolcall_delta"
                ) {
                  publishActivity("preparing_tool");
                }
              } else if (event.type === "tool_execution_start") {
                activity = undefined;
                const skillName = operatorSkillName(event.toolName, event.args);
                if (skillName !== undefined) skillCalls.set(event.toolCallId, skillName);
                publish({
                  type: "tool",
                  toolCallId: event.toolCallId,
                  name: event.toolName,
                  phase: "started",
                  detail: formatOperatorToolDetail(event.args),
                  ...(skillName === undefined ? {} : { skillName }),
                });
              } else if (event.type === "tool_execution_end") {
                const skillName = skillCalls.get(event.toolCallId);
                skillCalls.delete(event.toolCallId);
                publish({
                  type: "tool",
                  toolCallId: event.toolCallId,
                  name: event.toolName,
                  phase: event.isError ? "failed" : "completed",
                  detail: formatOperatorToolResult(event.result),
                  ...(skillName === undefined ? {} : { skillName }),
                });
              } else if (event.type === "compaction_start") {
                publishActivity("compacting");
              } else if (event.type === "auto_retry_start") {
                publishActivity("retrying");
              } else if (event.type === "auto_retry_end") {
                publishActivity("waiting");
              } else if (event.type === "compaction_end") {
                publishActivity("waiting");
                const usage = lane.session.getContextUsage();
                if (usage !== undefined) {
                  publish({
                    type: "context",
                    usage: { tokens: usage.tokens, contextWindow: usage.contextWindow },
                  });
                }
              } else if (event.type === "message_end" && event.message.role === "assistant") {
                // Every message he finishes is a message he said — including the
                // one he says before reaching for a tool. The draft comes down
                // here because this durable event is what replaces it.
                context.draft(undefined);
                drafts.reset();
                const said = assistantText(event.message).trim();
                if (said.length > 0)
                  publish({ type: "message", role: "captain", text: said, streaming: false });
                const usage = lane.session.getContextUsage();
                if (usage !== undefined) {
                  publish({
                    type: "context",
                    usage: { tokens: usage.tokens, contextWindow: usage.contextWindow },
                  });
                }
              }
            });
        let settled: TurnSettledOutcome | undefined;
        try {
          ctx.shutdown.signal.throwIfAborted();
          if (
            context.origin === "goal" &&
            (ctx.refuseNativeGoal(conversationId) ||
              runGoal === undefined ||
              ctx.autonomy.getGoal(conversationId) !== runGoal ||
              runGoal.status !== "active")
          )
            return;
          if (!live) await run.wait("model synchronization", ctx.syncModel(lane));
          // After the sync, so a `/model` or `/effort` change made under a live
          // conversation is attributed to this turn — the first one to execute it.
          metrics?.recordExecution(sessionExecutionIdentity(lane.session));
          await run.wait(
            "heard log",
            ctx.laneLog.append("operator", conversationId, {
              at: new Date().toISOString(),
              kind: "heard",
              text: message,
            }),
          );
          const paneId = context.seat?.herdrPaneId;
          // Seated or not, an operator turn carries the fleet of the pinned
          // session (ADR 0149); an unseated turn with no live session attaches
          // nothing rather than herdr noise.
          const census = live
            ? undefined
            : await run.wait(
                "fleet census",
                readHerdrSessionCensus(paneId, {
                  ...(ctx.options.nativeCensusRunner
                    ? { runCommand: ctx.options.nativeCensusRunner, summaries: {} }
                    : {}),
                  fleets: await run.wait("fleet connections", ctx.censusFleets()),
                  localAvailable: ctx.deps.herdrAvailable?.() !== false,
                }),
              );
          // Owner attachments reach his model as images; the note numbers them
          // and names where each original is stored (ADR 0209).
          const attached =
            context.attachments === undefined
              ? undefined
              : await run.wait("owner model images", modelImagesForOwnerAttachments(context.attachments));
          const workspaceNote =
            context.ownerAuthority && context.questionBinding
              ? await run.wait(
                  "question workspace",
                  questionWorkspaceContext(cwd, async () => (await ctx.settings()).projects),
                )
              : "";
          if (context.ownerAuthority && context.questionBinding) {
            await run.wait("question authority", authorizeQuestion(context.ownerAuthority));
            if (!ctx.conversations.questionEligible(conversationId)) throw new Error("question_context_lost");
          }
          const prompt = resolveOperatorPrompt(
            attached === undefined ? message : [message, attached.note].filter(Boolean).join("\n\n"),
            invocableSkills(lane.session.resourceLoader.getSkills().skills, lane.quietSkills),
            paneId,
            census,
          );
          if (prompt.skillName !== undefined) {
            publish({
              type: "tool",
              toolCallId: `skill-${randomUUID()}`,
              name: "skill",
              phase: "completed",
              skillName: prompt.skillName,
            });
          }
          if (releaseStarting !== undefined) {
            releaseStarting();
            lane.starting = undefined;
            releaseStarting = undefined;
          }
          // The resource loader disables discovered extensions and prompt templates;
          // exact, loaded operator skills are the only input allowed to reach Pi expansion.
          if (
            context.origin === "goal" &&
            (ctx.refuseNativeGoal(conversationId) ||
              runGoal === undefined ||
              ctx.autonomy.getGoal(conversationId) !== runGoal ||
              runGoal.status !== "active")
          )
            return;
          const role = await run.wait(
            "Pi execution",
            runDurableTurn(
              lane,
              [workspaceNote, prompt.prompt].filter(Boolean).join("\n\n"),
              attached?.images ?? [],
              {
                expandPromptTemplates: context.inputAnswer === undefined && prompt.skillName !== undefined,
                onAdmitted: (state) => context.deliveryOutcome?.({ state }),
                ...(context.inputAnswer
                  ? {
                      // Existing admission reservation rechecks immediately before prompt().
                      preparePrompt: async () => {
                        await authorizeQuestion(context.ownerAuthority);
                        return () => {
                          if (
                            !bodyIdentity.current() ||
                            !context.ownerAuthority!.current() ||
                            !ctx.conversations.questionEligible(conversationId) ||
                            !context.questionBinding ||
                            !sameQuestionWorkspace(cwd, context.questionBinding.workspace)
                          )
                            throw new Error("question_context_lost");
                          return [workspaceNote, prompt.prompt].filter(Boolean).join("\n\n");
                        };
                      },
                      onAbsorbed: () => {
                        throw new Error("question_continuation_busy");
                      },
                    }
                  : {}),
                // runDurableTurn rechecks immediately before prompt/steer, including
                // after waiting for another invocation or its startup reservation.
                signal: run.signal,
              },
            ),
          );
          if (role === "absorbed") return;
          const text = lane.lastAssistantText.trim();
          await run.wait(
            "said log",
            ctx.laneLog.append("operator", conversationId, {
              at: new Date().toISOString(),
              kind: "said",
              text,
            }),
          );
          if (runGoal !== undefined) ctx.autonomy.finishTurn(conversationId, 0, runGoal);
          settled = context.signal.aborted ? "interrupted" : "completed";
        } catch (error) {
          if (metrics !== undefined) settled = context.signal.aborted ? "interrupted" : "failed";
          throw error;
        } finally {
          releaseGoalBudget();
          run.signal.removeEventListener("abort", onInterrupt);
          unsubscribeProgress();
          if (settled !== undefined) {
            tryAppendTurnSettled(
              ctx.turnSettled,
              metrics,
              settled,
              new Date(),
              contextTokenCount(lane.session.getContextUsage()),
            );
          }
          if (releaseStarting !== undefined) {
            releaseStarting();
            lane.starting = undefined;
          }
          unsubscribe();
        }
      },
      signal,
    );
  };
}
