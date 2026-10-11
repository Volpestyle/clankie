import { CHANNEL_NOTIFICATION_METHOD } from "../../tui/src/command/mcp.ts";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
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

    // The global lead has no live channel yet: refused honestly, nothing queued.
    const refused = await f.messageSeat(work, global, "18:00 works");
    expect(refused).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
    expect(refused.detail).toContain("nothing was sent or queued");
    expect(await f.captain.pollSeatEvents(0, undefined, global, capabilities)).toEqual([]);

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
      messageAvailable: false,
      messageSeat: work,
    });
    expect(before.find((chat) => chat.conversationId === service.conversation.conversationId)).toMatchObject({
      holder: { kind: "service", lane: "operator" },
      workspace: f.root,
      state: "service",
      messageAvailable: false,
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
      .toMatchObject({ state: "stale", messageAvailable: false });
  } finally {
    stop.abort();
    await parked;
  }
});
