import { isDeepStrictEqual } from "node:util";
import { ConversationOwnerSchema, type ConversationOwner } from "./conversation-owner.ts";
import { ConversationServiceRun } from "./conversation-run.ts";
import type { ConversationStore } from "./conversations.ts";
import { HerdrWatchWakeAbandonedError, type HerdrWatchWakeContext } from "./herdr-watch.ts";
import type { ConversationOwnerMode, RoomOwnerAdmission, RoomTurns } from "./room-turns.ts";
import { SeatLinkInterruptedError, type SeatOutbox } from "./seat-outbox.ts";

export interface ConversationWakesContext {
  readonly conversations: ConversationStore;
  /** Watch (ADR 0308): no wake reaches a lead, native or service, while Clankie only watches. */
  readonly watching?: () => Promise<boolean>;
  readonly seatOutbox: (conversationId: string) => SeatOutbox;
  readonly watchRecipientBinding?: (conversationId: string) => Promise<string | undefined>;
  readonly shutdown: AbortController;
  /** The persona's room turns, absent while the persona is off (ADR 0328). */
  readonly rooms: () => RoomTurns | undefined;
}

/**
 * Who may still be woken, and the wake itself: an operator conversation takes
 * a captain turn, a remote lead hears it through its native head, and a room
 * hands it to the persona's room turns. Without the persona a Discord-origin
 * owner holds nothing.
 */
export function createConversationWakes(ctx: ConversationWakesContext) {
  async function validateConversationOwner(
    input: ConversationOwner,
    mode: ConversationOwnerMode = "machine",
    admission?: RoomOwnerAdmission,
  ): Promise<boolean> {
    const parsed = ConversationOwnerSchema.safeParse(input);
    if (!parsed.success) return false;
    const owner = parsed.data;
    // A remote lead's conversation leads its hires through its native head (ADR 0259).
    if (owner.discord === undefined)
      return (
        ctx.conversations.runsCaptainTurns(owner.conversationId) ||
        ctx.conversations.runsOnRemoteSeat(owner.conversationId)
      );
    const rooms = ctx.rooms();
    if (rooms === undefined) return false;
    return rooms.validateRoomOwner({ ...owner, discord: owner.discord }, mode, admission);
  }

  async function wakeConversation(
    input: ConversationOwner,
    notification: string,
    guard?: () => Promise<void>,
    mode: "machine" | "social" = "machine",
    allowHeadFallback = true,
    waitForCompletion = false,
    original?: HerdrWatchWakeContext,
  ): Promise<boolean> {
    if (await wakeExactConversation(input, notification, guard, mode, waitForCompletion, original))
      return true;
    if (original) return false;
    if (!allowHeadFallback || !(await validateConversationOwner(input, mode))) return false;
    const head = ctx.conversations.designatedHead(input.conversationId);
    if (head === undefined) return false;
    const finalGuard = async () => {
      await guard?.();
      if (!(await validateConversationOwner(input, mode)))
        throw new Error("Original conversation authority changed");
      if (
        ctx.conversations.designatedHead(input.conversationId) !== head ||
        !ctx.conversations.runsCaptainTurns(head)
      )
        throw new Error("Designated head authority changed");
    };
    return wakeExactConversation(
      { conversationId: head },
      notification,
      finalGuard,
      "machine",
      waitForCompletion,
      original,
    );
  }

  async function wakeExactConversation(
    input: ConversationOwner,
    notification: string,
    guard?: () => Promise<void>,
    mode: "machine" | "social" = "machine",
    waitForCompletion = false,
    original?: HerdrWatchWakeContext,
  ): Promise<boolean> {
    const owner = ConversationOwnerSchema.parse(input);
    if ((await ctx.watching?.()) === true) return false;
    if (!(await validateConversationOwner(owner, mode))) return false;
    if (original?.receipt) {
      const expected = original.receipt;
      if (expected.messageId !== original.messageId || !isDeepStrictEqual(expected.owner, owner))
        return false;
      await guard?.();
      const outbox = ctx.seatOutbox(owner.conversationId);
      // An abandoned original is never resent or claimed delivered: the watch ends.
      if (outbox.recoveryAbandoned(expected.messageId))
        throw new HerdrWatchWakeAbandonedError(
          "The owner settled this watch's original wake as abandoned-unknown",
        );
      const recipientBinding = ctx.watchRecipientBinding
        ? await ctx.watchRecipientBinding(owner.conversationId)
        : outbox.recipientBinding();
      await guard?.();
      if (
        !(await validateConversationOwner(owner, mode)) ||
        recipientBinding !== expected.recipientBinding ||
        (outbox.bound() && outbox.recipientBinding() !== expected.recipientBinding)
      )
        return false;
      try {
        const receipt = outbox.recoveryReceipt(expected.messageId);
        return (
          receipt?.messageId === expected.messageId &&
          receipt.fingerprint === expected.fingerprint &&
          receipt.sessionId === (expected.recipientBinding ?? "") &&
          outbox.recoveryAcknowledged(expected.messageId)
        );
      } catch {
        // Active, unreadable or absent originals never authorize a replacement.
        return false;
      }
    }
    if (owner.discord !== undefined) {
      // Once the exact room accepts the turn, never replay a failed harvest.
      return (
        (await ctx
          .rooms()
          ?.runDiscordWatchTurn(
            owner,
            notification,
            guard,
            mode,
            waitForCompletion,
            "escalation",
            original,
          )) ?? false
      );
    }
    if (ctx.conversations.runsOnRemoteSeat(owner.conversationId))
      return wakeRemoteConversation(owner.conversationId, notification, guard, original);
    await guard?.();
    if (!ctx.conversations.runsCaptainTurns(owner.conversationId)) return false;
    const result = ctx.conversations.submitInternal(
      owner.conversationId,
      notification,
      "watch",
      waitForCompletion ? "queue" : undefined,
    );
    if (result.status !== "accepted") return false;
    // Never redirect an accepted delivery, including one whose turn fails.
    if (waitForCompletion && !(await ctx.conversations.awaitRunResult(result.runId)))
      throw new Error("Fleet review turn did not complete");
    return true;
  }

  /**
   * A remote lead has no local captain turn to fall back on: its wake goes to
   * its native head over the bridge channel, or waits (false) for that head to
   * poll again. A watch's original receipt is reserved before the take, so a
   * restart reconciles it instead of sending it twice.
   */
  async function wakeRemoteConversation(
    conversationId: string,
    notification: string,
    guard?: () => Promise<void>,
    original?: HerdrWatchWakeContext,
  ): Promise<boolean> {
    const owner = { conversationId };
    return ctx.conversations.runWithConversationDriver<boolean>(
      conversationId,
      () => {
        const outbox = ctx.seatOutbox(conversationId);
        if (!outbox.routesToSeat(notification, original?.messageId)) return undefined;
        return {
          run: async () => {
            const preparation = new ConversationServiceRun(ctx.shutdown.signal);
            let recipientBinding: string | undefined;
            try {
              await preparation.wait("remote lead authority", guard?.() ?? Promise.resolve());
              if (original) {
                recipientBinding = ctx.watchRecipientBinding
                  ? await preparation.wait("remote lead recipient", ctx.watchRecipientBinding(conversationId))
                  : outbox.recipientBinding();
                await preparation.wait("remote lead final authority", guard?.() ?? Promise.resolve());
                if (original.receipt || outbox.recipientBinding() !== recipientBinding)
                  return { handled: true as const, result: false };
              }
            } finally {
              preparation.close();
            }
            ctx.shutdown.signal.throwIfAborted();
            const delivery = await outbox.deliver({
              kind: "watch",
              conversationId,
              source: "watch",
              content: notification,
              wantsReply: false,
              signal: ctx.shutdown.signal,
              ...(original === undefined
                ? {}
                : {
                    original: {
                      messageId: original.messageId,
                      prepare: (receipt: {
                        messageId: string;
                        fingerprint: string;
                        recipientBinding?: string;
                      }) => original.reserve({ ...receipt, owner }),
                    },
                    ...(recipientBinding === undefined ? {} : { recipientBinding }),
                  }),
            });
            if (delivery.outcome === "unbound") return { handled: false as const };
            // Unknown native acceptance is not a refusal that authorizes a replacement wake.
            if (original === undefined && delivery.outcome === "unconfirmed")
              throw new SeatLinkInterruptedError(delivery);
            return { handled: true as const, result: delivery.outcome === "delivered" };
          },
        };
      },
      async () => false,
      ctx.shutdown.signal,
    );
  }

  return { validateConversationOwner, wakeConversation };
}
