import { describe, expect, it, vi } from "vitest";
import type { OperatorConversation } from "@clankie/protocol";
import { runSendCommand } from "../src/command/send.ts";

const DEFAULT: OperatorConversation = {
  schemaVersion: 1,
  conversationId: "global-default",
  scope: { kind: "global" },
  title: "Clankie",
  isDefault: true,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  sessionState: "active",
  revision: 7,
};

/** A pipe hands over whatever chunks it likes, including one split mid-character. */
function pipe(payload: string, splitAt: number): AsyncIterable<Uint8Array> {
  const bytes = Buffer.from(payload, "utf8");
  return (async function* stream() {
    yield bytes.subarray(0, splitAt);
    yield bytes.subarray(splitAt);
  })();
}

function transport(requests: Array<Record<string, unknown>>): typeof fetch {
  return (async (_url: URL, init: { body: string }) => {
    const request = JSON.parse(init.body) as Record<string, unknown>;
    requests.push(request);
    return Response.json(
      request.op === "get"
        ? { op: "get", schemaVersion: 1, conversation: DEFAULT }
        : {
            op: "send",
            schemaVersion: 1,
            result: {
              schemaVersion: 1,
              status: "accepted",
              conversationId: DEFAULT.conversationId,
              runId: "run:test",
              revision: DEFAULT.revision + 1,
              safeCursor: "000000000001",
            },
          },
    );
  }) as unknown as typeof fetch;
}

describe("clankie send --stdin", () => {
  it("carries piped text to the send op with its newlines intact", async () => {
    // The em dash is three bytes, and the split lands inside it: a decoder that
    // works per chunk corrupts this message, a stream consumer does not.
    const message = "first line\nsecond — line\n\nfourth\n";
    const requests: Array<Record<string, unknown>> = [];
    const output: string[] = [];

    const exitCode = await runSendCommand(["--conversation", DEFAULT.conversationId, "--stdin"], {
      env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
      stdin: pipe(message, Buffer.from("first line\nsecond —", "utf8").length - 1),
      stdout: {
        write: (chunk: string) => output.push(chunk),
      },
      fetchImpl: transport(requests),
    });

    expect(exitCode).toBe(0);
    expect(requests[1]).toMatchObject({
      op: "send",
      turn: {
        conversationId: DEFAULT.conversationId,
        expectedRevision: DEFAULT.revision,
        // The shared turn schema trims the outer edges — the trailing newline a
        // pipe always adds — and leaves everything between them alone.
        message: "first line\nsecond — line\n\nfourth",
        delivery: "steer",
      },
    });
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "accepted", runId: "run:test" });
  });

  it("refuses a message given twice rather than picking one, before it dispatches", async () => {
    const fetchImpl = vi.fn();

    await expect(
      runSendCommand(["--conversation", DEFAULT.conversationId, "--stdin", "typed", "as", "well"], {
        env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
        stdin: pipe("piped\n", 3),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/not both/u);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("leaves an empty pipe to the same validation an empty message gets", async () => {
    const fetchImpl = vi.fn();

    await expect(
      runSendCommand(["--conversation", DEFAULT.conversationId, "--stdin"], {
        env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
        stdin: pipe("   \n", 2),
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Usage: clankie send/u);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
