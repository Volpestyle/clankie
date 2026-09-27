import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LinearNotifications } from "../src/linear-notifications.ts";
import type { McpHost } from "../src/mcp-host.ts";
import type { LinearActivityEvent } from "../src/linear-webhook.ts";

const roots: string[] = [];
afterEach(async () => {
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
    email: "volpestyle+bot@gmail.com",
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
  return {
    options,
    poller: new LinearNotifications(options),
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
