import { z } from "zod";

/** ADR 0211: receipt progress, never task progress or proof the model read it. */
export const DeliveryStageSchema = z.enum([
  "stored",
  "delivered",
  "consumed",
  "responded",
  "unavailable",
  "uncertain",
  "expired",
  "rejected",
]);
export type DeliveryStage = z.infer<typeof DeliveryStageSchema>;

export function headSeatDeliveryStage(
  outcome: "delivered" | "replied" | "unconfirmed" | "unbound" | "aborted",
): DeliveryStage {
  return {
    delivered: "delivered",
    replied: "responded",
    unconfirmed: "uncertain",
    unbound: "unavailable",
    aborted: "expired",
  }[outcome] as DeliveryStage;
}

export function harnessDeliveryStage(
  outcome: "accepted" | "released" | "offline" | "unconfirmed",
): DeliveryStage {
  return outcome === "accepted" ? "consumed" : outcome === "unconfirmed" ? "uncertain" : "unavailable";
}

/** A mailbox bridge receipt alone has no native queue/turn acknowledgment. */
export function fleetDeliveryStage(result: {
  readonly outcome: "delivered" | "unconfirmed" | "undelivered" | "offline" | "seat_offline" | "unknown_seat";
  readonly state?: "queued" | "started" | "steered";
  readonly deliveryStage?: DeliveryStage;
}): DeliveryStage {
  if (result.outcome === "unconfirmed") return "uncertain";
  if (result.outcome !== "delivered") return result.deliveryStage === "rejected" ? "rejected" : "unavailable";
  if (result.deliveryStage === "stored") return "stored";
  // A bridge ACK is transport evidence even when the mailbox state is queued.
  if (result.deliveryStage === "delivered") return "delivered";
  return result.deliveryStage === "responded"
    ? "responded"
    : result.state === undefined
      ? "delivered"
      : "consumed";
}

/** Only explicit refusal/expiration is terminal; unknown failures retain uncertainty. */
export function discordDeliveryStage(result: {
  readonly state: "pending" | "settled" | "silent" | "absorbed" | "waiting_user" | "failed";
  readonly code?: string;
}): DeliveryStage {
  switch (result.state) {
    case "pending":
      return "stored";
    case "settled":
    case "silent":
    case "absorbed":
      return "responded";
    case "waiting_user":
      return "consumed";
    case "failed":
      return [
        "policy_refused",
        "validation_refused",
        "permission_denied",
        "captain_tools_not_allowed",
        "captain_usage_limit_reached",
      ].includes(result.code ?? "")
        ? "rejected"
        : result.code === "captain_turn_stalled"
          ? "expired"
          : "uncertain";
  }
}

export function hireDeliveryStage(
  result: { readonly outcome: "spawned" | "failed"; readonly reason?: string },
  hasBrief: boolean,
): DeliveryStage | undefined {
  if (result.outcome === "spawned") return hasBrief ? "consumed" : undefined;
  if (["start_unconfirmed", "delivery_unconfirmed"].includes(result.reason ?? "")) return "uncertain";
  return ["unknown_directory", "at_capacity", "trust_required"].includes(result.reason ?? "")
    ? "rejected"
    : "unavailable";
}

/** Busy means an existing stored event is waiting, not a native receipt. */
export function openCodeDeliveryStage(
  status: "pending" | "busy" | "delivered" | "uncertain" | "unbound" | "ready",
): DeliveryStage | undefined {
  if (status === "ready") return undefined;
  return status === "delivered"
    ? "consumed"
    : status === "uncertain"
      ? "uncertain"
      : status === "unbound"
        ? "unavailable"
        : "stored";
}
