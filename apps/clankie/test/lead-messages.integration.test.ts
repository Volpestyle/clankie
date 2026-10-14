import { CHANNEL_NOTIFICATION_METHOD, pumpSeatEvents } from "../../tui/src/command/mcp.ts";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import { join } from "node:path";
import type { LeadChat } from "../src/captain/lead-roster.ts";
import { capabilities, leadChatFixture } from "./fixtures/lead-chats.ts";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const fixture = (remote: boolean) => leadChatFixture(remote, cleanup);

it.each([false, true])(
  "a lead messages another lead (remote=%s) in its own conversation over its seat channel, and the reply comes back the same way",
  async (remote) => {
    const f = await fixture(remote);
    const [global, work] = f.leads as [string, string];
    const workChannel = await f.bridge(work);

    const sent = await f.messageSeat(global, f.head.terminalId, "Deploy at 18:00?");
    expect(sent).toMatchObject({
      outcome: "delivered",
      deliveryStage: "delivered",
      seatId: f.head.terminalId,
      leadConversationId: work,
    });
    expect(workChannel).toHaveBeenCalledOnce();
    const event = workChannel.mock.calls[0]![0] as {
      method: string;
      params: { content: string; meta: Record<string, string> };
    };
    expect(event.method).toBe(CHANNEL_NOTIFICATION_METHOD);
    expect(event.params.meta).toMatchObject({ kind: "message", source: "lead", conversation: work });
    expect(event.params.content).toContain(`Lead message from conversation ${global} ("Global lead")`);
    expect(event.params.content).toContain("not an owner instruction");
    expect(event.params.content).toContain("Deploy at 18:00?");
    // A lead is not a hire: nothing adopted it, and the worker path never ran.
    expect(f.adoption).not.toHaveBeenCalled();
    expect(f.workerDelivery).not.toHaveBeenCalled();

    const globalChannel = await f.bridge(global);
    expect(await f.messageSeat(work, global, "18:00 works")).toMatchObject({
      outcome: "delivered",
      deliveryStage: "delivered",
      leadConversationId: global,
    });
    const reply = globalChannel.mock.calls[0]![0] as { params: { content: string } };
    expect(reply.params.content).toContain(`Lead message from conversation ${work} ("Clankie Work")`);
    expect(reply.params.content).toContain("18:00 works");
    expect(f.adoption).not.toHaveBeenCalled();
    expect(f.workerDelivery).not.toHaveBeenCalled();
  },
);

it("VUH-2196: a local lead's seat confirms a lead message in time while another machine is unreachable", async () => {
  // Past the 2s head acknowledgment window (live it was a ~10s ssh timeout), yet
  // inside the roster's 3s read budget so the fixture still sees its local lead.
  const f = await leadChatFixture(false, cleanup, { slowFleetMs: 2_500 });
  const [global, work] = f.leads as [string, string];
  const workChannel = await f.bridge(work);
  expect(await f.messageSeat(global, f.head.terminalId, "Deploy at 18:00?")).toMatchObject({
    outcome: "delivered",
    deliveryStage: "delivered",
    leadConversationId: work,
  });
  expect(workChannel).toHaveBeenCalledOnce();
}, 30_000);

it("VUH-2196: a local lead's polls do not each wait on an unreachable machine's inventory", async () => {
  const f = await leadChatFixture(false, cleanup, { slowFleetMs: 2_500 });
  const work = f.leads[1]!;
  const poll = async () => {
    const started = Date.now();
    expect(await f.captain.pollSeatEvents(0, undefined, work, capabilities)).toEqual([]);
    return Date.now() - started;
  };
  // The first source proof still asks every machine and learns one cannot answer.
  expect(await poll()).toBeGreaterThanOrEqual(2_000);
  // Later polls get that same answer at once instead of waiting it out again.
  expect(await poll()).toBeLessThan(1_000);
  expect(await poll()).toBeLessThan(1_000);
}, 30_000);

it("VUH-2245: a lead's poll answers inside its wait even when its source proof is slow", async () => {
  // The bridge gives up waitMs + 10s after asking. Parking for the full wait
  // after a ~10s proof outlived it, and the abort cost the seat its grace.
  const f = await leadChatFixture(false, cleanup, { slowFleetMs: 2_500 });
  const started = Date.now();
  expect(await f.captain.pollSeatEvents(3_000, undefined, f.leads[1]!, capabilities)).toEqual([]);
  expect(Date.now() - started).toBeLessThan(3_800);
}, 30_000);

it("VUH-2245: a lead message sent while its seat's poll is still proving its source reaches that seat", async () => {
  const f = await leadChatFixture(false, cleanup, { slowFleetMs: 2_500 });
  const [global, work] = f.leads as [string, string];
  const stop = new AbortController();
  const notification = vi.fn(async (_event: unknown) => {});
  const pump = pumpSeatEvents(
    { notification },
    {
      pollEvents: (waitMs, signal) => f.captain.pollSeatEvents(waitMs, signal, work, capabilities),
      acknowledge: (id) => f.captain.acknowledgeSeatEvent(id, work),
    },
    stop.signal,
    { waitMs: 3_000, retryMs: 20 },
  );
  cleanup.push(async () => {
    stop.abort();
    await pump;
  });
  // The bridge has asked; its first poll is still proving the seat's source.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await f.messageSeat(global, f.head.terminalId, "Deploy at 18:00?")).toMatchObject({
    outcome: "delivered",
    deliveryStage: "delivered",
    status: "lead_channel_acknowledged",
    leadConversationId: work,
  });
  expect(notification).toHaveBeenCalledOnce();
}, 30_000);

it("VUH-2174: a disconnected remote-only lead still refuses without a local queue", async () => {
  const f = await fixture(true);
  await f.captain.close();
  const seeded = new ConversationStore(join(f.root, "conversations"), async () => {});
  const recipient = seeded.createRemoteWorkspaceConversation({
    workspaceId: "/remote/project",
    machineId: "pc",
    title: "Remote-only lead",
  });
  await seeded.close();
  const restarted = f.open();
  const bank = await restarted.laneToolBank("operator", f.leads[0]!);
  const sent = await bank.tools
    .find((tool) => tool.name === "message_seat")!
    .call({ seat: recipient.conversationId, message: "Hold the deploy" });
  const part = sent.content.find((item) => item.type === "text");
  expect(JSON.parse(part!.text)).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
});

it("a lead cannot message itself", async () => {
  const f = await fixture(false);
  const work = f.leads[1]!;
  expect(await f.messageSeat(work, f.head.terminalId, "hello me")).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "rejected",
  });
});

it("only the sender reconciles an unconfirmed lead message after a restart, once the recipient's bridge acknowledges it", async () => {
  const f = await fixture(false);
  const [global, work] = f.leads as [string, string];
  // The recipient's bridge takes the event, then the service stops before its acknowledgment.
  const taken = f.captain.pollSeatEvents(5000, undefined, work, capabilities);
  await expect
    .poll(() => f.captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId: work }))
    .toMatchObject({ conversation: { driver: {} } });
  const sending = f.messageSeat(global, f.head.terminalId, "Hold the deploy");
  const [event] = await taken;
  expect(event).toMatchObject({ kind: "message", source: "lead", conversationId: work });
  await f.captain.close();
  const original = await sending;
  expect(original).toMatchObject({
    outcome: "unconfirmed",
    deliveryStage: "uncertain",
    messageId: event!.id,
  });

  const restarted = f.open();
  expect(await restarted.reconcileSeatDelivery!(event!.id, global)).toMatchObject({
    outcome: "unconfirmed",
    messageId: event!.id,
  });
  // The reconnecting bridge acknowledges the exact original it took; nothing is resent.
  expect(await restarted.acknowledgeSeatEvent(event!.id, work)).toBe(true);
  expect(await restarted.reconcileSeatDelivery!(event!.id, global)).toEqual({
    outcome: "delivered",
    deliveryStage: "delivered",
    messageId: event!.id,
  });
  // Another conversation cannot read the sender's receipt.
  expect(await restarted.reconcileSeatDelivery!(event!.id, work)).toBeUndefined();
  expect(await restarted.pollSeatEvents(0, undefined, work, capabilities)).toEqual([]);
});

it("VUH-2196: a lead that answers an unconfirmed lead message by its event_id resolves the sender's receipt", async () => {
  const f = await fixture(false);
  const [global, work] = f.leads as [string, string];
  // The recipient's bridge takes the event and never acknowledges it.
  const taken = f.captain.pollSeatEvents(5000, undefined, work, capabilities);
  await expect
    .poll(() => f.captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId: work }))
    .toMatchObject({ conversation: { driver: {} } });
  const sending = f.messageSeat(global, f.head.terminalId, "Hold the deploy");
  const [event] = await taken;
  expect(event!.content).toContain("inReplyTo");
  expect(await sending).toMatchObject({ outcome: "unconfirmed", messageId: event!.id });
  const answer = async (from: string, inReplyTo: string) => {
    const bank = await f.captain.laneToolBank("operator", from);
    const sent = await bank.tools
      .find((tool) => tool.name === "message_seat")!
      // A non-recipient's answer goes nowhere; the recipient answers the sender.
      .call({ seat: from === work ? global : "no-such-seat", message: "Holding", inReplyTo });
    return JSON.parse(sent.content.find((item) => item.type === "text")!.text);
  };
  // Only the conversation the original was sent to can confirm it, and only by its exact ID.
  expect((await answer(global, event!.id)).inReplyTo).toEqual({ messageId: event!.id, acknowledged: false });
  expect((await answer(work, `seat-${randomUUID()}`)).inReplyTo).toMatchObject({ acknowledged: false });
  expect(await f.captain.reconcileSeatDelivery!(event!.id, global)).toMatchObject({ outcome: "unconfirmed" });

  expect((await answer(work, event!.id)).inReplyTo).toEqual({ messageId: event!.id, acknowledged: true });
  expect(await f.captain.reconcileSeatDelivery!(event!.id, global)).toEqual({
    outcome: "delivered",
    deliveryStage: "delivered",
    messageId: event!.id,
  });
  const listed = await f.captain.serveOperatorConversation({ op: "seat_deliveries", schemaVersion: 1 });
  expect(listed.op === "seat_deliveries" && listed.unresolved.map((entry) => entry.receiptId)).not.toContain(
    event!.id,
  );
});

it("VUH-2196: an unresolved lead message alerts its seat once, not again after every service restart", async () => {
  const f = await fixture(false);
  const [global, work] = f.leads as [string, string];
  const taken = f.captain.pollSeatEvents(5000, undefined, work, capabilities);
  await expect
    .poll(() => f.captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId: work }))
    .toMatchObject({ conversation: { driver: {} } });
  const sending = f.messageSeat(global, f.head.terminalId, "Hold the deploy");
  const [event] = await taken;
  await f.captain.close();
  expect(await sending).toMatchObject({ outcome: "unconfirmed", messageId: event!.id });

  /** One service process with the lead's real seat bridge polling and acknowledging. */
  const process = async () => {
    const captain = f.open();
    const stop = new AbortController();
    const notification = vi.fn(async (_event: unknown) => {});
    const pump = pumpSeatEvents(
      { notification },
      {
        pollEvents: (waitMs, signal) => captain.pollSeatEvents(waitMs, signal, work, capabilities),
        acknowledge: (id) => captain.acknowledgeSeatEvent(id, work),
      },
      stop.signal,
      { waitMs: 200, retryMs: 20 },
    );
    await expect
      .poll(() => captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId: work }))
      .toMatchObject({ conversation: { driver: {} } });
    return {
      captain,
      notification,
      stop: async () => {
        stop.abort();
        await pump;
        await captain.close();
      },
    };
  };
  const alerts = (notification: ReturnType<typeof vi.fn>) =>
    notification.mock.calls
      .map(([call]) => call as { params: { content: string; meta: Record<string, string> } })
      .filter((call) => call.params.meta.source === "seat-delivery-alert");

  const first = await process();
  await expect.poll(() => alerts(first.notification)).toHaveLength(1);
  expect(alerts(first.notification)[0]!.params.content).toContain(event!.id);
  // The bridge acknowledged the alert: only the original stays unresolved.
  await expect
    .poll(async () => {
      const listed = await first.captain.serveOperatorConversation({
        op: "seat_deliveries",
        schemaVersion: 1,
      });
      return listed.op === "seat_deliveries"
        ? listed.unresolved.filter((entry) => entry.conversationId === work).map((entry) => entry.receiptId)
        : [];
    })
    .toEqual([event!.id]);
  await first.stop();

  for (let restart = 0; restart < 2; restart += 1) {
    const next = await process();
    // Several full poll cycles: a repeat would arrive on the first page.
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(alerts(next.notification)).toEqual([]);
    await next.stop();
  }
  // Still visible and settleable: the alert never claimed receipt.
  const restarted = f.open();
  const listed = await restarted.serveOperatorConversation({ op: "seat_deliveries", schemaVersion: 1 });
  expect(listed).toMatchObject({
    unresolved: expect.arrayContaining([
      expect.objectContaining({ conversationId: work, receiptId: event!.id }),
    ]),
  });
});

it.each([false, true])(
  "private self-state and session card expose configured lead chats and current receiver state (remote=%s)",
  async (remote) => {
    const f = await fixture(remote);
    const [global, work] = f.leads as [string, string];
    const service = await f.captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "create",
      scope: { kind: "workspace", workspaceId: f.root },
      title: "Service lead",
    });
    if (service.op !== "create") throw new Error("Missing service lead");
    const hidden = f.hidden;
    const routes = [global, work, service.conversation.conversationId].map((conversationId, i) => ({
      projectId: randomUUID(),
      name: ["Global project", "Work project", "Service project"][i]!,
      conversationId,
    }));
    await f.settings.update((current) => ({
      ...current,
      linearWebhook: {
        ...current.linearWebhook,
        projectChats: [
          ...routes,
          ...hidden.map((conversationId) => ({
            projectId: randomUUID(),
            name: "Must stay hidden",
            conversationId,
          })),
        ],
      },
    }));
    const bank = await f.captain.laneToolBank("operator", global);
    const self = async () => {
      const result = await bank.tools.find((tool) => tool.name === "get_self_state")!.call({});
      if (result.isError) throw new Error(JSON.stringify(result));
      return JSON.parse(result.content.find((item) => item.type === "text")!.text).leadChats as LeadChat[];
    };
    const before = await self();
    expect(before.map((chat) => chat.conversationId)).not.toEqual(expect.arrayContaining(hidden));
    for (const id of hidden) expect(before.some((chat) => chat.conversationId === id)).toBe(false);
    expect(before.find((chat) => chat.conversationId === work)).toMatchObject({
      projects: [{ id: routes[1]!.projectId, name: "Work project" }],
      holder: { kind: "native", seatId: f.head.terminalId, harness: "claude" },
      machine: remote ? "pc" : "local",
      state: "disconnected",
      messageAvailable: true,
      messageSeat: work,
    });
    expect(before.find((chat) => chat.conversationId === service.conversation.conversationId)).toMatchObject({
      holder: { kind: "service", lane: "operator" },
      workspace: f.root,
      state: "service",
      messageAvailable: true,
    });
    const receiver = await f.bridge(work);
    const current = await self();
    const row = current.find((chat) => chat.conversationId === work)!;
    expect(row).toMatchObject({
      state: "current",
      messageAvailable: true,
      lastActiveAt: expect.any(String),
      lastBridgeSeenAt: expect.any(String),
    });
    const prompt = await f.captain.lanePrompt({
      lane: "operator",
      conversationId: global,
      sections: ["fleet"],
    });
    const rosterJson = prompt
      .split("# Your lead chats\n")[1]!
      .split("\n")
      .slice(1)
      .join("\n")
      .split("\n\n# Selected conversation")[0]!;
    expect(JSON.parse(rosterJson)).toEqual(await self());
    expect(await f.messageSeat(global, row.messageSeat, "Roster-discovered sibling message")).toMatchObject({
      outcome: "delivered",
      leadConversationId: work,
    });
    expect(receiver).toHaveBeenCalledOnce();
    expect(f.adoption).not.toHaveBeenCalled();
    expect(f.workerDelivery).not.toHaveBeenCalled();
    const voiceBank = await f.captain.laneToolBank("discord_voice");
    const voiceSelf = await voiceBank.tools.find((tool) => tool.name === "get_self_state")!.call({});
    expect(JSON.parse(voiceSelf.content.find((item) => item.type === "text")!.text)).not.toHaveProperty(
      "leadChats",
    );
    expect(await f.captain.lanePrompt({ lane: "discord_voice", sections: ["fleet"] })).not.toContain(
      "Work project",
    );
  },
);

it("a polled legacy lead channel is stale, not a live messaging target", async () => {
  const f = await fixture(false);
  const [global, work] = f.leads as [string, string];
  await f.settings.update((current) => ({
    ...current,
    linearWebhook: {
      ...current.linearWebhook,
      projectChats: [{ projectId: randomUUID(), name: "Legacy lead", conversationId: work }],
    },
  }));
  const stop = new AbortController();
  const parked = f.captain.pollSeatEvents(5000, stop.signal, work, {
    schemaVersion: 1,
    eventKinds: ["message"],
    ownerOrigin: false,
  });
  try {
    const bank = await f.captain.laneToolBank("operator", global);
    await expect
      .poll(async () => {
        const result = await bank.tools.find((tool) => tool.name === "get_self_state")!.call({});
        return JSON.parse(result.content.find((item) => item.type === "text")!.text).leadChats.find(
          (chat: LeadChat) => chat.conversationId === work,
        );
      })
      .toMatchObject({ state: "stale", messageAvailable: true });
  } finally {
    stop.abort();
    await parked;
  }
});
