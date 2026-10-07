import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createFleetSettingsRoutes } from "../src/fleet-settings-routes.ts";
import { createWorkerAccountHoldsRoutes } from "../src/worker-account-holds-routes.ts";
import { FleetSettingsSnapshotSchema } from "@clankie/protocol";
import { WorkerAccountHoldsSchema } from "@clankie/protocol/worker-accounts";
import { fleetSettingsClient } from "../../tui/test/fixtures/fleet-settings-client.ts";
import { runFleetCommand } from "../../tui/src/command/fleet.ts";
import { runAccountsCommand } from "../../tui/src/command/accounts.ts";

it("shares complete fleet validation and revisions between CLI, API and durable settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-fleet-write-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    const options = fleetSettingsClient(settings);
    const routes = createFleetSettingsRoutes(async () => true, settings);
    const initial = FleetSettingsSnapshotSchema.parse(
      await (await routes.request("/v1/operator/fleet-settings")).json(),
    );
    await runFleetCommand(
      ["set", "--notes", "Use native workers", "--tools", "off", "--account", "work"],
      options,
    );
    const current = FleetSettingsSnapshotSchema.parse(
      await (await routes.request("/v1/operator/fleet-settings")).json(),
    );
    expect(current.fleet).toMatchObject({
      notes: "Use native workers",
      tools: "off",
      hire: { account: "work" },
    });
    expect(current.revision).not.toBe(initial.revision);
    const stale = await routes.request("/v1/operator/fleet-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        expectedRevision: initial.revision,
        changes: { notes: "stale" },
      }),
    });
    expect(stale.status).toBe(409);
    expect((await new SettingsStore(settings.path).load()).fleet.notes).toBe("Use native workers");
    await expect(
      runFleetCommand(["set", "--notes", "offline"], {
        ...options,
        fetchImpl: (async () => {
          throw new Error("offline");
        }) as typeof fetch,
      }),
    ).rejects.toThrow("offline");
    expect((await settings.load()).fleet.notes).toBe("Use native workers");
    await runFleetCommand(["clear"], options);
    expect((await settings.load()).fleet.hire).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("fences worker holds and release and rechecks owner authority before durable writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-worker-hold-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    const options = fleetSettingsClient(settings);
    let admitted = true;
    let revokeDuringWrite = false;
    let writeChecks = 0;
    const routes = createWorkerAccountHoldsRoutes(async (request) => {
      if (revokeDuringWrite && request.method === "POST" && ++writeChecks > 1) return "forbidden";
      return admitted ? true : "forbidden";
    }, settings);
    const client = {
      ...options,
      fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
        routes.fetch(new Request(String(url), init))) as typeof fetch,
    };
    const initial = WorkerAccountHoldsSchema.parse(
      await (await routes.request("/v1/worker-accounts/holds")).json(),
    );
    await runAccountsCommand(["hold", "codex", "work", "--reason", "Reserved"], client);
    const current = WorkerAccountHoldsSchema.parse(
      await (await routes.request("/v1/worker-accounts/holds")).json(),
    );
    expect(current.holds).toEqual([
      { machine: "local", harness: "codex", label: "work", reason: "Reserved" },
    ]);
    const stale = await routes.request("/v1/worker-accounts/holds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: initial.revision,
        harness: "codex",
        label: "work",
        held: false,
      }),
    });
    expect(stale.status).toBe(409);
    admitted = false;
    await expect(runAccountsCommand(["release", "codex", "work"], client)).rejects.toThrow();
    expect((await settings.load()).workerAccountHolds).toHaveLength(1);
    admitted = true;
    revokeDuringWrite = true;
    await expect(runAccountsCommand(["release", "codex", "work"], client)).rejects.toThrow(
      "Settings changed",
    );
    expect((await settings.load()).workerAccountHolds).toHaveLength(1);
    revokeDuringWrite = false;
    await runAccountsCommand(["release", "codex", "work"], client);
    expect((await new SettingsStore(settings.path).load()).workerAccountHolds).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
