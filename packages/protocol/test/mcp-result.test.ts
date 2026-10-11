import { expect, it } from "vitest";
import { decodeMcpResult, readableMcpResult } from "../src/mcp-result.mjs";
import { formatToolOutput } from "../src/tool-output.ts";

it("decodes legacy and structured host results without nested JSON strings", () => {
  const data = { id: "VUH-1887", status: "Todo" };
  const legacy = {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          outcome: "ok",
          content: JSON.stringify(data),
          isError: false,
          receiptId: "receipt",
        }),
      },
    ],
  };
  expect(decodeMcpResult(legacy)).toMatchObject({ outcome: "ok", content: JSON.stringify(data) });
  const projected = readableMcpResult(legacy, "linear_get_issue");
  expect(decodeMcpResult(projected)).toEqual({
    outcome: "ok",
    content: data,
    isError: false,
    receiptId: "receipt",
  });
  expect(projected.content[0]?.text).toContain("VUH-1887");
  expect(formatToolOutput(projected)).toContainEqual({ kind: "text", text: JSON.stringify(data, null, 2) });
});

it("keeps refusal, uncertainty, receipt metadata and media when decoding", () => {
  for (const outcome of ["refused", "uncertain"]) {
    const media = { type: "image", data: "AA==", mimeType: "image/png" };
    const result = readableMcpResult({
      content: [
        { type: "text", text: JSON.stringify({ outcome, receiptId: "original", reason: "unavailable" }) },
        media,
      ],
      isError: outcome === "refused",
      _meta: { receipt: "original" },
    });
    expect(decodeMcpResult(result)).toMatchObject({ outcome, receiptId: "original" });
    expect(result.isError).toBe(outcome === "refused");
    expect(result._meta).toEqual({ receipt: "original" });
    expect(result.content).toContainEqual(media);
    expect(formatToolOutput(result)).toContainEqual({ kind: "image", uri: "data:image/png;base64,AA==" });
  }
});

it("an uncertain result names its receipt and why, so it can be reconciled or reported", () => {
  const deliveryId = "440ebcfc-180e-4f40-af4a-a55672d26593";
  const result = readableMcpResult(
    {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            schemaVersion: 1,
            deliveryId,
            outcome: "unconfirmed",
            deliveryStage: "uncertain",
            detail: "The original peer receipt is unresolved; no replacement was sent.",
          }),
        },
      ],
      isError: true,
    },
    "mcp__plugin_clankie-worker_worker__message_peer",
  );
  expect(result.content[0]?.text).toContain(`ID ${deliveryId}.`);
  expect(result.content[0]?.text).toContain("no replacement was sent");
  expect(decodeMcpResult(result)).toMatchObject({ deliveryId, deliveryStage: "uncertain" });
});

it("a settled-original refusal preserves the unsent-follow-up instruction instead of inviting reconciliation", () => {
  const detail =
    "The original message is stored. This different follow-up was not sent. Call again with the distinct follow-up if still needed; do not resend the original.";
  const result = readableMcpResult(
    {
      content: [
        { type: "text", text: JSON.stringify({ received: false, deliveryStage: "unavailable", detail }) },
      ],
      isError: true,
    },
    "message_clankie",
  );
  expect(result.content[0]?.text).toContain(detail);
  expect(result.content[0]?.text).not.toMatch(/reconcile/i);
  expect(decodeMcpResult(result)).toMatchObject({ received: false, deliveryStage: "unavailable", detail });
});

// Retained shape of the read-only #house-hunting refusal (VUH-2142).
it("shows a room-turn refusal's real code through the worker MCP projection", () => {
  const failure = { state: "failed", code: "discord_owner_audience_required" };
  for (const value of [failure, { outcome: "ok", content: failure }]) {
    const result = readableMcpResult(
      {
        content: [{ type: "text", text: JSON.stringify(value) }],
        isError: true,
      },
      "room_turn",
    );
    expect(result.content[0]?.text).toContain("discord_owner_audience_required");
    expect(result.content[0]?.text).toContain("failed");
    expect(decodeMcpResult(result)).toEqual(value);
  }
});
