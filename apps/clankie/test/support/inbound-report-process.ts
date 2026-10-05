import { join } from "node:path";
import { ConversationStore } from "../../src/captain/conversations.ts";
import { deliveryFingerprint } from "../../src/captain/delivery-fence.ts";

const [root, mode, deliveryId] = process.argv.slice(2);
if (!root || !deliveryId || (mode !== "queued" && mode !== "attempting"))
  throw new Error("Missing report-process fixture arguments");

const store = new ConversationStore(join(root, "conversations"), async (_id, message) => {
  if (message === "report") process.send?.({ state: "attempting" });
  await new Promise<void>(() => {});
});
if (mode === "queued") store.submitInternal("global-default", "held turn", "wake");
store.submitInbound("report", {
  deliveryId,
  binding: "a".repeat(64),
  fingerprint: deliveryFingerprint("report"),
  paneId: "w3Z:pR",
  text: "report",
  recipient: { kind: "conversation", owner: { conversationId: "global-default" } },
});
if (mode === "queued") setImmediate(() => process.send?.({ state: "pending" }));

// The IPC channel keeps the real service fixture alive until its parent kills
// it at a durable boundary. No graceful close can complete a queued report.
process.on("message", () => {});
