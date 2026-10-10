import { fleetSettingsClient } from "./fixtures/fleet-settings-client.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { DeployHolds } from "../../clankie/src/deploy-holds.ts";
import { createRuntimeUpdateRoutes } from "../../clankie/src/runtime-update-routes.ts";
import type { RuntimeUpdater } from "../bin/runtime-updater.ts";
import {
  fleetStatus,
  formatDeployHoldLines,
  runFleetCommand,
  formatFleetLines,
} from "../src/command/fleet.ts";

it("persists CLI gate presets and individual overrides without changing push or release", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-gates-cli-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    await runFleetCommand(["set", "--push", "owner", "--release", "owner"], fleetSettingsClient(settings));
    const result = await runFleetCommand(["set", "--gate-preset", "hands-off", "--hard-to-undo", "owner"], {
      ...fleetSettingsClient(settings),
    });
    const disk = await new SettingsStore(settings.path).load();
    expect(disk.autonomy.fleet).toMatchObject({
      everydayWork: "allow",
      leavesMac: "lead",
      hardToUndo: "owner",
      moneyAndAccounts: "owner",
      push: "owner",
      release: { mode: "owner" },
    });
    expect(formatFleetLines(result.fleet).join("\n")).toContain("Money and accounts");
    await expect(
      runFleetCommand(["set", "--money-and-accounts", "allow"], fleetSettingsClient(settings)),
    ).rejects.toThrow();
    expect((await settings.load()).autonomy.fleet.moneyAndAccounts).toBe("owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fleet status names each deploy hold's holder, age and time left through runtime-update status", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-deploy-holds-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    const client = fleetSettingsClient(settings);
    // The CLI reads age and time left on its own clock; this registry placed the hold 25 minutes ago.
    const holds = new DeployHolds(join(root, "integration"), undefined, () => Date.now() - 25 * 60_000);
    // Only the hold registry and route are real here; the updater's own status is incidental.
    const updates = createRuntimeUpdateRoutes({
      updater: { status: () => ({}) } as unknown as RuntimeUpdater,
      holds,
      authorize: async (request) =>
        request.headers.get("authorization") === `Bearer ${client.env.CLANKIE_OPERATOR_TOKEN}`
          ? { guard: async () => {}, current: () => true }
          : undefined,
    });
    const fetchImpl = ((url: RequestInfo | URL, init?: RequestInit) =>
      new URL(String(url)).pathname === "/v1/runtime-update"
        ? updates.fetch(new Request(String(url), init))
        : client.fetchImpl(url, init)) as typeof fetch;
    expect((await fleetStatus({ ...client, fetchImpl })).deployHolds).toEqual({ holds: [] });
    const id = randomUUID();
    await holds.acquire({ id, holder: "Saga w4:p1", reason: "release gate", minutes: 30 });
    const status = await fleetStatus({ ...client, fetchImpl });
    expect(formatDeployHoldLines(status.deployHolds)).toEqual([
      "deploy holds:",
      `  ${id} · Saga w4:p1: release gate (held 25m, 5m left)`,
    ]);
    // A machine without runtime updates says so rather than reporting no holds.
    expect((await fleetStatus(client)).deployHolds).toMatchObject({ unavailable: expect.any(String) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
