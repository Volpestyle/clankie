import type { OwnerCredentialTurn } from "./owner-credential-recovery.ts";
import {
  OPERATOR_CONVERSATION_TEXT_MAX,
  type CaptainSessionLaneV2,
  type OperatorConversationActivityPhase,
  type OperatorGoal,
  type OperatorSeatEventKind,
} from "@clankie/protocol";
import { type ClankieSettings } from "@clankie/settings";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { materializeOwnerAttachments, modelImagesForOwnerAttachments } from "../owner-attachments.ts";
import { AutonomyStore, WakeHeldError } from "./autonomy.ts";
import { createDraftPacer } from "./captain-draft.ts";
import { enforceGoalBudget } from "./captain-goals.ts";
import {
  formatOperatorToolDetail,
  formatOperatorToolResult,
  operatorSkillName,
  resolveOperatorPrompt,
} from "./captain-operator-format.ts";
import { assistantText, PiRunError, runDurableTurn, type CredentialRecovery } from "./captain-session.ts";
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
    content: string,
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
    fresh?: boolean,
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
  /**
   * A provider rejected its stored credential in a real turn: refresh it once
   * and record the result for doctor. Undefined when nothing could be done.
   */
  readonly credentialRejected?: (
    providerId: string,
    detail: string,
    allowRefresh?: boolean,
  ) => Promise<CredentialRecovery["outcome"] | undefined>;
  /** A turn on this provider succeeded, so a recorded rejection is over. */
  readonly credentialAccepted?: (providerId: string) => void;
}

/**
 * One goal continuation or self-wake as a host-authored conversation turn.
 * Throws when the turn fails; a provider refusing the credentials throws
 * {@link WakeHeldError}, since retrying it only spends another full turn on the
 * same refusal (2026-10-07: 15+ attempts on an expired token). When Clankie
 * refreshed the rejected token, the turn runs once more first.
 */
export async function runAutonomyTurn(
  conversations: Pick<ConversationStore, "submitInternal" | "awaitRunOutcome">,
  conversationId: string,
  prompt: string,
  origin: "goal" | "wake",
  expectedGoal?: OperatorGoal,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const result = conversations.submitInternal(conversationId, prompt, origin, expectedGoal);
    if (result.status !== "accepted") throw new Error("Internal autonomy turn was not accepted");
    const outcome = await conversations.awaitRunOutcome(result.runId);
    if (outcome.ok) return;
    if (!(outcome.error instanceof PiRunError && outcome.error.credentialRejected))
      throw new Error("Internal autonomy turn failed");
    // A rejected token Clankie just refreshed gets the turn once more.
    if (outcome.error.credentialRecovery?.outcome === "refreshed" && attempt === 1) continue;
    throw new WakeHeldError("The model provider rejected Clankie's credentials", { cause: outcome.error });
  }
}

export function createConversationRunner(ctx: CreateConversationRunnerContext): ConversationRunner {
  /** The last internal input published per conversation and not yet answered. */
  const internalInputsShown = new Map<string, string>();
  return async (conversationId, incoming, publish, context) => {
    // A queued turn may start after close releases the preceding seat waiter.
    // It must not see an empty outbox and fall through into a fresh Pi turn.
    const signal = AbortSignal.any([context.signal, ctx.shutdown.signal]);
    signal.throwIfAborted();
    const preparation = new ConversationServiceRun(signal);
    let preparedMessage: string | undefined;
    try {
      if (context.origin === "input") {
        await preparation.wait("question authority", authorizeQuestion(context.ownerAuthority));
        if (context.questionBinding?.workspace && !ctx.conversations.questionEligible(conversationId))
          throw new Error("question_context_lost");
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
        const kind = ctx.seatEventKind(conversationId, context, message);
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
            const linearOriginal =
              context.origin === "hook"
                ? ctx.conversations.linearWakeReceipt(conversationId, context.runId)
                : undefined;
            // Surface names are caller claims; only the host-verified principal
            // makes this an ordinary owner turn. Recheck after attachment setup.
            if (kind === "turn") await authorizeQuestion(context.ownerAuthority);
            const delivery = await selectedOutbox.deliver({
              ...(linearOriginal
                ? {
                    original: linearOriginal,
                    ...(selectedOutbox.recipientBinding()
                      ? { recipientBinding: selectedOutbox.recipientBinding()! }
                      : {}),
                  }
                : {}),
              ...(context.delivery === undefined ? {} : { delivery: context.delivery }),
              onAdmitted: (state) => {
                if (state === "queued") queuedAtSeat = true;
                context.deliveryOutcome?.({ state });
                if (state !== "queued") publish({ type: "activity", phase: "responding" });
              },
              kind,
              conversationId,
              source: context.surfaceClientId ?? "service",
              ...(kind === "turn" && context.ownerAuthority !== undefined
                ? {
                    ownerOrigin: {
                      surfaceClientId: context.surfaceClientId ?? "operator",
                      principal: { ...context.ownerAuthority.principal },
                    },
                  }
                : {}),
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
        // Signed Linear activity alone still waits for an attached native
        // receiver and is re-offered on its next poll (VUH-1743).
        if (context.origin === "hook" && ctx.conversations.hasNativeSeat(conversationId)) {
          context.deliveryReceipt?.("unavailable");
          throw new Error("Native conversation receiver is unavailable; Linear activity waits for it");
        }
        // ADR 0218: no live seat means the service runs the conversation. The
        // log is the source of truth: a harness that drove since this lane last
        // ran is caught up by a fresh session seeded from the log, and the turn
        // opens the handoff span the returning harness receives.
        const sourceScope = ctx.conversations.conversation(conversationId)?.scope;
        const socialContinuation = sourceScope?.kind === "room" || sourceScope?.kind === "channel";
        // Owner answers carry authentication, never a new room machine grant.
        // A room continuation has no original transport actor proof: run its mind
        // in the source transcript with social tools and no external mouth route.
        const continuationLane =
          sourceScope?.kind === "room"
            ? sourceScope.lane
            : socialContinuation
              ? "discord_presence"
              : "operator";
        const handoff = ctx.conversations.noteServiceTurn(conversationId);
        const seed =
          context.side === true || ctx.conversations.activeInvocationCount(conversationId) > 1
            ? undefined
            : ctx.conversations.serviceContextSeed(conversationId);
        const cwd = context.workspace ?? ctx.workingDirectory;
        const lane = await ctx.durableSession(
          `${socialContinuation ? "ask-social" : "operator"}:${conversationId}`,
          continuationLane,
          join(ctx.options.stateDir, "conversations", conversationId, "pi"),
          !socialContinuation,
          cwd,
          context.side === true,
          run,
          seed !== undefined,
        );
        // Internal inputs never enter the log on their own; record what the
        // service answered so the log, not this lane, carries it forward.
        // A retried wake is the same input, not a new one: show it once until
        // a turn answers it.
        if (handoff && context.internal && internalInputsShown.get(conversationId) !== message) {
          internalInputsShown.set(conversationId, message);
          publish({
            type: "message",
            role: "external",
            text: message.slice(0, OPERATOR_CONVERSATION_TEXT_MAX),
            streaming: false,
          });
        }
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
          route: {
            owner: { conversationId },
            mode: socialContinuation ? ("social" as const) : ("machine" as const),
          },
          current: () =>
            (socialContinuation || lane.capture.bodyIdentity === bodyIdentity) &&
            !run.signal.aborted &&
            (socialContinuation
              ? ctx.conversations.conversation(conversationId) !== undefined
              : ctx.conversations.runsCaptainTurns(conversationId)),
          authorize: async () =>
            socialContinuation
              ? ctx.conversations.conversation(conversationId) !== undefined
              : ctx.conversations.runsCaptainTurns(conversationId),
        };
        lane.capture.shell = !socialContinuation;
        lane.capture.bodyIdentity = socialContinuation ? undefined : bodyIdentity;
        lane.capture.conversationAuthority = {
          owner: { conversationId },
          current: bodyIdentity.current,
          authorize: bodyIdentity.authorize,
        };
        lane.capture.proposeProjectDefaults =
          !socialContinuation && context.ownerAuthority && context.questionBinding
            ? () =>
                ctx.conversations.proposeProjectDefaults(conversationId, {
                  ...context,
                  questionCurrent: bodyIdentity.current,
                })
            : undefined;
        lane.capture.proposeProjectCreate =
          !socialContinuation && context.ownerAuthority && context.questionBinding
            ? (draft) =>
                ctx.conversations.proposeProjectCreate(conversationId, draft, {
                  ...context,
                  questionCurrent: bodyIdentity.current,
                })
            : undefined;
        lane.capture.requestQuestion = (draft) =>
          draft.purpose === "preference" && context.ownerAuthority && context.questionBinding
            ? ctx.conversations.requestQuestion(conversationId, draft, {
                ...context,
                questionCurrent: bodyIdentity.current,
              })
            : ctx.conversations.requestSurfaceQuestion(conversationId, draft, {
                current: bodyIdentity.current,
                authorize: bodyIdentity.authorize,
              });
        lane.capture.mailOwnerUpdate = (draft, publicationId) =>
          ctx.conversations.mailOwnerUpdate(conversationId, draft, `${context.runId}:${publicationId}`, {
            current: bodyIdentity.current,
            authorize: bodyIdentity.authorize,
          });
        lane.capture.room =
          sourceScope?.kind === "room"
            ? roomKey(sourceScope.lane, sourceScope.targetId)
            : roomKey(continuationLane, conversationId);
        lane.capture.targetId = sourceScope?.kind === "room" ? sourceScope.targetId : conversationId;
        // A private owner answer supplies no Discord actor, channel or trigger proof.
        lane.capture.actorId = undefined;
        lane.capture.guildId = undefined;
        lane.capture.channelId = undefined;
        lane.capture.messageId = undefined;
        lane.capture.discordOrigin = undefined;
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
                if (
                  said.length > 0 &&
                  !(
                    event.message.stopReason === "error" &&
                    new PiRunError(event.message.errorMessage ?? "").credentialRejected
                  )
                )
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
        let admitted = false;
        const ownerRecovery: OwnerCredentialTurn | undefined =
          context.internal !== true && ctx.credentialRejected !== undefined
            ? {
                signal: run.signal,
                recover: ctx.credentialRejected,
                retrying: () => publishActivity("retrying"),
              }
            : undefined;
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
            !socialContinuation && context.ownerAuthority && context.questionBinding
              ? await run.wait(
                  "question workspace",
                  questionWorkspaceContext(cwd, async () => (await ctx.settings()).projects),
                )
              : "";
          if (context.ownerAuthority && context.questionBinding) {
            await run.wait("question authority", authorizeQuestion(context.ownerAuthority));
            if (context.questionBinding.workspace && !ctx.conversations.questionEligible(conversationId))
              throw new Error("question_context_lost");
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
              [seed?.text, workspaceNote, prompt.prompt].filter(Boolean).join("\n\n"),
              attached?.images ?? [],
              {
                expandPromptTemplates: context.inputAnswer === undefined && prompt.skillName !== undefined,
                onAdmitted: (state) => {
                  admitted = true;
                  if (state === "started" && lane.credentialRecovery !== undefined) {
                    if (ownerRecovery === undefined) delete lane.credentialRecovery.current;
                    else lane.credentialRecovery.current = ownerRecovery;
                  }
                  context.deliveryOutcome?.({ state });
                },
                ...(context.inputAnswer
                  ? {
                      // Existing admission reservation rechecks immediately before prompt().
                      preparePrompt: async () => {
                        await authorizeQuestion(context.ownerAuthority);
                        return () => {
                          if (
                            !bodyIdentity.current() ||
                            !context.ownerAuthority!.current() ||
                            (context.questionBinding?.workspace !== undefined &&
                              !ctx.conversations.questionEligible(conversationId)) ||
                            !context.questionBinding ||
                            (context.questionBinding.workspace !== undefined &&
                              !sameQuestionWorkspace(cwd, context.questionBinding.workspace))
                          )
                            throw new Error("question_context_lost");
                          return [seed?.text, workspaceNote, prompt.prompt].filter(Boolean).join("\n\n");
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
          if (seed !== undefined) ctx.conversations.markServiceContext(conversationId, seed.revision);
          if (role === "absorbed") {
            context.deliveryReceipt?.("consumed");
            return;
          }
          context.deliveryReceipt?.("responded");
          internalInputsShown.delete(conversationId);
          const provider = lane.session.model?.provider;
          if (provider !== undefined) ctx.credentialAccepted?.(provider);
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
          // Failure before Pi took the input is a definite non-dispatch.
          if (!admitted && !context.signal.aborted) context.deliveryReceipt?.("unavailable");
          const failure = ownerRecovery?.failure ?? error;
          const providerId = lane.session.model?.provider;
          if (
            ownerRecovery?.attempted !== true &&
            failure instanceof PiRunError &&
            failure.credentialRejected &&
            failure.credentialRecovery === undefined &&
            providerId !== undefined &&
            ctx.credentialRejected !== undefined
          ) {
            const outcome = await ctx.credentialRejected(providerId, failure.message).catch(() => undefined);
            if (outcome !== undefined) throw new PiRunError(failure.message, { providerId, outcome });
          }
          throw failure;
        } finally {
          if (lane.credentialRecovery?.current === ownerRecovery && lane.credentialRecovery !== undefined)
            delete lane.credentialRecovery.current;
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
