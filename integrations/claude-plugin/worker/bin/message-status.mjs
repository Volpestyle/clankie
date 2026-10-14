const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const STAGES = new Set([
  "stored",
  "delivered",
  "consumed",
  "responded",
  "unavailable",
  "uncertain",
  "expired",
  "rejected",
]);

export const MESSAGE_CLANKIE_STATUS_TOOL = {
  name: "message_clankie_status",
  description:
    "Read the current delivery stage of your original message to Clankie by its returned deliveryId. Use before retrying or when your work depends on the message. Read-only: never resends, marks read, or changes a message. Stages describe delivery, not task completion. An unknown receipt does not prove nothing was sent; preserve and reconcile an uncertain original through message_clankie. Only definitive not_sent proves it was never sent.",
  inputSchema: {
    type: "object",
    properties: {
      deliveryId: {
        type: "string",
        format: "uuid",
        description: "The original message's returned deliveryId.",
      },
    },
    required: ["deliveryId"],
    additionalProperties: false,
  },
};

/** Uses only GET; deliberately independent of the sender's mutable receipt journal. */
export async function readMessageStatus(request, deliveryId) {
  if (typeof deliveryId !== "string" || !UUID.test(deliveryId))
    throw new Error("Use the original deliveryId UUID.");
  const response = await request(`/${encodeURIComponent(deliveryId)}/status?definitive=1`);
  if (!response.ok)
    throw new Error(`Message status lookup answered ${response.status}: ${await response.text()}`);
  const value = await response.json();
  if (
    value?.schemaVersion !== 1 ||
    value.deliveryId !== deliveryId ||
    !STAGES.has(value.deliveryStage) ||
    (value.definitive !== undefined &&
      (value.definitive !== "not_sent" || value.deliveryStage !== "unavailable")) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "deliveryId", "deliveryStage", "definitive"].includes(key),
    )
  )
    throw new Error("Message status lookup returned a malformed or mismatched receipt.");
  // The service sealed this original: it was never sent and never will be (VUH-2244).
  return value.definitive === "not_sent"
    ? {
        ...value,
        detail: `Message ${deliveryId} was not sent and never will be. If message_clankie still holds it, the next call settles it and sends nothing; send your message again after that.`,
      }
    : value;
}
