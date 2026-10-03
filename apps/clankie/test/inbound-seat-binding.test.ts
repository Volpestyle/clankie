import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import * as fleetRunner from "../src/captain/herdr-fleet-runner.ts";

it("compares POST and receipt assertions to freshly inspected native identity without trusting supplied binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "inbound-native-binding-"));
  let agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "seat1",
    agent: "codex",
    status: "idle",
    title: "test",
    session: { source: "herdr:codex", kind: "id", value: "native-1" },
  };
  const get = vi.fn(async (pane: string) => (pane === agent.paneId || pane === "alias" ? agent : undefined));
  vi.spyOn(fleetRunner, "routeHerdrFleets").mockReturnValue({ get, wait: get, resolveTerminal: get });
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const submit = vi.spyOn(ConversationStore.prototype, "submitInbound").mockImplementation(() => {
    throw new Error("test before acceptance");
  });
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  try {
    const binding = await captain.fleetSeatMessageBinding(agent.paneId);
    expect(binding).toMatch(/^[a-f0-9]{64}$/u);
    const delivery = { id: randomUUID(), binding: binding! };
    agent = { ...agent, session: { ...agent.session!, value: "native-2" } };
    expect(await captain.receiveFleetSeatMessage(agent.paneId, "hello", delivery)).toMatchObject({
      received: false,
      deliveryStage: "uncertain",
    });
    expect(await captain.reconcileFleetSeatMessage(agent.paneId, delivery, "a".repeat(64))).toMatchObject({
      received: false,
      deliveryStage: "uncertain",
    });
    expect(submit).not.toHaveBeenCalled();
    expect(await captain.receiveFleetSeatMessage(agent.paneId, "legacy")).toBe(false);
    const current = await captain.fleetSeatMessageBinding(agent.paneId);
    expect(current).not.toBe(binding);
    expect(
      await captain.receiveFleetSeatMessage(agent.paneId, "hello", { ...delivery, binding: current! }),
    ).toMatchObject({ deliveryStage: "uncertain" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      await captain.receiveFleetSeatMessage("alias", "replacement", { id: randomUUID(), binding: current! }),
    ).toMatchObject({ deliveryStage: "uncertain" });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(await captain.fleetSeatMessageBinding("claimed-other-pane")).toBeUndefined();
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
