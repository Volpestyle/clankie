import { describe, expect, it, vi } from "vitest";
import {
  hostedHireCapacity,
  trackHostedConversationRunner,
  watchHostedHerdrWork,
} from "../src/hosted-work.ts";
import type { ConversationTurnContext } from "../src/captain/conversations.ts";
describe("hosted work lifetimes", () => {
  it.each([
    [undefined, "captain-turn"],
    ["hook", "captain-turn"],
    ["watch", "captain-turn"],
    ["goal", "scheduled-job"],
    ["wake", undefined],
  ] as const)("classifies %s and settles even after failure", async (origin, reason) => {
    const finish = vi.fn(),
      started = vi.fn(() => finish);
    let reject!: (error: Error) => void;
    const run = trackHostedConversationRunner(
      async () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
      started,
    );
    const context = {
      runId: "run",
      acceptedAt: new Date().toISOString(),
      signal: new AbortController().signal,
      draft: () => {},
      ...(origin === undefined ? {} : { origin, internal: true }),
    } satisfies ConversationTurnContext;
    const pending = run("conversation", "work", () => {}, context);
    if (reason === undefined) expect(started).not.toHaveBeenCalled();
    else expect(started).toHaveBeenCalledWith(reason);
    expect(finish).not.toHaveBeenCalled();
    reject(new Error("failed"));
    await expect(pending).rejects.toThrow("failed");
    expect(finish).toHaveBeenCalledTimes(reason === undefined ? 0 : 1);
  });
  it("observes working seats without a polling app", async () => {
    const changed = vi.fn();
    const stop = watchHostedHerdrWork(changed, {
      available: () => true,
      socketPath: "/tmp/clankie-hosted-test-no-socket",
      read: async () =>
        JSON.stringify({ result: { agents: [{ pane_id: "p1", agent: "claude", agent_status: "working" }] } }),
    });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(true));
    stop();
  });
  it("sees a worker stop soon after it stops, not at the next slow sample", async () => {
    let status = "working";
    const changed = vi.fn();
    const stop = watchHostedHerdrWork(changed, {
      available: () => true,
      socketPath: "/tmp/clankie-hosted-test-no-socket",
      read: async () =>
        JSON.stringify({ result: { agents: [{ pane_id: "p1", agent: "pi", agent_status: status }] } }),
      activeSampleMs: 20,
      idleSampleMs: 60_000,
    });
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(true));
    status = "idle";
    // An agent still exists, so the next sample is the short one.
    await vi.waitFor(() => expect(changed).toHaveBeenLastCalledWith(false), { timeout: 500 });
    stop();
  });
  it("samples slowly when no agent exists", async () => {
    const read = vi.fn(async () => JSON.stringify({ result: { agents: [] } }));
    const stop = watchHostedHerdrWork(vi.fn(), {
      available: () => true,
      socketPath: "/tmp/clankie-hosted-test-no-socket",
      read,
      activeSampleMs: 5,
      idleSampleMs: 60_000,
    });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(read).toHaveBeenCalledOnce();
    stop();
  });
  it("counts every live Herdr agent against the plan's limit, and claims nothing it cannot see", async () => {
    const agents = (n: number) =>
      JSON.stringify({
        result: {
          agents: Array.from({ length: n }, (_, i) => ({
            pane_id: `p${String(i)}`,
            agent: "pi",
            agent_status: "idle",
          })),
        },
      });
    expect(
      await hostedHireCapacity({ limit: 4, available: () => true, read: async () => agents(3) })(),
    ).toEqual({
      live: 3,
      limit: 4,
    });
    expect(
      await hostedHireCapacity({ limit: 4, available: () => false, read: async () => agents(9) })(),
    ).toBeUndefined();
    expect(
      await hostedHireCapacity({
        limit: 4,
        available: () => true,
        read: async () => {
          throw new Error("no socket");
        },
      })(),
    ).toBeUndefined();
  });
});
