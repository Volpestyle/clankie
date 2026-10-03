import type { BodyLeaseRouter } from "./body-lease-router.ts";
import type { BodyOwnerRoute } from "./body-leases.ts";
import type { CaptainPort } from "./captain/port.ts";

/** Explicit requests notify their captured conversation; they never perform a body effect. */
export async function pumpBodyRequests(
  router: BodyLeaseRouter,
  captain: Pick<CaptainPort, "validateConversationOwner" | "wakeConversation"> &
    Partial<Pick<CaptainPort, "designatedConversationHead">> & {
      routeCurrent?: (owner: BodyOwnerRoute["owner"]) => boolean;
    },
  current: () => boolean = () => true,
) {
  const valid = (id: string, route?: BodyOwnerRoute) =>
    route !== undefined && route.owner.conversationId === id;
  return router.deliverRequests({
    identity: async (id, route) =>
      !valid(id, route)
        ? undefined
        : {
            conversationId: id,
            route: route!,
            current: () => current() && captain.routeCurrent?.(route!.owner) !== false,
            authorize: async () => captain.validateConversationOwner(route!.owner, route!.mode),
          },
    designatedHead: (owner) => captain.designatedConversationHead?.(owner)?.conversationId,
    authorizeDelivery: async (source, destination, sourceRoute, destinationRoute) =>
      valid(source, sourceRoute) &&
      valid(destination, destinationRoute) &&
      (await captain.validateConversationOwner(sourceRoute!.owner, sourceRoute!.mode)) &&
      (await captain.validateConversationOwner(destinationRoute!.owner, destinationRoute!.mode)),
    deliver: async (destination, request, guard) => {
      if (!valid(destination, request.route)) return "rejected";
      const notice =
        request.kind === "queue"
          ? `The ${request.resource} resource you explicitly queued for is available. This is a notification; reacquire and recheck before any effect.`
          : `Conversation ${request.requester} explicitly asks the conversation holding ${request.resource}:\n${request.text}`;
      return (await captain.wakeConversation(request.route!.owner, notice, guard, request.route!.mode, false))
        ? "accepted"
        : "unavailable";
    },
  });
}
