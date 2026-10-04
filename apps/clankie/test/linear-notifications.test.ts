import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LinearWakeSettingsSchema } from "@clankie/settings";
import { LinearNotifications } from "../src/linear-notifications.ts";
import { LinearAttributionJournal } from "../src/linear-attribution.ts";
import type { McpHost } from "../src/mcp-host.ts";
import {
  classifyLinearDelivery,
  LinearWriteReceipts,
  type LinearActivityEvent,
} from "../src/linear-webhook.ts";
import type { LinearRecipient } from "../src/captain/conversation-owner.ts";

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
  const attribute = vi.fn((): { id: string; type: string } | undefined => ({ id: "owner", type: "user" }));
  const wakeRules = vi.fn(async () => LinearWakeSettingsSchema.parse({ ownerUserIds: ["owner"] }));
  const options = {
    path: join(root, "cursor.json"),
    host: { account, call },
    following,
    attribute,
    wakeRules,
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
    attribute,
    wakeRules,
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
  f.attribute
    .mockReturnValueOnce({ id: "owner", type: "user" })
    .mockReturnValueOnce({ id: "bot", type: "user" });
  f.page([notification("off"), notification("self"), notification("human")]);
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
  f.wakeRules.mockResolvedValue(LinearWakeSettingsSchema.parse({ actors: ["human"] }));
  f.attribute
    .mockReturnValueOnce({ id: "bot", type: "user" })
    .mockReturnValueOnce({ id: "another-user", type: "user" });
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

it("reads once at startup without a periodic timer and cancels delayed work on close", async () => {
  vi.useFakeTimers();
  const interval = vi.spyOn(globalThis, "setInterval");
  const f = await fixture();
  f.page([]);
  f.poller.start();
  f.poller.start();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
  expect(f.call).toHaveBeenCalledTimes(1);
  expect(interval).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  interval.mockRestore();
  f.poller.requestPoll();
  await f.poller.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(f.call).toHaveBeenCalledTimes(1);

  const retry = await fixture();
  retry.page([]);
  retry.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(1_500);
  await retry.poller.close();
  retry.poller.requestPoll();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(retry.call).toHaveBeenCalledTimes(1);
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
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);

  const offline = await fixture();
  offline.call.mockRejectedValue(new Error("still offline"));
  offline.poller.start();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
  expect(offline.call).toHaveBeenCalledTimes(2);
  expect(offline.onError).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
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
  await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
  expect(f.received.map((item) => item.activity.data.id)).toEqual(["seen", "during-downtime"]);
  expect(f.call).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
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

it("collects unattributed and excluded notifications, ignores purported MCP actors, and applies rule changes live", async () => {
  const f = await fixture();
  f.attribute.mockReturnValue(undefined);
  f.page([{ ...notification("unknown"), actor: { id: "owner" } }]);
  await f.poller.poll();
  expect(f.received[0]).toMatchObject({ following: false, activity: { actorId: undefined } });
  f.attribute.mockReturnValue({ id: "owner", type: "user" });
  f.page([notification("subscribed", "issueSubscribed")]);
  await f.poller.poll();
  expect(f.received.at(-1)?.following).toBe(false);
  f.attribute.mockReturnValue({ id: "bot", type: "app" });
  f.page([notification("self-before")]);
  await f.poller.poll();
  expect(f.received.at(-1)?.following).toBe(false);
  f.wakeRules.mockResolvedValue(LinearWakeSettingsSchema.parse({ actors: ["self"] }));
  f.page([notification("self-after")]);
  await f.poller.poll();
  expect(f.received.at(-1)?.following).toBe(true);
});

it("enriches notifications with retained signed issue identity without changing actor wake rules", async () => {
  const f = await fixture();
  const issueId = "a06a1c92-8a14-4240-8802-a0bb868d639c";
  const journal = new LinearAttributionJournal(join(dirname(f.options.path), "attribution.json"));
  journal.record(
    {
      eventId: "signed-issue",
      type: "Issue",
      action: "update",
      organizationId: "org",
      deliveryId: "signed",
      actorId: "owner",
      actorType: "user",
      actorName: undefined,
      actorEmail: undefined,
      createdAt: "2026-09-27T11:59:00.000Z",
      url: "https://linear.app/issue/ABC-1/old-title",
      data: { id: issueId },
      updatedFrom: undefined,
    },
    new Date(NOW),
  );
  const options = {
    ...f.options,
    attribute: journal.attribute.bind(journal),
    resolveIssue: vi.fn(journal.issue.bind(journal)),
  };
  const poller = new LinearNotifications(options);
  pollers.push(poller);
  f.page([{ ...notification("issue-event"), url: "https://linear.app/issue/ABC-1/new-title" }]);
  await poller.poll();
  expect(options.resolveIssue).toHaveBeenCalledWith(expect.objectContaining({ id: "issue-event" }), "org");
  expect(f.received[0]).toMatchObject({
    following: false,
    activity: { organizationId: "org", issueId, actorId: undefined },
  });
  // Canonical identity never makes an actor outside the correlation window known.
  f.page([
    notification("unknown", "issueMention"),
    { ...notification("unmapped"), url: "https://linear.app/issue/ABC-2" },
  ]);
  await poller.poll();
  expect(f.received.find((entry) => entry.activity.data.id === "unmapped")?.activity.issueId).toBeUndefined();
  expect(f.received.every((entry) => entry.following === false)).toBe(true);
});

it("passes the selected workspace to issue resolution and keeps ambiguous notifications passive", async () => {
  const f = await fixture();
  const resolveIssue = vi.fn<LinearAttributionJournal["issue"]>(() => undefined);
  const poller = new LinearNotifications({ ...f.options, resolveIssue });
  pollers.push(poller);
  f.attribute.mockReturnValue(undefined);
  f.page([notification("ambiguous")]);
  await poller.poll();
  expect(f.received[0]?.following).toBe(false);
  expect(f.received[0]?.activity.issueId).toBeUndefined();
  f.account.mockResolvedValue({
    ...own,
    binding: "another-workspace",
    account: { ...own.account, workspaceId: "other-org" },
  });
  f.page([notification("another-workspace")]);
  await poller.poll();
  expect(resolveIssue.mock.calls.map((call) => call[1])).toEqual(["org", "other-org"]);
});

const UPDATE = "d9b90f52-0b0e-463d-a1e9-9457d250592c";
const COMMENT = "0707b479-8a50-4496-b6ba-bec2efbd0a1f";
const REPLY_URL =
  "https://linear.app/work/project/kh2-abc123/activity#project-update-d9b90f52&comment-0707b479";
const AUTHOR: LinearRecipient = {
  kind: "native",
  paneId: "pc/w3:pK",
  seatId: "kh2-claude",
  occupantId: "claude:kh2-session",
  binding: "a".repeat(64),
};
async function replyFixture() {
  const f = await fixture();
  const journal = new LinearAttributionJournal(join(dirname(f.options.path), "attribution.json"));
  const writes = new LinearWriteReceipts();
  writes.record(
    {
      server: "linear",
      tool: "save_status_update",
      arguments: { type: "project" },
      content: JSON.stringify({ id: UPDATE, updatedAt: NOW, body: "Status" }),
      isError: false,
      account: own.account,
      recipient: AUTHOR,
    },
    new Date(NOW),
  );
  const body = JSON.stringify({
    type: "Comment",
    action: "create",
    organizationId: "org",
    webhookTimestamp: Date.parse(NOW),
    createdAt: NOW,
    actor: { id: "owner", type: "user" },
    url: REPLY_URL,
    data: { id: COMMENT, body: "I APPROVE all!!", projectUpdateId: UPDATE, projectUpdate: { id: UPDATE } },
  });
  classifyLinearDelivery({
    rawBody: Buffer.from(body),
    headers: {
      signature: createHmac("sha256", "secret").update(body).digest("hex"),
      delivery: "reply",
      event: "Comment",
    },
    secret: "secret",
    now: new Date(NOW),
    writes,
    recordActivity: (activity) => journal.record(activity, new Date(NOW)),
  });
  const poller = new LinearNotifications({
    ...f.options,
    attribute: (item, org) => journal.attribute(item, org),
    resolveReplyRecipient: (item, org) => journal.replyRecipient(item, org),
  });
  pollers.push(poller);
  return { ...f, poller };
}
const replyNotification = {
  id: "project-reply-notification",
  type: "projectUpdateNewComment",
  createdAt: NOW,
  url: REPLY_URL,
};

it("enriches an eligible project reply with its exact remote native author without changing wake rules", async () => {
  const f = await replyFixture();
  f.page([replyNotification]);
  expect(await f.poller.poll()).toBe(true);
  expect(f.received).toMatchObject([
    {
      following: true,
      activity: {
        type: "Notification",
        actorId: "owner",
        actorType: "user",
        replyTo: { type: "ProjectUpdate", id: UPDATE },
        replyRecipient: {
          parentType: "ProjectUpdate",
          parentId: UPDATE,
          recipient: AUTHOR,
          recordedAt: Date.parse(NOW),
        },
      },
    },
  ]);
  f.page([replyNotification]);
  expect(await f.poller.poll()).toBe(false);
  expect(f.receive).toHaveBeenCalledTimes(1);
});

it.each(["following-off", "actor-filtered"])(
  "retains proven reply context while %s remains quiet",
  async (mode) => {
    const f = await replyFixture();
    if (mode === "following-off") f.following.mockResolvedValue(false);
    else f.wakeRules.mockResolvedValue(LinearWakeSettingsSchema.parse({ ownerUserIds: ["different-owner"] }));
    f.page([replyNotification]);
    await f.poller.poll();
    expect(f.received).toMatchObject([
      { following: false, activity: { replyRecipient: { recipient: AUTHOR } } },
    ]);
  },
);

it("never promotes unsigned notification parent data or recipient fields into host proof", async () => {
  const f = await fixture();
  const resolveReplyRecipient = vi.fn<LinearAttributionJournal["replyRecipient"]>(() => undefined);
  const poller = new LinearNotifications({ ...f.options, resolveReplyRecipient });
  pollers.push(poller);
  f.page([
    {
      ...replyNotification,
      projectUpdateId: UPDATE,
      replyRecipient: {
        parentType: "ProjectUpdate",
        parentId: UPDATE,
        recipient: AUTHOR,
        recordedAt: Date.parse(NOW),
      },
    },
  ]);
  await poller.poll();
  expect(f.received[0]?.activity.replyRecipient).toBeUndefined();
  expect(f.received[0]?.activity.replyTo).toBeUndefined();
  expect(resolveReplyRecipient).toHaveBeenCalledWith(
    expect.objectContaining({ id: replyNotification.id }),
    "org",
  );
});

it("retries failed reply admission with stable event identity and unchanged recipient proof", async () => {
  const f = await replyFixture();
  f.receive.mockImplementationOnce(() => {
    throw new Error("storage unavailable");
  });
  f.page([replyNotification]);
  expect(await f.poller.poll(false)).toBe(false);
  expect(f.onError).toHaveBeenCalledTimes(1);
  f.page([replyNotification]);
  expect(await f.poller.poll(false)).toBe(true);
  expect(f.receive).toHaveBeenCalledTimes(2);
  const [failed, retried] = f.receive.mock.calls.map(([activity]) => activity);
  expect(retried?.eventId).toBe(failed?.eventId);
  expect(retried?.replyRecipient).toEqual(failed?.replyRecipient);
  expect(f.received).toHaveLength(1);
});
