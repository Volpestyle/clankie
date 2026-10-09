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
