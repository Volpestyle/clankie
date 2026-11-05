import { SETTLED_STATUSES } from "./herdr-watch-shared.ts";
import { type HiredRestartCandidate, type HiredRestartReceipt } from "./hired-seat-restart.ts";
import { type ConversationOwner } from "./conversation-owner.ts";
import { DiscordWatchOriginSchema, type DiscordWatchOrigin } from "./conversation-owner.ts";
import { isMessageableSeat } from "./fleet-seat-control.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { redactSensitiveText } from "@clankie/observability";
import { OPERATOR_CONVERSATION_SUMMARY_MAX } from "@clankie/protocol";
import { z } from "zod";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { readHerdrSummariesFile, type HerdrAgentSummary } from "./herdr-summaries.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import {
  HerdrWatchWakeReceiptSchema,
  type HerdrWatchWakeContext,
  HerdrWatchWakeAbandonedError,
  type HerdrWatchEnd,
  HerdrWatchSettlementSchema,
  type HerdrWatchSettlement,
  SETTLEMENTS_MAX,
  NativeCompletionSchema,
  type HerdrWatchRecord,
  type HerdrAgentSnapshot,
  type HerdrWatchArmResult,
  type InternalWake,
  type ProjectSeat,
  REPLY_STATUSES,
  RETRY_ADMISSION_MS,
  TERMINAL_ID,
} from "./herdr-watch-types.ts";
import { missingSession, watchPrompt, bounded, distillHerdrSeatReply, delay } from "./herdr-watch-helpers.ts";
import type { HerdrWatchContext } from "./herdr-watch-context.ts";

type Context = Pick<
  HerdrWatchContext,
  | "adapterStatus"
  | "awaitRound"
  | "closed"
  | "controllers"
  | "endsOnNativeChange"
  | "ensureSummaryWatch"
  | "followTranscript"
  | "harvestClaim"
  | "headSeats"
  | "hireOwners"
  | "hiredRestarts"
  | "lastReply"
  | "launch"
  | "nativeEnd"
  | "onSummariesChanged"
  | "onWorkerSettled"
  | "projectSeat"
  | "publishSeatStatus"
  | "publishSeatSummary"
  | "publishSeatTranscript"
  | "readSeatReply"
  | "recordSettlement"
  | "remove"
  | "requireWorkerAccess"
  | "retry"
  | "retryTimers"
  | "retryWorking"
  | "run"
  | "runSeat"
  | "runner"
  | "save"
  | "seatControl"
  | "seatControllers"
  | "seatStatuses"
  | "seatSummaries"
  | "seatTranscriptTailMs"
  | "seatWithSession"
  | "settle"
  | "settlements"
  | "settlementsPath"
  | "state"
  | "stateUnreadable"
  | "stopSummaryWatch"
  | "summariesPath"
  | "summaryWatchIntervalMs"
  | "transcriptSeats"
  | "untrackSeat"
  | "wake"
  | "watchOwner"
  | "watchingSummaries"
  | "writeSidecar"
>;

export function createHerdrWatchObservation(ctx: Context) {
  /** Only this service's original successful native launches carry restart authority. */
  async function freshRestartCandidates(): Promise<readonly HiredRestartCandidate[]> {
    const candidates = [...(await ctx.hiredRestarts.candidates())];
    // Keep original receipt-backed refusals visible even if a supplemental census fails.
    const inventory = ctx.runner.list ? await ctx.runner.list().catch(() => []) : [];
    for (const agent of inventory) {
      if (
        !agent.session ||
        splitFleetQualified(agent.paneId) ||
        candidates.some((candidate) => candidate.agent.paneId === agent.paneId)
      )
        continue;
      const claim = ctx.hireOwners.claim(
        agent.paneId,
        agent.terminalId,
        occupantIdForHerdrSession(agent.session),
      );
      if (claim?.hired === true) candidates.push(ctx.hiredRestarts.unavailable(agent, claim.owner));
    }
    return candidates;
  }

  function hiredRestartReceipts(): readonly HiredRestartReceipt[] {
    return ctx.hiredRestarts.journal();
  }

  function start(wake: InternalWake, projectSeat?: ProjectSeat): void {
    ctx.wake = wake;
    ctx.projectSeat = projectSeat;
    for (const watch of ctx.state.watches) ctx.launch(watch);
  }

  function trackSeat(seatId: string, mode: "status" | "head" = "status"): void {
    if (ctx.closed || ctx.projectSeat === undefined) return;
    if (ctx.seatControllers.has(seatId)) {
      if (mode !== "head" || ctx.headSeats.has(seatId)) return;
      ctx.untrackSeat(seatId);
    }
    const controller = new AbortController();
    if (mode === "head") ctx.headSeats.add(seatId);
    ctx.seatControllers.set(seatId, controller);
    if (mode === "head") ctx.ensureSummaryWatch();
    void ctx.runSeat(seatId, controller.signal, mode).finally(() => {
      if (ctx.seatControllers.get(seatId) === controller) ctx.seatControllers.delete(seatId);
      if (ctx.headSeats.size === 0) ctx.stopSummaryWatch();
    });
  }

  function untrackSeat(seatId: string): void {
    ctx.headSeats.delete(seatId);
    ctx.seatControllers.get(seatId)?.abort();
    ctx.seatControllers.delete(seatId);
    ctx.seatStatuses.delete(seatId);
    ctx.seatSummaries.delete(seatId);
    ctx.transcriptSeats.delete(seatId);
    if (ctx.seatControllers.size === 0) ctx.stopSummaryWatch();
  }

  function watchHiredSeat(
    seatId: string,
    occupantId: string,
    owner: ConversationOwner,
    start = true,
    messageId?: string,
  ): HerdrWatchRecord | undefined {
    if (ctx.stateUnreadable) throw new Error("Herdr watcher state is unreadable");
    const existing = ctx.state.watches.find(
      (watch) =>
        watch.hired === true &&
        watch.terminalId === seatId &&
        watch.occupantId === occupantId &&
        watch.messageId === messageId,
    );
    if (existing) return existing;
    if (messageId && ctx.harvestClaim(seatId, occupantId, messageId)) return undefined;
    const record: HerdrWatchRecord = {
      id: randomUUID(),
      conversationId: owner.conversationId,
      target: seatId,
      terminalId: seatId,
      occupantId,
      hired: true,
      ...(messageId === undefined ? {} : { messageId }),
      reason: "Harvest the worker hired by this conversation; report completion or escalation here.",
      createdAt: new Date().toISOString(),
      ...(owner.discord === undefined ? {} : { discord: { ...owner.discord } }),
    };
    ctx.state.watches.push(record);
    ctx.save();
    if (start) ctx.launch(record);
    return record;
  }

  async function watch(
    conversationId: string,
    target: string,
    reason: string,
    discord?: DiscordWatchOrigin,
    guard?: () => Promise<void>,
    messageId?: string,
  ): Promise<HerdrWatchArmResult> {
    if (discord !== undefined) discord = DiscordWatchOriginSchema.parse(discord);
    if (ctx.closed || ctx.wake === undefined) throw new Error("Herdr watcher is not running");
    if (ctx.stateUnreadable) throw new Error("Herdr watcher state is unreadable");
    // `herdr agent get` takes a pane or agent name, not the terminal id a hire
    // returns as its seatId, so a seatId is resolved from the pane list.
    const agent = await ctx.seatWithSession(() =>
      TERMINAL_ID.test(target)
        ? ctx.runner.resolveTerminal(target).then((found) => {
            if (found === undefined) throw new Error(`Herdr seat ${target} not found`);
            return found;
          })
        : ctx.runner.get(target),
    );
    if (ctx.closed || ctx.wake === undefined) throw new Error("Herdr watcher is not running");
    if (ctx.stateUnreadable) throw new Error("Herdr watcher state is unreadable");
    if (agent === undefined) throw new Error(`Herdr seat ${target} not found`);
    if (agent.session === undefined) throw new Error(missingSession(target, agent));
    const occupantId = occupantIdForHerdrSession(agent.session);
    const hiredOwner = ctx.hireOwners.owner(agent.paneId, agent.terminalId, occupantId);
    if (ctx.hireOwners.hasClaim(agent.paneId, agent.terminalId) && hiredOwner === undefined)
      throw new Error("The worker native occupant no longer matches its persisted owner");
    if (hiredOwner !== undefined && hiredOwner.conversationId !== conversationId)
      throw new Error("This worker belongs to another admitted conversation");
    await guard?.();
    const claimed =
      messageId === undefined ? undefined : ctx.harvestClaim(agent.terminalId, occupantId, messageId);
    if (claimed && messageId !== undefined)
      return claimed.completion
        ? {
            outcome: "settled_for_message",
            messageId,
            watchId: claimed.watchId,
            completion: claimed.completion,
          }
        : { outcome: "already_harvested", messageId, watchId: claimed.watchId };
    // An adapter's own status outranks the terminal's: a native view can look
    // idle while its harness works.
    const status = (await ctx.adapterStatus(agent)) ?? agent.status;
    if (messageId === undefined && SETTLED_STATUSES.has(status)) {
      return {
        outcome: "already_settled",
        target,
        paneId: agent.paneId,
        terminalId: agent.terminalId,
        status,
      };
    }
    if (messageId === undefined && status !== "working") {
      throw new Error(`Herdr pane ${target} has no working agent to watch (status ${status})`);
    }
    const existing = ctx.state.watches.find(
      (watch) =>
        ctx.watchOwner(watch)?.conversationId === conversationId &&
        watch.terminalId === agent.terminalId &&
        (messageId === undefined || watch.messageId === messageId),
    );
    if (existing !== undefined) {
      return {
        outcome: "watching",
        watchId: existing.id,
        ...(existing.messageId === undefined ? {} : { messageId: existing.messageId }),
        target: existing.target,
        paneId: agent.paneId,
        terminalId: agent.terminalId,
        alreadyWatching: true,
        createdAt: existing.createdAt,
      };
    }
    await guard?.();
    const latest = await ctx.runner.resolveTerminal(agent.terminalId);
    if (latest?.session === undefined || occupantIdForHerdrSession(latest.session) !== occupantId)
      throw new Error("The watched native occupant changed during admission");
    await guard?.();
    const record: HerdrWatchRecord = {
      id: randomUUID(),
      conversationId,
      target,
      terminalId: agent.terminalId,
      occupantId,
      reason: reason.trim(),
      ...(messageId === undefined ? {} : { messageId }),
      ...(hiredOwner === undefined || messageId === undefined ? {} : { hired: true }),
      createdAt: new Date().toISOString(),
      ...(discord === undefined ? {} : { discord: DiscordWatchOriginSchema.parse(discord) }),
    };
    ctx.state.watches.push(record);
    ctx.save();
    ctx.launch(record);
    return {
      outcome: "watching",
      watchId: record.id,
      ...(messageId === undefined ? {} : { messageId }),
      target,
      paneId: agent.paneId,
      terminalId: agent.terminalId,
      alreadyWatching: false,
      createdAt: record.createdAt,
    };
  }

  function cancelConversation(conversationId: string): void {
    const removed = ctx.state.watches.filter(
      (watch) => ctx.watchOwner(watch)?.conversationId === conversationId,
    );
    if (removed.length === 0) return;
    const removedIds = new Set(removed.map((watch) => watch.id));
    ctx.state.watches = ctx.state.watches.filter((watch) => !removedIds.has(watch.id));
    for (const watch of removed) ctx.controllers.get(watch.id)?.abort();
    ctx.save();
  }

  function close(): void {
    ctx.closed = true;
    ctx.wake = undefined;
    ctx.projectSeat = undefined;
    for (const controller of ctx.controllers.values()) controller.abort();
    ctx.controllers.clear();
    for (const controller of ctx.seatControllers.values()) controller.abort();
    ctx.seatControllers.clear();
    ctx.transcriptSeats.clear();
    ctx.headSeats.clear();
    ctx.stopSummaryWatch();
    for (const timer of ctx.retryTimers) clearTimeout(timer);
    ctx.retryTimers.clear();
  }

  async function runSeat(seatId: string, signal: AbortSignal, mode: "status" | "head"): Promise<void> {
    let seeded = false;
    while (!signal.aborted) {
      try {
        const current = await ctx.runner.resolveTerminal(seatId);
        if (!isMessageableSeat(current)) {
          ctx.publishSeatStatus(seatId, "offline");
          await delay(RETRY_ADMISSION_MS);
          continue;
        }
        if (mode === "status") {
          ctx.publishSeatStatus(seatId, current.status);
          if (ctx.runner.waitForChange === undefined) return;
          await ctx.runner.waitForChange(current.paneId, current.status, signal);
          continue;
        }
        const hasTranscript = await ctx.publishSeatTranscript(seatId, current);
        // Publish status after the one-time transcript migration so the current
        // typing/delivery state remains the newest durable event.
        ctx.publishSeatStatus(seatId, current.status);
        if (!hasTranscript) {
          ctx.publishSeatSummary(seatId, current.paneId, readHerdrSummariesFile(ctx.summariesPath).agents);
        }
        // Seed the thread with the pane's last settled answer so a freshly
        // opened seat conversation starts with what the agent already said.
        // The registry dedups an identical re-projection (restart, re-track).
        if (!hasTranscript && !seeded && REPLY_STATUSES.has(current.status)) {
          const reply = await ctx.readSeatReply(current, "recent-unwrapped");
          if (reply !== undefined) ctx.projectSeat?.(seatId, { kind: "reply", text: reply });
        }
        seeded = true;
        if (ctx.runner.waitForChange === undefined) return;
        const piBaseline =
          current.status === "working" && current.agent === "pi"
            ? await ctx.readSeatReply(current, "visible")
            : undefined;
        const changed = await ctx.followTranscript(
          seatId,
          current,
          ctx.runner.waitForChange(current.paneId, current.status, signal),
          signal,
        );
        if (current.status === "working" && REPLY_STATUSES.has(changed.status)) {
          const changedHasTranscript = await ctx.publishSeatTranscript(seatId, changed);
          const reply = changedHasTranscript
            ? undefined
            : await ctx.readSeatReply(changed, "recent-unwrapped");
          if (
            reply !== undefined &&
            (changed.agent !== "pi" || (piBaseline !== undefined && reply !== piBaseline))
          ) {
            ctx.projectSeat?.(seatId, { kind: "reply", text: reply });
          }
        }
      } catch {
        if (signal.aborted) return;
        ctx.publishSeatStatus(seatId, "offline");
        await delay(RETRY_ADMISSION_MS);
      }
    }
  }

  /**
   * Re-read the harness transcript while the pane works, so every message and
   * tool call reaches the app as it lands instead of only when the pane
   * settles. The registry drops entries it already holds, so a re-publish that
   * saw no new output costs nothing downstream.
   */
  // ponytail: the reader tails Codex, Grok and Claude by byte offset (Claude
  // replays from its last safe point when parallel results branch its chain),
  // so a poll costs the append rather than the session. Pi still re-parses on
  // change; give it Claude's checkpointed fold if a long Pi seat shows up in a profile.
  async function followTranscript(
    seatId: string,
    current: HerdrAgentSnapshot,
    changed: Promise<HerdrAgentSnapshot>,
    signal: AbortSignal,
  ): Promise<HerdrAgentSnapshot> {
    if (current.status !== "working" || !ctx.transcriptSeats.has(seatId)) return changed;
    const tick = Symbol("tail");
    while (!signal.aborted) {
      const settled = await Promise.race([changed, delay(ctx.seatTranscriptTailMs).then(() => tick)]);
      if (typeof settled !== "symbol") return settled;
      await ctx.publishSeatTranscript(seatId, current);
    }
    return changed;
  }

  async function publishSeatTranscript(seatId: string, agent: HerdrAgentSnapshot): Promise<boolean> {
    if (ctx.runner.transcript === undefined) return false;
    try {
      const transcript = await ctx.runner.transcript(agent);
      if (transcript === undefined) {
        ctx.transcriptSeats.delete(seatId);
        return false;
      }
      ctx.transcriptSeats.add(seatId);
      ctx.projectSeat?.(seatId, { kind: "transcript", transcript });
      return true;
    } catch {
      ctx.transcriptSeats.delete(seatId);
      return false;
    }
  }

  async function readSeatReply(
    agent: HerdrAgentSnapshot,
    source: "visible" | "recent-unwrapped",
  ): Promise<string | undefined> {
    if (ctx.runner.read === undefined) return undefined;
    try {
      return distillHerdrSeatReply(agent.agent, await ctx.runner.read(agent.paneId, agent.agent, source));
    } catch {
      return undefined;
    }
  }

  function publishSeatStatus(seatId: string, status: string): void {
    if (ctx.seatStatuses.get(seatId) === status) return;
    ctx.seatStatuses.set(seatId, status);
    ctx.projectSeat?.(seatId, { kind: "status", status });
  }

  function publishSeatSummary(
    seatId: string,
    paneId: string,
    summaries: Readonly<Record<string, HerdrAgentSummary>>,
  ): void {
    const raw = summaries[paneId]?.summary;
    const text =
      raw === undefined
        ? undefined
        : bounded(
            redactSensitiveText(stripVTControlCharacters(raw).trim()),
            OPERATOR_CONVERSATION_SUMMARY_MAX,
          );
    if (text === undefined) {
      ctx.seatSummaries.delete(seatId);
      return;
    }
    if (ctx.seatSummaries.get(seatId) === text) return;
    ctx.seatSummaries.set(seatId, text);
    ctx.projectSeat?.(seatId, { kind: "summary", text });
  }

  function ensureSummaryWatch(): void {
    if (ctx.watchingSummaries) return;
    watchFile(
      ctx.summariesPath,
      { interval: ctx.summaryWatchIntervalMs, persistent: false },
      ctx.onSummariesChanged,
    );
    ctx.watchingSummaries = true;
  }

  function stopSummaryWatch(): void {
    if (!ctx.watchingSummaries) return;
    unwatchFile(ctx.summariesPath, ctx.onSummariesChanged);
    ctx.watchingSummaries = false;
  }

  function launch(record: HerdrWatchRecord): void {
    if (ctx.closed || ctx.wake === undefined || ctx.controllers.has(record.id)) return;
    const controller = new AbortController();
    ctx.controllers.set(record.id, controller);
    void ctx.run(record, controller.signal).finally(() => ctx.controllers.delete(record.id));
  }

  function watchOwner(record: HerdrWatchRecord): ConversationOwner | undefined {
    if (record.occupantId === undefined) return undefined;
    const owner =
      record.hired === true ? ctx.hireOwners.seatOwner(record.terminalId, record.occupantId) : undefined;
    if (record.hired === true && owner === undefined && ctx.hireOwners.hasClaim("", record.terminalId))
      return undefined;
    return (
      owner ?? {
        conversationId: record.conversationId,
        ...(record.discord === undefined ? {} : { discord: record.discord }),
      }
    );
  }

  async function run(record: HerdrWatchRecord, signal: AbortSignal): Promise<void> {
    let prompt: string;
    // Clean completions and unverified working observations join the round.
    // Gone, failed and waiting workers still need attention at once.
    let routine = false;
    let workingObservation = false;
    let observedPane: HerdrAgentSnapshot | undefined;
    let harvestMessageId = record.messageId;
    let completion: z.infer<typeof NativeCompletionSchema> | undefined;
    try {
      const current = await ctx.runner.resolveTerminal(record.terminalId);
      // A missing/rebound native occupant never contributes another worker's output.
      if (record.occupantId === undefined) {
        ctx.remove(record.id);
        return;
      }
      if (ctx.endsOnNativeChange(record, current)) return;
      if (current?.status !== "working" && record.workingNoticeDelivered) {
        delete record.workingNoticeDelivered;
        ctx.save();
      }
      if (current === undefined || current.status === "unknown") {
        prompt = watchPrompt(record, current, "The watched pane is gone.");
      } else {
        const control = await ctx.seatControl.attach(current);
        const held = control === undefined ? undefined : await control.status();
        if (
          record.messageId !== undefined ||
          (control !== undefined && held !== "released" && held !== "offline")
        ) {
          // The harness's own completion, not a status read off the terminal.
          const event = await ctx.seatControl.settled(
            current,
            signal,
            record.messageId,
            record.createdAt,
            async () => {
              await ctx.requireWorkerAccess?.(splitFleetQualified(current.paneId)?.fleet);
            },
          );
          if (event.type === "turn_completed") {
            harvestMessageId ??= event.messageId;
            completion = event;
          }
          const after = await ctx.runner.resolveTerminal(record.terminalId).catch(() => undefined);
          if (ctx.endsOnNativeChange(record, after)) return;
          prompt = watchPrompt(record, after ?? current, undefined, event);
          observedPane = after ?? current;
          workingObservation =
            event.type === "settlement_unconfirmed" &&
            event.observedStop?.ok !== false &&
            observedPane.status === "working";
          routine = (event.type === "turn_completed" && event.ok) || workingObservation;
        } else {
          const settled = SETTLED_STATUSES.has(current.status)
            ? current
            : await ctx.runner.wait(current.paneId, signal);
          if (ctx.endsOnNativeChange(record, settled)) return;
          // A transcript that cannot be read leaves the ordinary no-report wake.
          const reply = await ctx.lastReply?.(settled).catch(() => undefined);
          prompt = watchPrompt(record, settled, undefined, undefined, reply?.trim() || undefined);
          observedPane = settled;
          workingObservation = settled.status === "working";
          routine = settled.status === "done" || settled.status === "idle" || workingObservation;
        }
      }
    } catch {
      if (signal.aborted || ctx.closed) return;
      // A failed wait is not a settled pane. In particular, launcher shutdown
      // can terminate the child before captain.close aborts this store. Keep
      // the durable watch so a retry or the next service restores observation.
      ctx.retry(record);
      return;
    }
    if (signal.aborted) return;
    if (workingObservation && record.workingNoticeDelivered) {
      // Re-read native completion on retry: a correlated completion or failure
      // outranks an unchanged pane status. Never harvest this message as done.
      await ctx.retryWorking(record, observedPane, signal);
      return;
    }
    try {
      const owner = ctx.watchOwner(record);
      if (owner === undefined) {
        ctx.remove(record.id);
        return;
      }
      const guard = async () => {
        const live = await ctx.runner.resolveTerminal(record.terminalId);
        const nativeChanged =
          live !== undefined &&
          (live.session === undefined || occupantIdForHerdrSession(live.session) !== record.occupantId);
        // A changed occupant is refused here with no wake; only an unread session is retried.
        if (nativeChanged) {
          const change = ctx.nativeEnd(record, live);
          if (change !== "unread" && change !== undefined) ctx.settle(record, change);
        }
        if (
          signal.aborted ||
          ctx.closed ||
          !ctx.state.watches.some((watch) => watch.id === record.id) ||
          !isDeepStrictEqual(ctx.watchOwner(record), owner) ||
          nativeChanged
        )
          throw new Error("The watched worker changed its leading conversation before acceptance");
        if (!workingObservation && record.hired && harvestMessageId && record.occupantId) {
          const claim = ctx.harvestClaim(record.terminalId, record.occupantId, harvestMessageId);
          const superseded =
            record.messageId === undefined &&
            ctx.state.watches.some(
              (watch) =>
                watch.hired &&
                watch.terminalId === record.terminalId &&
                watch.occupantId === record.occupantId &&
                watch.messageId === harvestMessageId,
            );
          if (superseded || (claim && claim.watchId !== record.id)) {
            ctx.remove(record.id);
            throw new Error("This native turn already has its original completion harvest");
          }
          if (!claim) {
            (ctx.state.harvestedTurns ??= []).push({
              terminalId: record.terminalId,
              occupantId: record.occupantId,
              messageId: harvestMessageId,
              watchId: record.id,
              ...(completion === undefined ? {} : { completion }),
            });
            // Claim before asynchronous acceptance. A restart or reconciled
            // receipt cannot create a second watch for this native turn.
            ctx.save();
          }
        }
      };
      // Watches retain their existing owner and prompt with an optional exact receipt
      // reservation. Automatic harvests also refresh adoption at the host boundary.
      const original: HerdrWatchWakeContext = {
        messageId: `seat-watch-${record.id}${record.noticeSequence ? `-${record.noticeSequence}` : ""}`,
        get receipt() {
          return record.wakeReceipt;
        },
        reserve: (receipt) => {
          const checked = HerdrWatchWakeReceiptSchema.parse(receipt);
          if (
            signal.aborted ||
            ctx.closed ||
            !ctx.state.watches.some((watch) => watch.id === record.id) ||
            checked.messageId !== original.messageId ||
            !isDeepStrictEqual(checked.owner, owner) ||
            !isDeepStrictEqual(ctx.watchOwner(record), owner) ||
            (record.wakeReceipt && !isDeepStrictEqual(record.wakeReceipt, checked))
          )
            throw new Error("Original completion wake reservation changed");
          record.wakeReceipt = checked;
          ctx.save();
        },
      };
      if (!workingObservation && record.occupantId && !record.workerSettledNotified && ctx.onWorkerSettled) {
        record.workerSettledNotified = true;
        ctx.save();
        try {
          ctx.onWorkerSettled(record.terminalId, record.occupantId);
        } catch (error) {
          console.warn("Worker settled notification failed", String(error));
        }
      }
      if (!ctx.wake) return;
      if (routine && owner.discord === undefined && record.wakeReceipt === undefined) {
        // A blocker arriving before the round must not wait behind this notice.
        const waiting = new AbortController();
        const abort = () => waiting.abort();
        signal.addEventListener("abort", abort, { once: true });
        try {
          const round = ctx.awaitRound?.(owner.conversationId, waiting.signal).then(() => "round");
          // Recheck native events too: an error may arrive while Herdr still
          // calls the pane working. Joining the same round retains its deadline.
          const change =
            round && workingObservation
              ? Promise.race([
                  delay(RETRY_ADMISSION_MS).then(() => "change"),
                  ...(observedPane && ctx.runner.waitForChange
                    ? [
                        ctx.runner
                          .waitForChange(observedPane.paneId, "working", waiting.signal)
                          .then(() => "change"),
                      ]
                    : []),
                ])
              : undefined;
          if ((await (change && round ? Promise.race([round, change]) : round)) === "change") {
            ctx.retry(record, 0);
            return;
          }
        } finally {
          waiting.abort();
          signal.removeEventListener("abort", abort);
        }
        if (signal.aborted || ctx.closed || !ctx.state.watches.some((watch) => watch.id === record.id))
          return;
      }
      const result = await ctx.wake(owner.conversationId, prompt, owner.discord, guard, original);
      if (result === "deferred") ctx.retry(record);
      else if (workingObservation) {
        record.workingNoticeDelivered = true;
        record.noticeSequence = (record.noticeSequence ?? 0) + 1;
        delete record.wakeReceipt;
        ctx.save();
        await ctx.retryWorking(record, observedPane, signal);
      } else ctx.remove(record.id);
    } catch (error) {
      if (error instanceof HerdrWatchWakeAbandonedError) {
        ctx.settle(record, "wake_abandoned", record.wakeReceipt?.messageId);
        return;
      }
      ctx.retry(record);
    }
  }

  /**
   * A different native session, or the harness gone from the pane, ends the
   * watch. A harness whose session is not readable right now is retried.
   */
  function nativeEnd(
    record: HerdrWatchRecord,
    live: HerdrAgentSnapshot | undefined,
  ): HerdrWatchEnd | "unread" | undefined {
    if (live === undefined) return undefined;
    if (live.session === undefined)
      return live.agent === "shell" || live.agent === "unknown" ? "native_agent_exited" : "unread";
    return occupantIdForHerdrSession(live.session) === record.occupantId
      ? undefined
      : "native_session_changed";
  }

  /**
   * Another occupant's output never reaches the arming lead or a harvest, so a
   * native change produces no wake. It is settled in the ledger and the log
   * instead of vanishing (VUH-2208).
   */
  function endsOnNativeChange(record: HerdrWatchRecord, live: HerdrAgentSnapshot | undefined): boolean {
    const change = ctx.nativeEnd(record, live);
    if (change === undefined) return false;
    if (change === "unread") ctx.retry(record);
    else ctx.settle(record, change);
    return true;
  }

  function writeSidecar(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  /** Terminal settlements, newest last; never a delivery claim. */
  function settlements(): readonly HerdrWatchSettlement[] {
    try {
      return z.array(HerdrWatchSettlementSchema).parse(JSON.parse(readFileSync(ctx.settlementsPath, "utf8")));
    } catch {
      return [];
    }
  }

  function recordSettlement(
    record: HerdrWatchRecord,
    outcome: HerdrWatchSettlement["outcome"],
    receiptId?: string,
  ): void {
    const settlement: HerdrWatchSettlement = {
      watchId: record.id,
      conversationId: record.conversationId,
      terminalId: record.terminalId,
      reason: record.reason,
      outcome,
      ...(receiptId === undefined ? {} : { receiptId }),
      settledAt: new Date().toISOString(),
    };
    ctx.writeSidecar(ctx.settlementsPath, [...ctx.settlements(), settlement].slice(-SETTLEMENTS_MAX));
    console.warn("Herdr watch ended without completion", JSON.stringify(settlement));
  }

  function settle(
    record: HerdrWatchRecord,
    outcome: HerdrWatchSettlement["outcome"],
    receiptId?: string,
  ): void {
    ctx.recordSettlement(record, outcome, receiptId);
    ctx.remove(record.id);
  }

  /** Observe state changes promptly, but still check native completion if status stays working. */
  async function retryWorking(
    record: HerdrWatchRecord,
    pane: HerdrAgentSnapshot | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (!pane || !ctx.runner.waitForChange) {
      ctx.retry(record);
      return;
    }
    const waiting = new AbortController();
    const abort = () => waiting.abort();
    signal.addEventListener("abort", abort, { once: true });
    let retryDelayMs = 0;
    await Promise.race([
      delay(RETRY_ADMISSION_MS),
      ctx.runner.waitForChange(pane.paneId, "working", waiting.signal),
    ])
      .catch((error) => {
        if (!signal.aborted) {
          console.warn("Herdr working watch observation failed", record.id, String(error));
          retryDelayMs = RETRY_ADMISSION_MS;
        }
      })
      .finally(() => {
        waiting.abort();
        signal.removeEventListener("abort", abort);
        if (!signal.aborted) ctx.retry(record, retryDelayMs);
      });
  }

  function retry(record: HerdrWatchRecord, delayMs = RETRY_ADMISSION_MS): void {
    if (ctx.closed) return;
    const timer = setTimeout(() => {
      ctx.retryTimers.delete(timer);
      if (ctx.state.watches.some((watch) => watch.id === record.id)) ctx.launch(record);
    }, delayMs);
    timer.unref?.();
    ctx.retryTimers.add(timer);
  }

  function harvestClaim(terminalId: string, occupantId: string, messageId: string) {
    return ctx.state.harvestedTurns?.find(
      (claim) =>
        claim.terminalId === terminalId && claim.occupantId === occupantId && claim.messageId === messageId,
    );
  }

  function remove(id: string): void {
    const next = ctx.state.watches.filter((watch) => watch.id !== id);
    if (next.length === ctx.state.watches.length) return;
    ctx.state.watches = next;
    ctx.save();
  }
  return {
    freshRestartCandidates,
    hiredRestartReceipts,
    start,
    trackSeat,
    untrackSeat,
    watchHiredSeat,
    watch,
    cancelConversation,
    close,
    runSeat,
    followTranscript,
    publishSeatTranscript,
    readSeatReply,
    publishSeatStatus,
    publishSeatSummary,
    ensureSummaryWatch,
    stopSummaryWatch,
    launch,
    watchOwner,
    run,
    nativeEnd,
    endsOnNativeChange,
    writeSidecar,
    settlements,
    recordSettlement,
    settle,
    retryWorking,
    retry,
    harvestClaim,
    remove,
  };
}
