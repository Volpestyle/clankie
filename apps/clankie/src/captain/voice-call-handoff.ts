import { CAPTAIN_SILENT_REPLY_SENTINEL, type CaptainChannelTurnResult } from "@clankie/protocol";
import type { ConversationStore } from "./conversations.ts";
import { deliveryFingerprint } from "./delivery-fence.ts";
import { roomSeatTurnResult } from "./room-conversations.ts";

/**
 * A device call's `ask_clankie` (VUH-2682), through the linked-channel path
 * (ADR 0218): one queued turn in the main conversation that a live native
 * head answers through a reply-bearing escalation, or the service runner
 * answers otherwise. It shows there like any other turn; only its final
 * answer returns to the call. A stable original keeps a restart from
 * dispatching the same ask twice.
 */
export async function voiceCallHandoff(
  conversations: Pick<ConversationStore, "defaultGlobalConversationId" | "replyToLinkedChannel">,
  shutdown: AbortSignal,
  input: { readonly deliveryId: string; readonly request: string; readonly context?: string },
): Promise<CaptainChannelTurnResult> {
  const mainId = conversations.defaultGlobalConversationId();
  const messageId = `voice-call-${deliveryFingerprint(input.deliveryId)}`;
  const content = [
    "Your owner is on a live voice call with you from their own device, and your voice is handing you something they asked for. Answer here yourself, as you would in the console.",
    `If this arrives as a native escalation, use its reply tool and event_id; in the service runner, answer normally. Only this request's final answer returns to the call, where your voice gives the gist aloud; keep anything long here in text. You may reply with exactly ${CAPTAIN_SILENT_REPLY_SENTINEL} to send nothing.`,
    "Request from your voice, then what was said on the call (the owner's speech, transcribed):",
    JSON.stringify({
      request: input.request,
      ...(input.context === undefined ? {} : { call: input.context }),
    }),
  ].join("\n\n");
  const completed = await conversations.replyToLinkedChannel(mainId, content, {
    messageId,
    // A hang-up does not cancel work the main conversation accepted; only shutdown does.
    guard: async () => shutdown.throwIfAborted(),
    surfaceClientId: "voice-call",
  });
  const deliveryStage =
    completed.deliveryStage === undefined ? {} : { deliveryStage: completed.deliveryStage };
  return (
    roomSeatTurnResult(
      completed.response !== undefined
        ? { outcome: "replied", text: completed.response, ...deliveryStage }
        : completed.deliveryStage === "uncertain"
          ? {
              outcome: "unconfirmed",
              messageId,
              detail: "Main delivery is uncertain",
              deliveryStage: "uncertain",
            }
          : { outcome: "delivered", ...deliveryStage },
      mainId,
      messageId,
    ) ?? { state: "failed", code: "captain_response_missing" }
  );
}
