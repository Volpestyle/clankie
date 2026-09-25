import { afterEach, describe, expect, it, vi } from "vitest";
import { LINEAR_INBOX_CONTEXT_TOKENS, boundLinearInboxContext } from "../src/captain/captain.ts";
import { LINEAR_INBOX_CONVERSATION_ID } from "../src/captain/conversations.ts";

/** A headline wake must not resend weeks of inbox history (VUH-1362). */

afterEach(() => {
  vi.restoreAllMocks();
});

function session(tokens: number | null) {
  let current = tokens;
  const compact = vi.fn(() => {
    current = 4_000;
    return Promise.resolve({});
  });
  return {
    compact,
    getContextUsage: () => ({ tokens: current, contextWindow: 272_000, percent: null }),
  } as unknown as Parameters<typeof boundLinearInboxContext>[0] & { compact: typeof compact };
}

describe("the Linear inbox context bound", () => {
  it("keeps every wake bounded across a run of wakes, however large the history grew", async () => {
    const inbox = session(112_509);
    const sizes: number[] = [];
    for (let wake = 0; wake < 10; wake++) {
      await boundLinearInboxContext(inbox, LINEAR_INBOX_CONVERSATION_ID, "hook");
      sizes.push(inbox.getContextUsage()!.tokens!);
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(LINEAR_INBOX_CONTEXT_TOKENS);
    expect(inbox.compact).toHaveBeenCalledTimes(1);
  });

  it("leaves small inbox contexts, operator turns and other conversations alone", async () => {
    const small = session(LINEAR_INBOX_CONTEXT_TOKENS);
    await boundLinearInboxContext(small, LINEAR_INBOX_CONVERSATION_ID, "hook");
    const unknown = session(null);
    await boundLinearInboxContext(unknown, LINEAR_INBOX_CONVERSATION_ID, "hook");
    const operator = session(112_509);
    await boundLinearInboxContext(operator, LINEAR_INBOX_CONVERSATION_ID, undefined);
    const bound = session(112_509);
    await boundLinearInboxContext(bound, "project-conversation", "hook");
    for (const entry of [small, unknown, operator, bound]) expect(entry.compact).not.toHaveBeenCalled();
  });

  it("still wakes him when compaction fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inbox = session(112_509);
    inbox.compact.mockImplementation(() => Promise.reject(new Error("summarizer unavailable")));
    await expect(
      boundLinearInboxContext(inbox, LINEAR_INBOX_CONVERSATION_ID, "hook"),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledOnce();
  });
});
