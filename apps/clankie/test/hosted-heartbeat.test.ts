import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedHeartbeat, isHostedCustomerWork } from "../src/hosted-heartbeat.ts";
afterEach(() => vi.useRealTimers());
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
describe("hosted busy heartbeat", () => {
  it("sends transitions and renews at one minute busy and five minutes idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_000_000_000);
    const post = vi.fn(async () => Response.json({ desired: "running" }));
    const heartbeat = new HostedHeartbeat({ post });
    heartbeat.start();
    await settle();
    expect(post).toHaveBeenLastCalledWith("heartbeat", { busy: false, reasons: [] });
    await vi.advanceTimersByTimeAsync(299999);
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(post).toHaveBeenCalledTimes(2);
    const end1 = heartbeat.begin("captain-turn");
    await settle();
    const end2 = heartbeat.begin("captain-turn");
    await settle();
    expect(post).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60000);
    expect(post).toHaveBeenCalledTimes(4);
    end1();
    await settle();
    expect(post).toHaveBeenCalledTimes(4);
    end2();
    await settle();
    expect(post).toHaveBeenLastCalledWith("heartbeat", { busy: false, reasons: [] });
    heartbeat.close();
    await vi.advanceTimersByTimeAsync(600000);
    expect(post).toHaveBeenCalledTimes(5);
  });
  it("reports each reason and customer work without making presence busy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_000_000_000);
    const post = vi.fn(async () => Response.json({ desired: "running" }));
    const heartbeat = new HostedHeartbeat({ post });
    heartbeat.start();
    await settle();
    heartbeat.interactive();
    await settle();
    expect(post).toHaveBeenLastCalledWith("heartbeat", {
      busy: false,
      reasons: [],
      lastInteractiveAtMs: Date.now(),
    });
    heartbeat.setExternal("herdr-agent", true);
    await settle();
    const end = heartbeat.begin("scheduled-job");
    await settle();
    expect(heartbeat.snapshot()).toMatchObject({ busy: true, reasons: ["herdr-agent", "scheduled-job"] });
    end();
    heartbeat.setExternal("herdr-agent", false);
    await settle();
    expect(heartbeat.snapshot().busy).toBe(false);
    heartbeat.close();
  });
  it("coalesces in-flight updates, retries failures, and exposes sleep intent", async () => {
    vi.useFakeTimers();
    const onDesired = vi.fn();
    const post = vi.fn(async () => Response.json({ desired: "sleeping" }));
    post.mockRejectedValueOnce(new Error("offline"));
    const heartbeat = new HostedHeartbeat({ post }, { onDesired });
    heartbeat.start();
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(post).toHaveBeenCalledTimes(2);
    expect(onDesired).toHaveBeenCalledWith("sleeping");
    heartbeat.close();
  });
});
it("classifies accepted device mutations while excluding tails, reads, auth and polling", () => {
  const classify = (op: string, extra: Record<string, unknown> = {}) =>
    isHostedCustomerWork("POST", "/operator/v1/dispatch", JSON.stringify({ schemaVersion: 1, op, ...extra }));
  expect(
    classify("send", {
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: "conversation-1",
        message: "hello",
        surfaceClientId: "phone",
        expectedRevision: 0,
      },
    }),
  ).toBe(true);
  expect(classify("cancel", { conversationId: "conversation-1", runId: "run-1" })).toBe(true);
  expect(classify("list")).toBe(false);
  expect(classify("fleet")).toBe(false);
  expect(isHostedCustomerWork("POST", "/v1/pairing/complete", "{}")).toBe(true);
  expect(isHostedCustomerWork("POST", "/operator/v1/tail", "{}")).toBe(false);
  expect(isHostedCustomerWork("POST", "/v1/devices/self/session/refresh", "{}")).toBe(false);
  expect(isHostedCustomerWork("GET", "/v1/devices/self", "")).toBe(false);
  expect(isHostedCustomerWork("POST", "/operator/v1/dispatch", "bad")).toBe(false);
});
