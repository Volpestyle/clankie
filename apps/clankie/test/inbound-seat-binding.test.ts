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
  const get = vi.fn(async (pane: string) => {
    if (pane === agent.paneId || pane === "alias") return agent;
    throw new Error("unknown native pane");
  });
  vi.spyOn(fleetRunner, "routeHerdrFleets").mockReturnValue({ get, wait: get, resolveTerminal: get });
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const submit = vi.spyOn(ConversationStore.prototype, "submitInbound").mockImplementation(() => {
    throw new Error("test before acceptance");
  });
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
    nativeCensusRunner: async (_command, args) => {
      // Census follows the mutable native session, never the submitted binding.
      const current = await get(agent.paneId);
      const row = {
        pane_id: current.paneId,
        terminal_id: current.terminalId,
        agent: current.agent,
        agent_status: current.status,
        title: current.title,
        agent_session: current.session,
      };
      let result: unknown;
      if (args[0] === "agent" && args[1] === "list") result = { agents: [row] };
      else if (args[0] === "agent" && args[1] === "get") result = { agent: row };
      else if (args[0] === "pane" && args[1] === "list") result = { panes: [row] };
      else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
      else if (args[0] === "api" && args[1] === "snapshot")
        result = { snapshot: { agents: [row], panes: [row], workspaces: [], tabs: [] } };
      else throw new Error(`Unexpected external Herdr command: ${args.join(" ")}`);
      return { stdout: JSON.stringify({ result }), stderr: "" };
    },
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
