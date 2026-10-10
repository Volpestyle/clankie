import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { OperatorSeatEventKindSchema } from "@clankie/protocol";
import { CHANNEL_NOTIFICATION_METHOD, pumpSeatEvents } from "../../tui/src/command/mcp.ts";
import { createCaptain } from "../src/captain/captain.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

// VUH-1950: one lead messages another through Clankie. A real captain, real
// conversation store and the real seat-channel pump the operator and remote
// lead bridges run; Herdr census replies are the only fixture.

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

const capabilities = {
  schemaVersion: 1 as const,
  eventKinds: [...OperatorSeatEventKindSchema.options],
  ownerOrigin: true,
};

async function fixture(remote: boolean) {
  const root = mkdtempSync(join(tmpdir(), "lead-messages-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const seeded = new ConversationStore(join(root, "conversations"), async () => {});
  const leads: string[] = [];
  for (const title of ["Global lead", "Clankie Work"]) {
    const created = await seeded.serve({ schemaVersion: 1, op: "create", scope: { kind: "global" }, title });
    if (created.op !== "create") throw new Error("create failed");
    leads.push(created.conversation.conversationId);
  }
  await seeded.close();
  const sessionId = randomUUID();
  const prefix = remote ? "pc/" : "";
  const head: HerdrAgentSnapshot = {
    paneId: `${prefix}w4:p2`,
    terminalId: `${prefix}term_work`,
    agent: "claude",
    status: "idle",
    title: "Clankie Work",
    session: { source: "herdr:claude", kind: "id", value: sessionId },
    workingDirectory: root,
  };
  const wire = {
    pane_id: "w4:p2",
    terminal_id: "term_work",
    agent: "claude",
    agent_status: "idle",
    title: "Clankie Work",
    agent_session: { ...head.session! },
    cwd: root,
  };
  const herdrResponse = (args: readonly string[]) => {
    let result: unknown;
    if (args[0] === "agent" && args[1] === "list") result = { agents: [wire] };
    else if (args[0] === "agent" && args[1] === "get") result = { agent: wire };
    else if (args[0] === "pane" && args[1] === "list") result = { panes: [wire] };
    else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
    else if (args[0] === "api" && args[1] === "snapshot")
      result = { snapshot: { workspaces: [], tabs: [], panes: [wire], agents: [wire] } };
    else throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    return JSON.stringify({ result });
  };
  // The worker delivery path types nothing here; any call proves a lead was treated as a hire.
  const workerDelivery = vi.spyOn(HerdrWatchStore.prototype, "deliverToSeat");
  const adoption = vi.spyOn(HerdrWatchStore.prototype, "adoptSeat");
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const runner: HerdrWatchRunner = {
    get: async () => head,
    resolveTerminal: async (id) => (id === head.terminalId ? head : Promise.reject(new Error("gone"))),
    wait: async () => head,
  };
  const settings = new SettingsStore(join(root, "settings.json"));
  if (remote)
    await settings.update((current) => ({
      ...current,
      machines: [{ id: "pc", ssh: "fixture.invalid", shell: "posix", aliases: [] }],
      machineAccess: { pc: "shell" },
      execution: {
        ...current.execution,
        connections: [
          { id: "pc", machine: "pc", session: "default", kind: "herdr", enabled: true, capabilities: [] },
        ],
      },
    }));
  const deps = {
    herdrAvailable: () => !remote,
    embodiment: {},
    memory: {},
    browser: { catalog: async () => ({ available: false, tools: [] }) },
    mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    ...(remote
      ? {
          fleets: {
            list: [{ id: "pc", session: "default", ssh: { host: "fixture.invalid", shell: "posix" } }],
            run: () => async (args: readonly string[]) => herdrResponse(args),
          },
        }
      : {}),
  } as unknown as CaptainDeps;
  /** One service process over the same state directory; a second call is a restart. */
  const open = () => {
    const opened = createCaptain(deps, {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      nativeHerdrRunner: runner,
      nativeCensusRunner: async (_command: string, args: readonly string[]) => ({
        stdout: herdrResponse(args),
        stderr: "",
      }),
      settings,
      discordEnvironment: {},
      seatAdapters: [],
    });
    cleanup.push(() => opened.close());
    return opened;
  };
  const captain = open();
  // The lead's own hook sync attaches its native session to its conversation.
  expect(captain.syncSeatTranscript(leads[1]!, { sessionId, entries: [] })).toBe(true);
  const roster = await captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
  if (roster.op !== "roster") throw new Error("roster missing");
  expect(roster.seats.map((seat) => seat.seatId)).toContain(head.terminalId);

  /** A lead's seat bridge: the real pump, polling and acknowledging its own conversation. */
  const bridge = async (conversationId: string) => {
    const stop = new AbortController();
    const notification = vi.fn(async (_event: unknown) => {});
    const pump = pumpSeatEvents(
      { notification },
      {
        pollEvents: (waitMs, signal) => captain.pollSeatEvents(waitMs, signal, conversationId, capabilities),
        acknowledge: (id) => captain.acknowledgeSeatEvent(id, conversationId),
      },
      stop.signal,
      { waitMs: 200, retryMs: 20 },
    );
    cleanup.push(async () => {
      stop.abort();
      await pump;
    });
    // The seat is bound once its first poll parks, as a long-running bridge already is.
    await expect
      .poll(() => captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId }))
      .toMatchObject({ conversation: { driver: {} } });
    return notification;
  };
  const messageSeat = async (from: string, seat: string, message: string) => {
    const bank = await captain.laneToolBank("operator", from);
    const sent = await bank.tools.find((tool) => tool.name === "message_seat")!.call({ seat, message });
    const part = sent.content.find((item) => item.type === "text");
    return JSON.parse(part?.type === "text" ? part.text : "null");
  };
  return { captain, open, leads, head, bridge, messageSeat, workerDelivery, adoption };
}

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
