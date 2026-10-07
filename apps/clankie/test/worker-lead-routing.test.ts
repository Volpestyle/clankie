import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/captain/conversations.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { InboundSeatReceipts } from "../src/captain/inbound-seat-receipts.ts";
import { captainTools, type TurnContext } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
/** Adoption chains run on a hand-started worker; `hired` binds it as lead-a's hire instead. */
function fixture(fleet?: string, hired = false) {
  const root = mkdtempSync(join(tmpdir(), "worker-lead-routing-"));
  roots.push(root);
  const path = join(root, "watches.json");
  const prefix = fleet === undefined ? "" : `${fleet}/`;
  const agent: HerdrAgentSnapshot = {
    paneId: `${prefix}w1:p1`,
    terminalId: `${prefix}term_one`,
    agent: "codex",
    status: "working",
    title: "Noor",
    session: { source: "herdr:codex", kind: "id", value: "native-one" },
  };
  const occupantId = occupantIdForHerdrSession(agent.session!);
  const owners = new HireOwners(`${path}.owners.json`);
  const sessionKey = JSON.stringify([fleet ?? "local", "codex", "native-one"]);
  if (hired)
    owners.bind(
      agent.paneId,
      { conversationId: "lead-a" },
      agent.terminalId,
      undefined,
      occupantId,
      sessionKey,
    );
  else owners.adopt(agent.paneId, agent.terminalId, occupantId, { conversationId: "lead-a" }, sessionKey);
  const runner: HerdrWatchRunner = {
    get: async () => agent,
    resolveTerminal: async () => agent,
    wait: async () => ({ ...agent, status: "idle" }),
  };
  return { root, path, agent, occupantId, runner };
}
const authority = (conversationId: string) => ({
  owner: { conversationId },
  current: () => true,
  authorize: async () => true,
});

it.each([undefined, "away"])(
  "persists exact %s worker adoption across service replacement and saved-session ownership",
  async (fleet) => {
    const f = fixture(fleet);
    const store = new HerdrWatchStore(f.path, { runner: f.runner });
    expect(store.nativeOwner(f.agent)).toEqual({ conversationId: "lead-a" });
    await store.adoptSeat(f.agent.terminalId, authority("lead-b"));
    expect(store.nativeOwner(f.agent)).toEqual({ conversationId: "lead-b" });
    store.close();
    const restarted = new HerdrWatchStore(f.path, { runner: f.runner });
    expect(restarted.nativeOwner(f.agent)).toEqual({ conversationId: "lead-b" });
    expect(
      new HireOwners(`${f.path}.owners.json`).sessionOwner(
        JSON.stringify([fleet ?? "local", "codex", "native-one"]),
      ),
    ).toEqual({ conversationId: "lead-b" });
    expect(() =>
      restarted.nativeOwner({ ...f.agent, session: { ...f.agent.session!, value: "rebound" } }),
    ).toThrow("persisted owner");
    restarted.close();
  },
);

it.each([undefined, "away"])(
  "another lead messaging a %s hire leaves its lead in place, while unowned seats are adopted",
  async (fleet) => {
    const f = fixture(fleet, true);
    const store = new HerdrWatchStore(f.path, { runner: f.runner, validateOwner: async () => true });
    expect(store.seatClaim(f.agent)).toEqual({ owner: { conversationId: "lead-a" }, hired: true });
    expect(await store.adoptSeat(f.agent.terminalId, authority("lead-b"))).toEqual({
      adopted: false,
      ownerConversationId: "lead-a",
    });
    expect(store.seatClaim(f.agent)).toEqual({ owner: { conversationId: "lead-a" }, hired: true });
    expect(await store.adoptSeat(f.agent.terminalId, authority("lead-a"))).toEqual({ adopted: true });
    expect(store.seatClaim(f.agent)).toEqual({ owner: { conversationId: "lead-a" }, hired: true });
    // Reading and observing another lead's hire stays allowed.
    expect(store.nativeOwner(f.agent)).toEqual({ conversationId: "lead-a" });
    store.close();
    const unowned = {
      ...f.agent,
      paneId: "w1:p9",
      terminalId: "term_nine",
      session: { ...f.agent.session!, value: "native-nine" },
    };
    const free = new HerdrWatchStore(join(f.root, "free.json"), {
      runner: { ...f.runner, get: async () => unowned, resolveTerminal: async () => unowned },
      validateOwner: async () => true,
    });
    expect(free.seatClaim(unowned)).toBeUndefined();
    await free.adoptSeat(unowned.terminalId, authority("lead-b"));
    expect(free.seatClaim(unowned)).toEqual({ owner: { conversationId: "lead-b" }, hired: false });
    await free.adoptSeat(unowned.terminalId, authority("lead-c"));
    expect(free.seatClaim(unowned)).toEqual({ owner: { conversationId: "lead-c" }, hired: false });
    free.close();
  },
);

it("a hire whose lead conversation is gone can be adopted by another lead", async () => {
  const f = fixture(undefined, true);
  const store = new HerdrWatchStore(f.path, { runner: f.runner, validateOwner: async () => false });
  await store.adoptSeat(f.agent.terminalId, authority("lead-b"));
  expect(store.seatClaim(f.agent)).toEqual({ owner: { conversationId: "lead-b" }, hired: true });
  store.close();
});

it("refuses adoption after grants are revoked during discovery and preserves the original owner", async () => {
  const f = fixture();
  let allowed = true;
  const store = new HerdrWatchStore(f.path, {
    runner: {
      ...f.runner,
      resolveTerminal: async () => {
        allowed = false;
        return f.agent;
      },
    },
  });
  await expect(
    store.adoptSeat(f.agent.terminalId, {
      owner: { conversationId: "lead-b" },
      current: () => true,
      authorize: async () => allowed,
    }),
  ).rejects.toThrow("authority");
  expect(store.nativeOwner(f.agent)).toEqual({ conversationId: "lead-a" });
  store.close();
});

it("refuses adoption if the native occupant changes during admission", async () => {
  const f = fixture();
  let read = 0;
  const store = new HerdrWatchStore(f.path, {
    runner: {
      ...f.runner,
      resolveTerminal: async () =>
        ++read === 1
          ? f.agent
          : {
              ...f.agent,
              session: { ...f.agent.session!, value: "rebound" },
            },
    },
  });
  await expect(store.adoptSeat(f.agent.terminalId, authority("lead-b"))).rejects.toThrow("occupant changed");
  expect(store.nativeOwner(f.agent)).toEqual({ conversationId: "lead-a" });
  store.close();
});

it("captures message_seat adoption from the admitted turn before asynchronous authorization", async () => {
  let release!: (allowed: boolean) => void;
  const turn: TurnContext = {
    conversationAuthority: {
      owner: { conversationId: "lead-a" },
      current: () => true,
      authorize: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    },
  };
  const message = vi.fn(async () => ({ outcome: "seat_offline" as const, seatId: "term_one" }));
  const tool = captainTools(
    { embodiment: {} } as unknown as CaptainDeps,
    turn,
    {} as LaneLog,
    "operator",
    undefined,
    undefined,
    undefined,
    undefined,
    message,
  ).find((candidate) => candidate.name === "message_seat")!;
  expect(tool.parameters).toMatchObject({
    required: ["seat"],
    properties: { message: { type: "string" }, questionAnswer: { type: "object" } },
  });
  const call = tool.execute(
    "message",
    { seat: "term_one", message: "new assignment" },
    undefined,
    undefined,
    {} as never,
  );
  turn.conversationAuthority!.owner.conversationId = "lead-b";
  release(true);
  await call;
  expect(message).toHaveBeenCalledWith(
    "term_one",
    "new assignment",
    expect.objectContaining({ owner: { conversationId: "lead-a" } }),
  );
});

it("keeps a report's original conversation acceptance after adoption and service replacement", async () => {
  const f = fixture();
  const runner = vi.fn(async () => {});
  const root = join(f.root, "conversations");
  const store = new ConversationStore(root, runner);
  const lead = await store.serve({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "global" },
    title: "Lead",
  });
  if (lead.op !== "create") throw new Error("lead conversation missing");
  const conversationId = lead.conversation.conversationId;
  const receiptPath = join(f.root, "receipts.json");
  const delivery = { id: randomUUID(), binding: "a".repeat(64) };
  const receipts = new InboundSeatReceipts(receiptPath, store);
  expect(
    receipts.accept(f.agent.paneId, delivery, "report", "agent output: report", conversationId),
  ).toMatchObject({ received: true, deliveryStage: "stored" });
  await store.close();
  expect(runner).toHaveBeenCalledOnce();
  expect(runner.mock.calls[0]).toEqual(expect.arrayContaining([conversationId, "agent output: report"]));
  const restartedStore = new ConversationStore(root, runner);
  expect(
    new InboundSeatReceipts(receiptPath, restartedStore).accept(
      f.agent.paneId,
      delivery,
      "report",
      "replacement report",
      "global-default",
    ),
  ).toMatchObject({ received: true, deliveryStage: "stored" });
  await restartedStore.close();
  expect(runner).toHaveBeenCalledOnce();
  const meta = JSON.parse(readFileSync(join(root, conversationId, "meta.json"), "utf8"));
  expect(meta.inboundAcceptances[delivery.id]).toMatchObject({
    text: "report",
    message: "agent output: report",
  });
});

it("an already armed completion follows the adopted lead and fences a later adoption", async () => {
  const f = fixture();
  writeFileSync(
    f.path,
    JSON.stringify({
      schemaVersion: 1,
      watches: [
        {
          id: "automatic-harvest",
          conversationId: "lead-a",
          target: f.agent.terminalId,
          terminalId: f.agent.terminalId,
          occupantId: f.occupantId,
          hired: true,
          reason: "Harvest the worker hired by this conversation; report completion or escalation here.",
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );
  let settle!: (agent: HerdrAgentSnapshot) => void;
  const runner = {
    ...f.runner,
    wait: () =>
      new Promise<HerdrAgentSnapshot>((resolve) => {
        settle = resolve;
      }),
  };
  const store = new HerdrWatchStore(f.path, { runner });
  const wake = vi.fn(
    async (_conversationId: string, _prompt: string, _discord?: unknown, guard?: () => Promise<void>) => {
      await guard?.();
    },
  );
  store.start(wake);
  await vi.waitFor(() => expect(settle).toBeDefined());
  await store.adoptSeat(f.agent.terminalId, authority("lead-b"));
  store.cancelConversation("lead-a");
  settle({ ...f.agent, status: "idle" });
  await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
  expect(wake.mock.calls[0]?.[0]).toBe("lead-b");
  const guard = wake.mock.calls[0]?.[3];
  expect(guard).toBeDefined();
  await store.adoptSeat(f.agent.terminalId, authority("lead-c"));
  await expect(guard!()).rejects.toThrow("leading conversation");
  store.close();
});

it("explicit watches retain their arming conversation after adoption and deduplicate only that conversation", async () => {
  const f = fixture();
  const settles: Array<(agent: HerdrAgentSnapshot) => void> = [];
  const store = new HerdrWatchStore(f.path, {
    runner: {
      ...f.runner,
      wait: () =>
        new Promise((resolve) => {
          settles.push(resolve);
        }),
    },
  });
  const wake = vi.fn(async () => {});
  store.start(wake);
  await store.watch("lead-a", f.agent.terminalId, "explicit original observation");
  await vi.waitFor(() => expect(settles).toHaveLength(1));
  await store.adoptSeat(f.agent.terminalId, authority("lead-b"));
  const second = await store.watch("lead-b", f.agent.terminalId, "explicit adopted observation");
  expect(second).toMatchObject({ outcome: "watching", alreadyWatching: false });
  await vi.waitFor(() => expect(settles).toHaveLength(2));
  const originalWatches = JSON.parse(readFileSync(f.path, "utf8")).watches as Array<{
    id: string;
    conversationId: string;
  }>;
  expect(originalWatches).toHaveLength(2);
  const firstWatch = originalWatches.find((watch) => watch.conversationId === "lead-a")!;
  const secondWatch = originalWatches.find((watch) => watch.conversationId === "lead-b")!;
  expect(firstWatch.id).not.toBe(secondWatch.id);
  for (const settle of settles) settle({ ...f.agent, status: "idle" });
  await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
  expect(wake).toHaveBeenCalledWith(
    "lead-a",
    expect.stringContaining("explicit original observation"),
    undefined,
    expect.any(Function),
    {
      messageId: `seat-watch-${firstWatch.id}`,
      receipt: undefined,
      reserve: expect.any(Function),
    },
  );
  expect(wake).toHaveBeenCalledWith(
    "lead-b",
    expect.stringContaining("explicit adopted observation"),
    undefined,
    expect.any(Function),
    {
      messageId: `seat-watch-${secondWatch.id}`,
      receipt: undefined,
      reserve: expect.any(Function),
    },
  );
  store.close();
});
