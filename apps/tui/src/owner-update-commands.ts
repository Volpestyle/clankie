import {
  OperatorConversationServiceRequestSchema,
  type OperatorConversationServiceClient,
  type OwnerUpdate,
} from "@clankie/protocol";

/** Informational mail never resumes a conversation or answers an ask. */
export function ownerUpdateConsoleCommand(client: OperatorConversationServiceClient) {
  return async (argument: string): Promise<string> => {
    const [action = "list", value, ...extra] = argument.trim().split(/\s+/u).filter(Boolean);
    if (extra.length || !["list", "read", "dismiss"].includes(action))
      throw new Error("Usage: /updates [list [unread|read|dismissed|all] | read UUID | dismiss UUID]");
    const request = OperatorConversationServiceRequestSchema.parse(
      action === "list"
        ? { schemaVersion: 1, op: "owner_update_list", ...(value ? { state: value } : {}) }
        : {
            schemaVersion: 1,
            op: action === "read" ? "owner_update_read" : "owner_update_dismiss",
            id: value,
          },
    );
    if (request.op === "owner_update_list") {
      if (!client.ownerUpdateList) throw new Error("Owner updates are unavailable");
      const { updates } = await client.ownerUpdateList(request.state ? { state: request.state } : {});
      return updates.length ? updates.map(formatOwnerUpdate).join("\n\n") : "No owner updates";
    }
    if (request.op !== "owner_update_read" && request.op !== "owner_update_dismiss")
      throw new Error("Unexpected update request");
    if (!client.ownerUpdateRead || !client.ownerUpdateDismiss)
      throw new Error("Owner updates are unavailable");
    const result =
      request.op === "owner_update_read"
        ? await client.ownerUpdateRead(request.id)
        : await client.ownerUpdateDismiss(request.id);
    if (result.status === "refused") throw new Error(result.reason ?? "Update action refused");
    return result.update ? formatOwnerUpdate(result.update) : (result.reason ?? "Update resolved");
  };
}

function formatOwnerUpdate(update: OwnerUpdate): string {
  return [
    `${update.title} (${update.state})`,
    update.body ?? "",
    `Source: ${update.source.conversationId}${update.source.seatId ? `; worker ${update.source.seatId}` : ""}`,
    update.issue ? `Issue: ${update.issue.tracker} ${update.issue.key} — ${update.issue.url}` : "",
    ...(update.links ?? []).map((link) => `${link.label}: ${link.url}`),
    ...(update.media ?? []).map((media) => `${media.alt ?? media.mimeType}: ${media.url}`),
    `Update ${update.id}; ${update.at}`,
  ]
    .filter(Boolean)
    .join("\n");
}
