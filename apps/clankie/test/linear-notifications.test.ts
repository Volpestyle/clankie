import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LinearNotifications } from "../src/linear-notifications.ts";
import type { McpHost } from "../src/mcp-host.ts";
import type { LinearActivityEvent } from "../src/linear-webhook.ts";

const roots: string[] = [];
const pollers: LinearNotifications[] = [];
afterEach(async () => {
  for (const poller of pollers.splice(0)) await poller.close();
  if (vi.isFakeTimers()) {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const NOW = "2026-09-27T12:00:00.000Z";
const own = {
  binding: "connection-bot",
  account: {
    provider: "linear" as const,
    connectionId: "bot",
    userId: "bot",
    workspaceId: "org",
    email: "connected-account@example.test",
    name: "clankie",
    workspaceName: "workspace",
    verifiedAt: NOW,
  },
};
const notification = (id: string, type = "issueNewComment", createdAt = NOW) => ({
  id,
  type,
  createdAt,
  updatedAt: createdAt,
  title: "Issue title",
  url: "https://linear.app/issue/ABC-1",
});
function pendingCall() {
  let resolve!: (result: Awaited<ReturnType<McpHost["call"]>>) => void;
  const promise = new Promise<Awaited<ReturnType<McpHost["call"]>>>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "linear-notifications-"));
  roots.push(root);
  const account = vi.fn(async () => own);
  const call = vi.fn<McpHost["call"]>();
  const received: { activity: LinearActivityEvent; following: boolean }[] = [];
  const receive = vi.fn((activity: LinearActivityEvent, following: boolean) => {
    received.push({ activity, following });
  });
  const following = vi.fn(async () => true);
  const onError = vi.fn();
  const options = {
    path: join(root, "cursor.json"),
    host: { account, call },
    following,
    receive,
    onError,
    now: () => new Date(NOW),
  };
  const page = (notifications: unknown[], hasNextPage = false, cursor?: string) => {
    call.mockResolvedValueOnce({
      outcome: "ok",
      isError: false,
      content: JSON.stringify({ notifications, hasNextPage, cursor }),
    });
  };
  const poller = new LinearNotifications(options);
  pollers.push(poller);
  return {
    options,
    poller,
    page,
    call,
    account,
    receive,
    received,
    following,
    onError,
  };
}

it("uses actual bot notifications for mentions, assignments, subscriptions and replies; never replays old history", async () => {
  const f = await fixture();
  const types = [
    "issueMention",
    "issueAssignedToYou",
    "issueNewComment",
    "issueCommentMention",
    "issueStatusChanged",
  ];
  f.page(
    types.slice(0, 3).map((type) => notification(type, type)),
    true,
    "next",
  );
  f.page([
    ...types.slice(3).map((type) => notification(type, type)),
    notification("old", "issueNewComment", "2026-09-26T12:00:00.000Z"),
  ]);
  await f.poller.poll();
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.received).toHaveLength(5);
  expect(f.received.every((entry) => entry.following)).toBe(true);
  expect(f.call.mock.calls[1]![0].arguments).toEqual({ limit: 50, unreadOnly: false, cursor: "next" });
  expect(f.received[0]!.activity).toMatchObject({
    organizationId: "org",
    type: "Notification",
    notification: true,
    eventId: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  // Read-state changes and the exact timestamp boundary never redeliver, even after restart.
  const reopened = new LinearNotifications(f.options);
  f.page(
    types.map((type) => ({
      ...notification(type, type),
      readAt: NOW,
      updatedAt: "2026-09-28T12:00:00.000Z",
    })),
  );
  await reopened.poll();
  expect(f.received).toHaveLength(5);
  f.page([notification("same-timestamp-new")]);
  await reopened.poll();
  expect(f.received).toHaveLength(6);
});

it("collects while off, suppresses self-authored notifications, and does not replay them when enabled", async () => {
  const f = await fixture();
  f.following.mockResolvedValue(false);
  f.page([notification("off")]);
  await f.poller.poll();
  expect(f.received[0]!.following).toBe(false);
  f.following.mockResolvedValue(true);
  f.page([notification("off"), { ...notification("self"), actor: { id: "bot" } }, notification("human")]);
  await f.poller.poll();
  expect(f.received.map((entry) => [entry.activity.data.id, entry.following])).toEqual([
    ["off", false],
    ["human", true],
    ["self", false],
  ]);
});

it("retries failed pagination and persistence without advancing the checkpoint", async () => {
  const f = await fixture();
  f.page([notification("one", "issueMention", "2026-09-27T12:01:00.000Z")], true, "next");
  f.call.mockRejectedValueOnce(new Error("offline"));
  await f.poller.poll();
  expect(f.received).toEqual([]);
  expect(JSON.parse(await readFile(f.options.path, "utf8")).since).toBe(NOW);
  f.receive.mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  f.page([notification("one", "issueMention", "2026-09-27T12:01:00.000Z")]);
  await f.poller.poll();
  expect(JSON.parse(await readFile(f.options.path, "utf8")).since).toBe(NOW);
  f.page([notification("one", "issueMention", "2026-09-27T12:01:00.000Z")]);
  await f.poller.poll();
  expect(f.received).toHaveLength(1);
  expect(f.onError).toHaveBeenCalledTimes(2);
});

it("rejects repeated pagination cursors and account changes; disconnected accounts stay passive", async () => {
  const f = await fixture();
  f.page([notification("a")], true, "same");
  f.page([notification("b")], true, "same");
  await f.poller.poll();
  expect(f.onError).toHaveBeenCalledTimes(1);
  expect(f.received).toEqual([]);
  f.account.mockResolvedValueOnce(own).mockResolvedValueOnce({ ...own, binding: "someone-else" });
  f.page([notification("a")]);
  await f.poller.poll();
  expect(f.received).toEqual([]);
  f.account.mockRejectedValueOnce(new Error("disconnected"));
  await f.poller.poll();
  expect(f.received).toEqual([]);
});

it("coalesces concurrent polls and rechecks follow before admitting a wake", async () => {
  const f = await fixture();
  f.following.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  f.page([notification("a")]);
  await Promise.all([f.poller.poll(), f.poller.poll()]);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(f.received[0]!.following).toBe(false);
  await f.poller.close();
  await f.poller.poll();
  expect(f.call).toHaveBeenCalledTimes(1);
});

it("follows a replacement connected identity without depending on an email or display name", async () => {
  const f = await fixture();
  f.page([notification("same-provider-id")]);
  await f.poller.poll();
  const firstId = f.received[0]!.activity.eventId;
  const replacement = {
    binding: "replacement-connection",
    account: {
      ...own.account,
      userId: "another-user",
      workspaceId: "another-workspace",
      email: "owner@another-company.test",
      name: "Owner-selected identity",
    },
  };
  f.account.mockResolvedValue(replacement);
  f.page([
    { ...notification("same-provider-id"), actor: { id: "another-user" } },
    { ...notification("former-account"), actor: { id: own.account.userId } },
  ]);
  await f.poller.poll();
  expect(f.received[1]).toMatchObject({
    following: true,
    activity: { organizationId: "another-workspace", actorId: "bot" },
  });
  expect(f.received[2]).toMatchObject({
    following: false,
    activity: { organizationId: "another-workspace", actorId: "another-user" },
  });
  expect(f.received[2]!.activity.eventId).not.toBe(firstId);
});

it("debounces webhook bursts, collects while off, and skips retry when a notification arrives", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.following.mockResolvedValue(false);
  f.page([notification("new")]);
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(1_000);
  f.poller.requestPoll();
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(1_499);
  expect(f.call).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.received).toMatchObject([{ following: false, activity: { data: { id: "new" } } }]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.call).toHaveBeenCalledTimes(1);
  await f.poller.close();
});

it("retries once when the notification lags behind the webhook, including duplicate-only reads", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.page([notification("old")]);
  await f.poller.poll();
  f.page([notification("old")]);
  f.page([notification("new"), notification("old")]);
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(f.received).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(f.received).toHaveLength(2);
  f.page([]);
  f.page([]);
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.call).toHaveBeenCalledTimes(5);
  expect(f.onError).not.toHaveBeenCalled();
  await f.poller.close();
});

it("waits for an active poll and coalesces deliveries during the subsequent refresh", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const first = pendingCall();
  const second = pendingCall();
  f.call.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const running = f.poller.poll();
  await vi.advanceTimersByTimeAsync(0);
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(1_500);
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.call).toHaveBeenCalledTimes(1);
  first.resolve({
    outcome: "ok",
    isError: false,
    content: JSON.stringify({ notifications: [], hasNextPage: false }),
  });
  await running;
  await vi.advanceTimersByTimeAsync(0);
  expect(f.call).toHaveBeenCalledTimes(2);
  f.poller.requestPoll();
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.call).toHaveBeenCalledTimes(2);
  f.page([notification("after")]);
  second.resolve({
    outcome: "ok",
    isError: false,
    content: JSON.stringify({ notifications: [], hasNextPage: false }),
  });
  await vi.advanceTimersByTimeAsync(1_500);
  expect(f.call).toHaveBeenCalledTimes(3);
  expect(f.received).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.call).toHaveBeenCalledTimes(3);
  await f.poller.close();
});

it("reads at startup and every 30 seconds without webhooks, and cancels timers on close", async () => {
  vi.useFakeTimers();
  const interval = vi.spyOn(globalThis, "setInterval");
  const f = await fixture();
  f.page([]);
  f.poller.start();
  f.poller.start();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(interval).toHaveBeenCalledTimes(1);
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 30_000);
  f.page([notification("fallback")]);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(f.received).toHaveLength(1);
  expect(f.received[0]?.following).toBe(true);
  expect(vi.getTimerCount()).toBe(1);
  interval.mockRestore();
  f.poller.requestPoll();
  await f.poller.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);

  const retry = await fixture();
  retry.page([]);
  retry.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(1_500);
  await retry.poller.close();
  retry.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(retry.call).toHaveBeenCalledTimes(1);
});

it("coalesces fallback ticks with an active webhook read", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.page([]);
  f.poller.start();
  await vi.advanceTimersByTimeAsync(0);
  const result = pendingCall();
  f.call.mockReturnValueOnce(result.promise);
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.call).toHaveBeenCalledTimes(2);
  result.resolve({
    outcome: "ok",
    isError: false,
    content: JSON.stringify({ notifications: [notification("webhook")], hasNextPage: false }),
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.received).toHaveLength(1);
  f.page([notification("fallback-after-webhook")]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.call).toHaveBeenCalledTimes(3);
  expect(f.received).toHaveLength(2);
});

it("makes one catch-up attempt after a failed startup read, without a recurring failure loop", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.call.mockRejectedValueOnce(new Error("offline"));
  f.page([notification("recovered")]);
  f.poller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.call).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(f.received).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  await f.poller.close();

  const offline = await fixture();
  offline.call.mockRejectedValue(new Error("still offline"));
  offline.poller.start();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(offline.call).toHaveBeenCalledTimes(2);
  expect(offline.onError).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1_501);
  expect(offline.call).toHaveBeenCalledTimes(4);
  expect(offline.onError).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(1);
  offline.page([notification("next-webhook")]);
  offline.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(1_500);
  expect(offline.received).toHaveLength(1);
});

it("catches up from a persisted checkpoint on startup without replaying seen notifications", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  f.page([notification("seen")]);
  await f.poller.poll();
  await f.poller.close();
  const restarted = new LinearNotifications(f.options);
  pollers.push(restarted);
  f.page([
    notification("during-downtime", "issueNewComment", "2026-09-27T12:01:00.000Z"),
    notification("seen"),
  ]);
  restarted.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.received.map((item) => item.activity.data.id)).toEqual(["seen", "during-downtime"]);
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
});

it("does not start a queued refresh after closing during an active read", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const result = pendingCall();
  f.call.mockReturnValueOnce(result.promise);
  const running = f.poller.poll();
  await vi.advanceTimersByTimeAsync(0);
  f.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(1_500);
  const closing = f.poller.close();
  result.resolve({
    outcome: "ok",
    isError: false,
    content: JSON.stringify({ notifications: [notification("late")], hasNextPage: false }),
  });
  await Promise.all([running, closing]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(f.received).toEqual([]);
});
