import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneToolBank } from "../src/captain/port.ts";
import type { FleetSeatDelivery } from "../src/captain/fleet-seat.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-hire-brief-"));
  roots.push(root);
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  const captain = createCaptain(
    {
      herdrAvailable: () => true,
      embodiment: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: join(root, "state"),
      settings: new SettingsStore(join(root, "settings.json")),
      seatAdapters: [],
    },
  );
  return { root, captain };
}

async function call(bank: LaneToolBank, name: string, args: Record<string, unknown>) {
  const tool = bank.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`${name} is not in the operator bank`);
  const result = await tool.call(args);
  const text = result.content.find((part) => part.type === "text");
  return JSON.parse(text?.type === "text" ? text.text : "null") as Record<string, unknown>;
}

test.each(["pi", "claude", "codex"])(
  "the captain refuses a %s brief without a harness adapter while Swarm is absent",
  async (harness) => {
    const { root, captain } = await fixture();
    const send = vi.spyOn(HerdrWatchStore.prototype, "deliverToSeat");
    try {
      const bank = await captain.laneToolBank("operator", "global-default");
      expect(
        await call(bank, "hire_agent", {
          harness,
          title: "worker",
          workingDirectory: root,
          brief: "Implement SPEC.md and report the tests.",
        }),
      ).toMatchObject({
        outcome: "failed",
        reason: "harness_unavailable",
        control: { mode: "unavailable", reason: "adapter_unavailable" },
      });
      expect(send).not.toHaveBeenCalled();
    } finally {
      await captain.close();
    }
  },
);

test.each([
  { outcome: "delivered", messageId: "turn-1", state: "steered" },
  {
    outcome: "unconfirmed",
    messageId: "message-1",
    detail: "The channel took it but the receipt is missing.",
  },
  { outcome: "undelivered", detail: "No structured channel is available." },
] satisfies FleetSeatDelivery[])(
  "message_seat preserves the structured $outcome receipt for every returned seat address",
  async (delivery) => {
    const { root, captain } = await fixture();
    vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockResolvedValue({
      outcome: "spawned",
      control: { mode: "adapter" },
      seat: {
        seatId: "term_one",
        paneId: "w1:p1",
        subject: "worker",
        occupantId: "native-session",
        harness: "codex",
        status: "working",
        title: "worker",
        workingDirectory: root,
      },
    });
    vi.spyOn(HerdrWatchStore.prototype, "awaitPickup").mockResolvedValue("working");
    const send = vi.spyOn(HerdrWatchStore.prototype, "deliverToSeat").mockResolvedValue(delivery);
    try {
      const bank = await captain.laneToolBank("operator", "global-default");
      const hired = await call(bank, "hire_agent", {
        harness: "codex",
        title: "worker",
        workingDirectory: root,
        brief: "Implement SPEC.md.",
      });
      expect(hired).toMatchObject({ outcome: "spawned", brief: { outcome: "delivered" } });
      const seat = hired.seat as { seatId: string; personaId: string; conversationId: string };
      for (const target of [seat.seatId, seat.personaId, seat.conversationId]) {
        expect(await call(bank, "message_seat", { seat: target, message: "Follow up once." })).toMatchObject({
          ...delivery,
          seatId: "term_one",
        });
      }
      expect(send).toHaveBeenCalledTimes(3);
      expect(await call(bank, "message_seat", { seat: "nobody", message: "hello" })).toEqual({
        outcome: "unknown_seat",
        seat: "nobody",
      });
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      await captain.close();
    }
  },
);
