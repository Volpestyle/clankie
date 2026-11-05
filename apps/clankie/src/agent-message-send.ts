import { fleetDeliveryStage } from "@clankie/protocol";
import type {
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
} from "@clankie/protocol";
import type { CaptainPort } from "./captain/port.ts";
import { AgentMessageReceipts } from "./agent-message-receipts.ts";
import type { AgentMessageReceiptAuthority } from "./agent-message-receipt-service.ts";
import type { AgentMessageObservations } from "./agent-message-observations.ts";
import type { NativeMessageObservation } from "./agent-message-dispatch.ts";

/** Reserve an authenticated original before the existing send path; duplicates never enter that path. */
export async function sendAgentMessageWithReceipt(input: {
  request: Extract<OperatorConversationServiceRequest, { op: "send" }>;
  captain: CaptainPort;
  receipts: AgentMessageReceipts;
  authorize: () => Promise<AgentMessageReceiptAuthority | undefined>;
  current: () => boolean;
  observations?: AgentMessageObservations;
}): Promise<Extract<OperatorConversationServiceResult, { op: "send" }>> {
  const { request, captain, receipts } = input;
  if (!request.receiptRequestId) throw new Error("receipt_request_required");
  if (
    request.turn.kind !== "message" ||
    request.turn.delivery !== undefined ||
    request.turn.freeAgent !== undefined ||
    request.turn.workHandoff !== undefined
  )
    throw new Error("agent_message_mode_unsupported");
  const authority = await input.authorize();
  if (!authority || !authority.sessionId || authority.ownerInspection)
    throw new Error("agent_message_forbidden");
  const { deviceId, sessionId, authorizationRevision } = authority;
  const authorize = async () => {
    const fresh = await input.authorize();
    if (
      !fresh ||
      fresh.deviceId !== deviceId ||
      fresh.sessionId !== sessionId ||
      fresh.authorizationRevision !== authorizationRevision ||
      !input.current()
    )
      throw new Error("agent_message_forbidden");
  };
  const {
    expectedRevision: _revision,
    surfaceClientId: _surface,
    herdrPaneId: _pane,
    ...original
  } = request.turn;
  const recovered = receipts.recover({
    senderDeviceId: deviceId,
    senderSessionId: sessionId,
    requestKey: request.receiptRequestId,
    targetKey: request.turn.conversationId,
    message: JSON.stringify(original),
  });
  if (recovered.outcome === "conflict") throw new Error("agent_message_request_conflict");
  if (recovered.outcome === "existing") {
    const result = receipts.sendResult(recovered.receiptId, deviceId, sessionId) ?? {
      schemaVersion: 1 as const,
      status: "seat_delivery_unconfirmed" as const,
      conversationId: request.turn.conversationId,
      currentRevision: request.turn.expectedRevision,
      safeCursor: "0000000000000000",
      detail: "The original send is unresolved. Nothing was resent; inspect its receipt.",
    };
    await authorize();
    return { op: "send", schemaVersion: 1, receiptId: recovered.receiptId, result };
  }
  const thread = await captain.serveOperatorConversation({
    op: "get",
    schemaVersion: 1,
    conversationId: request.turn.conversationId,
  });
  if (thread.op !== "get" || thread.conversation?.scope.kind !== "persona")
    throw new Error("agent_message_recipient_unavailable");
  const personaId = thread.conversation.scope.personaId;
  const fleet = await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1, view: "home" });
  if (fleet.op !== "fleet") throw new Error("agent_message_recipient_unavailable");
  const seat = fleet.snapshot.seats.find((candidate) => candidate.personaId === personaId);
  if (!seat) throw new Error("agent_message_recipient_unavailable");
  await authorize();
  const binding = { machineId: seat.fleet ?? "local", seatId: seat.seatId, instanceId: seat.occupantId };
  const begun = receipts.begin({
    senderDeviceId: deviceId,
    senderSessionId: sessionId,
    requestKey: request.receiptRequestId,
    agent: "herdr:" + seat.seatId,
    binding,
    message: JSON.stringify(original),
    targetKey: request.turn.conversationId,
  });
  if (begun.outcome === "conflict") throw new Error("agent_message_request_conflict");
  const receiptId = begun.receiptId;
  if (begun.outcome === "existing") {
    const result = receipts.sendResult(receiptId, deviceId, sessionId) ?? {
      schemaVersion: 1 as const,
      status: "seat_delivery_unconfirmed" as const,
      conversationId: request.turn.conversationId,
      currentRevision: thread.conversation.revision,
      safeCursor: "0000000000000000",
      detail: "The original send is unresolved. Nothing was resent; inspect its receipt.",
    };
    await authorize();
    return { op: "send", schemaVersion: 1, receiptId, result };
  }
  await authorize();
  let native: NativeMessageObservation | undefined;
  const served = await captain.serveOperatorConversation(request, undefined, undefined, undefined, {
    receiptId,
    binding,
    authorize,
    current: input.current,
    nativeObservation: (source) => {
      native = source;
    },
    delivered: (delivery) => {
      if ("messageId" in delivery && delivery.messageId)
        receipts.bindNativeMessage(receiptId, binding, delivery.messageId);
      receipts.delivery(
        receiptId,
        binding,
        delivery.outcome === "delivered"
          ? delivery.state === "queued" &&
            !(delivery.detail === undefined && fleetDeliveryStage(delivery) === "consumed")
            ? "queued"
            : "delivered"
          : delivery.outcome === "offline"
            ? "unavailable"
            : delivery.outcome === "undelivered"
              ? "refused"
              : "uncertain",
      );
      const originalNative = native;
      if (
        delivery.outcome === "delivered" &&
        originalNative &&
        originalNative.messageId === delivery.messageId
      )
        void input.observations?.start({
          receiptId,
          binding,
          native: originalNative,
          authorize,
          current: input.current,
        });
    },
  });
  if (served.op !== "send") throw new Error("Unexpected send result");
  receipts.settleSend(receiptId, binding, served.result);
  if (served.result.status === "seat_offline") receipts.delivery(receiptId, binding, "unavailable");
  else if (served.result.status === "seat_undelivered" || served.result.status === "revision_conflict")
    receipts.delivery(receiptId, binding, "refused");
  await authorize();
  return { ...served, receiptId };
}
