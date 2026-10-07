import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { HOST_SETTINGS_PATH, HostSettingsSnapshotSchema } from "@clankie/protocol/owner-settings";
import { createHostSettingsRoutes } from "../src/host-settings-routes.ts";
import { runUpdateCommand } from "../../tui/src/command/update.ts";
import { runAwakeCommand } from "../../tui/src/command/awake.ts";

it("shares host settings revisions between CLI and API without offline overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-owner-settings-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    let applied = 0;
    let allowed = true;
    const app = createHostSettingsRoutes(
      async (request) =>
        allowed && request.headers.get("authorization") === "Bearer owner" ? true : "forbidden",
      settings,
      {
        platform: "darwin",
        applyKeepAwake: async () => {
          applied++;
        },
      },
    );
    const options = {
      repoRoot: root,
      env: { CLANKIE_OPERATOR_TOKEN: "owner" },
      host: "http://host-owner.test",
      fetchImpl: (async (input, init) => app.fetch(new Request(String(input), init))) as typeof fetch,
    };
    const initial = (await runUpdateCommand(["auto"], options)) as { revision: string };
    await runAwakeCommand(["on"], options);
    expect(applied).toBe(1);
    expect((await new SettingsStore(settings.path).load()).host.keepAwake).toBe(true);
    await expect(
      runUpdateCommand(["auto", "off", "--expected-revision", initial.revision], options),
    ).rejects.toThrow("Settings changed");
    await runUpdateCommand(["auto", "off"], options);
    expect((await settings.load()).host.autoUpdate).toBe(false);
    allowed = false;
    await expect(runAwakeCommand(["off"], options)).rejects.toThrow("forbidden");
    await expect(
      runUpdateCommand(["auto", "on"], {
        ...options,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect((await settings.load()).host).toEqual({ keepAwake: true, autoUpdate: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects stale/revoked authority, unsupported Macs and managed update opt-outs", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-owner-boundary-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    let checks = 0;
    const app = createHostSettingsRoutes(async () => (++checks < 4 ? true : "forbidden"), settings, {
      platform: "linux",
      autoUpdateManaged: true,
    });
    const state = HostSettingsSnapshotSchema.parse(await (await app.request(HOST_SETTINGS_PATH)).json());
    checks = 0;
    const write = (changes: object) =>
      app.request(HOST_SETTINGS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, expectedRevision: state.revision, changes }),
      });
    expect((await write({ keepAwake: true })).status).toBe(400);
    expect((await write({ autoUpdate: false })).status).toBe(400);
    checks = 2;
    expect((await write({ keepAwake: false })).status).toBe(409);
    expect((await new SettingsStore(settings.path).load()).host).toEqual({
      keepAwake: false,
      autoUpdate: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("makes a saved but unapplied keep-awake choice reconcilable without claiming success", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-owner-apply-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    const app = createHostSettingsRoutes(async () => true, settings, {
      platform: "darwin",
      applyKeepAwake: async () => {
        throw new Error("launcher unavailable");
      },
    });
    const initial = HostSettingsSnapshotSchema.parse(await (await app.request(HOST_SETTINGS_PATH)).json());
    const response = await app.request(HOST_SETTINGS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        expectedRevision: initial.revision,
        changes: { keepAwake: true },
      }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ saved: true });
    const state = HostSettingsSnapshotSchema.parse(await (await app.request(HOST_SETTINGS_PATH)).json());
    expect(state.host.keepAwake).toBe(true);
    expect(state.revision).not.toBe(initial.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("withholds a host snapshot when control is revoked during status collection", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-owner-read-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    let allowed = true;
    const app = createHostSettingsRoutes(async () => (allowed ? true : "forbidden"), settings, {
      keepAwakeStatus: async () => {
        allowed = false;
        return { state: "healthy" };
      },
    });
    expect((await app.request(HOST_SETTINGS_PATH)).status).toBe(403);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses incomplete explicit revisions and local-setup revision bypasses before transport", async () => {
  const options = {
    repoRoot: "/unused",
    fetchImpl: async () => {
      throw new Error("must not contact host");
    },
  };
  await expect(runAwakeCommand(["on", "--expected-revision"], options)).rejects.toThrow("Usage");
  await expect(
    runAwakeCommand(["on", "--local-setup", "--expected-revision", "a".repeat(64)], options),
  ).rejects.toThrow("Usage");
});
