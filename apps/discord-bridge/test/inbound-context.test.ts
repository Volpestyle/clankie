import { describe, expect, it } from "vitest";
import { threadContextWindow } from "../src/inbound-context.ts";

const message = (id: string) => ({ id });

describe("threadContextWindow", () => {
  it("carries the opening post a thread's own history never returns", () => {
    const ordered = [message("in-thread-1"), message("in-thread-2")];
    const window = threadContextWindow(ordered, message("opening-post"), 10);
    expect(window.map((entry) => entry.id)).toEqual(["opening-post", "in-thread-1", "in-thread-2"]);
  });

  it("keeps the opening post when the recency bound is already full", () => {
    // Without its reserved slot the opening post is the oldest entry, so the
    // downstream `slice(-limit)` would drop exactly the message being added.
    const ordered = [1, 2, 3].map((index) => message(`in-thread-${String(index)}`));
    const window = threadContextWindow(ordered, message("opening-post"), 3);
    expect(window).toHaveLength(3);
    expect(window.map((entry) => entry.id)).toEqual(["opening-post", "in-thread-2", "in-thread-3"]);
  });

  it("leaves a forum post alone, whose opening message is already in the thread", () => {
    const ordered = [message("opening-post"), message("in-thread-1")];
    const window = threadContextWindow(ordered, message("opening-post"), 10);
    expect(window.map((entry) => entry.id)).toEqual(["opening-post", "in-thread-1"]);
  });

  it("is the plain history outside a thread", () => {
    const ordered = [message("a"), message("b")];
    expect(threadContextWindow(ordered, null, 10)).toBe(ordered);
  });

  it("gives a single-message budget to the opening post rather than overrunning it", () => {
    const ordered = [message("in-thread-1"), message("in-thread-2")];
    expect(threadContextWindow(ordered, message("opening-post"), 1).map((entry) => entry.id)).toEqual([
      "opening-post",
    ]);
  });
});
