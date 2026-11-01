import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { logger } from "../src/app/log.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

type Starter = { kind: "clankie" } | { kind: "app"; name: string } | { kind: "owner" } | { kind: "agent" };

/**
 * The service on real settings, with Herdr's close and the roster's starters standing in for the
 * panes: each seat says who started it and what it is doing, and a close runs Herdr's guard
 * right before the exit, as `herdrWatches.closeSeat` does.
 */
async function service(
  seats: {
    seatId: string;
    hired: boolean;
    starter: Starter;
    status: string;
    live?: string;
  }[],
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-connector-close-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const exits: string[] = [];
  const held = new Map<string, { path: string; state: "unreconciled" }[]>();
  const left: string[] = [];
  const serve = createOperatorService({
    shutdown: new AbortController(),
    personas: { ready: async () => {} },
    settingsStore: settings,
    settings: () => settings.load(),
    deps: {},
    liveSeats: [],
    seatByPersona: new Map(),
    fleetChanges: { touch: () => {} },
    fleetSnapshot: async () => ({
      snapshot: {
        schemaVersion: 1,
        cursor: "c1",
        personas: [],
        channels: [],
        seats: seats.map((seat) => ({
          seatId: seat.seatId,
          occupantId: `occ-${seat.seatId}`,
          harness: "claude",
          status: seat.status,
          title: seat.seatId,
          ...(seat.hired ? { owner: { hired: true } } : {}),
        })),
      },
    }),
    seatStarters: () => (seatId: string) => seats.find((seat) => seat.seatId === seatId)?.starter,
    herdrRunner: {
      resolveTerminal: async (seatId: string) => {
        const seat = seats.find((candidate) => candidate.seatId === seatId);
        return (
          seat && {
            terminalId: seatId,
            agent: "claude",
            status: seat.live ?? seat.status,
          }
        );
      },
    },
    herdrWatches: {
      tidy: {
        seatWorktreeHold: async (seatId: string) => held.get(seatId) ?? [],
        recordLeftBehind: (entry: { reason: string }) => left.push(entry.reason),
      },
      closeSeat: async (seatId: string, guard?: () => Promise<void>) => {
        try {
          await guard?.();
        } catch {
          return false;
        }
        exits.push(seatId);
        return true;
      },
    },
  } as unknown as CreateOperatorServiceContext);
  const close = async (seatId: string, extra: { appDeviceId?: string; unlandedReason?: string } = {}) =>
    OperatorConversationServiceResultSchema.parse(
      await serve({ op: "close_seat", schemaVersion: 1, seatId, ...extra }),
    );
  return { close, exits, held, left };
}

it("a connected app closes only an idle hire Clankie or an app started, logs each close, and never a pane mid-turn", async () => {
  const info = vi.spyOn(logger, "info");
  const app = { appDeviceId: "device-connector-1" };
  const { close, exits, held, left } = await service([
    {
      seatId: "w1:clankies",
      hired: true,
      starter: { kind: "clankie" },
      status: "idle",
    },
    {
      seatId: "w1:apps",
      hired: true,
      starter: { kind: "app", name: "Claude" },
      status: "done",
    },
    // The owner asked Clankie for this one: still the owner's to close.
    {
      seatId: "w1:asked",
      hired: true,
      starter: { kind: "owner" },
      status: "idle",
    },
    // Started by hand in Herdr: no hire record at all.
    {
      seatId: "w1:by-hand",
      hired: false,
      starter: { kind: "owner" },
      status: "idle",
    },
    {
      seatId: "w1:working",
      hired: true,
      starter: { kind: "clankie" },
      status: "working",
    },
    {
      seatId: "w1:asking",
      hired: true,
      starter: { kind: "clankie" },
      status: "blocked",
    },
    // Idle when the roster was read, mid-turn by the time Herdr is about to close it.
    {
      seatId: "w1:woke",
      hired: true,
      starter: { kind: "clankie" },
      status: "idle",
      live: "working",
    },
    {
      seatId: "w1:unlanded",
      hired: true,
      starter: { kind: "app", name: "Grok" },
      status: "idle",
    },
  ]);
  held.set("w1:unlanded", [{ path: "/work/kh2-wt", state: "unreconciled" }]);

  expect(await close("w1:clankies", app)).toMatchObject({ closed: true });
  expect(await close("w1:apps", app)).toMatchObject({ closed: true });
  expect(await close("w1:asked", app)).toMatchObject({
    closed: false,
    refusal: { reason: "not_clankies_hire" },
  });
  expect(await close("w1:by-hand", app)).toMatchObject({
    closed: false,
    refusal: { reason: "not_clankies_hire" },
  });
  expect(await close("w1:working", app)).toMatchObject({
    closed: false,
    refusal: { reason: "busy", status: "working" },
  });
  expect(await close("w1:asking", app)).toMatchObject({
    closed: false,
    refusal: { reason: "busy", status: "blocked" },
  });
  expect(await close("w1:woke", app)).toMatchObject({ closed: false });
  expect(await close("w1:gone", app)).toMatchObject({
    closed: false,
    refusal: { reason: "not_found" },
  });
  expect(await close("w1:unlanded", app)).toMatchObject({
    closed: false,
    refusal: { reason: "unlanded_work", worktrees: [{ path: "/work/kh2-wt" }] },
  });
  expect(await close("w1:unlanded", { ...app, unlandedReason: "superseded" })).toMatchObject({
    closed: true,
  });
  expect(left).toEqual(["superseded"]);
  expect(exits).toEqual(["w1:clankies", "w1:apps", "w1:unlanded"]);

  const logged = info.mock.calls
    .map(
      ([fields]) =>
        fields as {
          event?: string;
          seatId?: string;
          closed?: boolean;
          refusal?: string;
        },
    )
    .filter((fields) => fields.event === "connector.close_agent")
    .map(({ seatId, closed, refusal }) => [seatId, closed, refusal]);
  expect(logged).toEqual([
    ["w1:clankies", true, undefined],
    ["w1:apps", true, undefined],
    ["w1:asked", false, "not_clankies_hire"],
    ["w1:by-hand", false, "not_clankies_hire"],
    ["w1:working", false, "busy"],
    ["w1:asking", false, "busy"],
    ["w1:woke", false, undefined],
    ["w1:gone", false, "not_found"],
    ["w1:unlanded", false, "unlanded_work"],
    ["w1:unlanded", true, undefined],
  ]);
});

it("the owner's own close is unchanged: it closes their panes, busy or not, and logs no app", async () => {
  const info = vi.spyOn(logger, "info");
  const { close, exits } = await service([
    {
      seatId: "w1:by-hand",
      hired: false,
      starter: { kind: "owner" },
      status: "working",
    },
  ]);
  expect(await close("w1:by-hand")).toMatchObject({ closed: true });
  expect(exits).toEqual(["w1:by-hand"]);
  expect(
    info.mock.calls.some(([fields]) => (fields as { event?: string }).event === "connector.close_agent"),
  ).toBe(false);
});
