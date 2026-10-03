import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OpenCodeReceiptFence } from "../src/command/opencode-receipts.ts";
// @ts-expect-error standalone native plugin ESM.
import { loadNativeContext } from "../../../integrations/opencode-plugin/runtime.mjs";
const sessionId = "ses_native123456";
const event = { id: "event1", content: "exact content", meta: {} };
it("fences a second launcher until the original native receipt is acknowledged", () => {
  const root = mkdtempSync(join(tmpdir(), "opencode-receipt-"));
  try {
    const file = join(root, "receipt.json");
    const first = new OpenCodeReceiptFence(file);
    first.claim({ sessionId, event });
    const restarted = new OpenCodeReceiptFence(file);
    expect(restarted.pending()).toEqual({ sessionId, event });
    expect(() => restarted.claim({ sessionId, event })).toThrow();
    expect(restarted.acknowledge("other-session", event.id)).toBe(false);
    expect(restarted.acknowledge(sessionId, "other-event")).toBe(false);
    expect(restarted.acknowledge(sessionId, event.id)).toBe(true);
    expect(first.pending()).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("reconciles only the complete event in a user message of the original native session", async () => {
  const text = `<clankie-seat-event>\n${JSON.stringify(event)}\n</clankie-seat-event>`;
  const messages = vi.fn(async () => ({
    data: [
      {
        info: { id: "m1", sessionID: sessionId, role: "user" },
        parts: [{ type: "text", text, sessionID: sessionId, messageID: "m1" }],
      },
    ],
  }));
  const client = {
    session: { get: async () => ({ data: { id: sessionId } }), messages, promptAsync: vi.fn() },
  };
  const bridge = vi.fn(async (action: string) =>
    action === "bind" ? { uncertain: { sessionId, event } } : { text: "identity" },
  );
  await expect(loadNativeContext(client, sessionId, bridge)).resolves.toBe("identity");
  expect(bridge).toHaveBeenCalledWith("reconcile", { sessionId, eventId: event.id, detail: text });
  expect(client.session.promptAsync).not.toHaveBeenCalled();
  messages.mockResolvedValueOnce({ data: [] });
  bridge.mockClear();
  await expect(loadNativeContext(client, sessionId, bridge)).rejects.toThrow(/every retry remains blocked/u);
  expect(bridge).not.toHaveBeenCalledWith("context", expect.anything());
});
