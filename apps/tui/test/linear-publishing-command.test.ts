import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runLinearCommand } from "../src/command/linear.ts";

describe("clankie linear post", () => {
  it("uses the connected tool bank and exposes a rejected write as failure", async () => {
    const callTool = vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ outcome: "ok", content: "receipt", isError: false }),
        },
      ],
    }));
    const args = { personaId: "worker-amber", issueId: "VUH-1518", body: "Outcome and evidence." };
    expect(
      await runLinearCommand(["post", "comment", "--json-stdin"], {
        callTool,
        stdin: Readable.from([JSON.stringify(args)]),
      }),
    ).toMatchObject({ ok: true });
    expect(callTool).toHaveBeenCalledExactlyOnceWith("linear_create_worker_comment", args);
    expect(
      await runLinearCommand(["post", "issue", "--json-stdin"], {
        callTool: async () => ({
          isError: true,
          content: [{ type: "text", text: "Unknown worker persona" }],
        }),
        stdin: Readable.from([JSON.stringify({ personaId: "unknown", title: "Test" })]),
      }),
    ).toMatchObject({ ok: false, isError: true });
  });

  it.each([
    { outcome: "refused", reason: "call_failed", detail: "Unknown worker persona" },
    { outcome: "ok", content: "Provider rejected the write", isError: true },
    { unexpected: "No confirmed host result" },
  ])("fails closed for the lane's wrapped host result: %j", async (host) => {
    expect(
      await runLinearCommand(["post", "comment", "--json-stdin"], {
        callTool: async () => ({ content: [{ type: "text", text: JSON.stringify(host) }] }),
        stdin: Readable.from([JSON.stringify({ personaId: "worker", issueId: "VUH-1518", body: "Result" })]),
      }),
    ).toMatchObject({ ok: false });
  });

  it("does not make a tool call for malformed input", async () => {
    const callTool = vi.fn();
    await expect(
      runLinearCommand(["post", "comment", "--json-stdin"], {
        callTool,
        stdin: Readable.from(["[]"]),
      }),
    ).rejects.toThrow("Expected a JSON object");
    expect(callTool).not.toHaveBeenCalled();
  });
});
