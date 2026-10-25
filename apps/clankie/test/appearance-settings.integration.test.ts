import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { APPEARANCE_SETTINGS_PATH, AppearanceSettingsSnapshotSchema } from "@clankie/protocol/owner-settings";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { runNavigationCommand } from "../../tui/src/command/navigation.ts";
import { createAppearanceRoutes } from "../src/appearance-routes.ts";

it.each([{}, { appearance: {} }, { appearance: { petSkin: "clankie.pet.hoodie" } }])(
  "serves Hoodie for an absent lead selection in persisted settings %j",
  async (stored) => {
    const root = await mkdtemp(join(tmpdir(), "appearance-default-"));
    try {
      const file = join(root, "settings.json");
      await writeFile(file, JSON.stringify({ schemaVersion: 1, ...stored }));
      const settings = new SettingsStore(file);
      const app = createAppearanceRoutes(async () => true, settings);
      const response = await app.fetch(new Request(`http://owner.test${APPEARANCE_SETTINGS_PATH}`));
      expect(response.status).toBe(200);
      const snapshot = AppearanceSettingsSnapshotSchema.parse(await response.json());
      expect(snapshot.appearance.leadSkin).toBe("clankie.lead.hoodie");
      expect(snapshot.appearance.petSkin).toBe(
        "appearance" in stored && "petSkin" in stored.appearance ? stored.appearance.petSkin : undefined,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("stores Clankie's look once for every surface, fenced by revision and owner authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "appearance-settings-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    let allowed = true;
    const app = createAppearanceRoutes(async () => (allowed ? true : "forbidden"), settings);
    const request = (method: "GET" | "POST", body?: unknown) =>
      app.fetch(
        new Request(`http://owner.test${APPEARANCE_SETTINGS_PATH}`, {
          method,
          ...(body === undefined
            ? {}
            : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
        }),
      );

    const first = AppearanceSettingsSnapshotSchema.parse(await (await request("GET")).json());
    expect(first.appearance).toEqual({ leadSkin: "clankie.lead.hoodie" });
    expect((await new SettingsStore(settings.path).load()).appearance.leadSkin).toBe("clankie.lead.hoodie");

    const saved = await request("POST", {
      schemaVersion: 1,
      expectedRevision: first.revision,
      changes: { leadSkin: "clankie.lead.operator" },
    });
    expect(saved.status).toBe(200);
    const second = AppearanceSettingsSnapshotSchema.parse(await saved.json());
    expect(second.appearance.leadSkin).toBe("clankie.lead.operator");
    expect(second.revision).not.toBe(first.revision);
    expect((await new SettingsStore(settings.path).load()).appearance.leadSkin).toBe("clankie.lead.operator");

    // Pet packs are independent of World/chat lead art, including packs this client cannot render.
    const pet = await request("POST", {
      schemaVersion: 1,
      expectedRevision: second.revision,
      changes: { petSkin: "hoodie" },
    });
    expect(pet.status).toBe(200);
    const petSnapshot = AppearanceSettingsSnapshotSchema.parse(await pet.json());
    expect(petSnapshot.appearance).toEqual({ leadSkin: "clankie.lead.operator", petSkin: "hoodie" });
    const leadOnly = await request("POST", {
      schemaVersion: 1,
      expectedRevision: petSnapshot.revision,
      changes: { leadSkin: "pack" },
    });
    const leadSnapshot = AppearanceSettingsSnapshotSchema.parse(await leadOnly.json());
    expect(leadSnapshot.appearance).toEqual({ leadSkin: "pack", petSkin: "hoodie" });
    expect((await new SettingsStore(settings.path).load()).appearance.leadSkin).toBe("pack");
    const future = await request("POST", {
      schemaVersion: 1,
      expectedRevision: leadSnapshot.revision,
      changes: { petSkin: "future.robot" },
    });
    const futureSnapshot = AppearanceSettingsSnapshotSchema.parse(await future.json());
    expect((await new SettingsStore(settings.path).load()).appearance.petSkin).toBe("future.robot");
    const cleared = await request("POST", {
      schemaVersion: 1,
      expectedRevision: futureSnapshot.revision,
      changes: { petSkin: null },
    });
    expect(AppearanceSettingsSnapshotSchema.parse(await cleared.json()).appearance).toEqual({
      leadSkin: "pack",
      petSkin: null,
    });

    const stale = await request("POST", {
      schemaVersion: 1,
      expectedRevision: first.revision,
      changes: { leadSkin: "pack" },
    });
    expect(stale.status).toBe(409);
    for (const changes of [
      {},
      { leadSkin: "Not An Id" },
      { petSkin: "Not An Id" },
      { leadSkin: "pack", extra: true },
    ]) {
      expect(
        (await request("POST", { schemaVersion: 1, expectedRevision: second.revision, changes })).status,
      ).toBe(400);
    }
    allowed = false;
    expect((await request("GET")).status).toBe(403);
    expect(
      (
        await request("POST", {
          schemaVersion: 1,
          expectedRevision: second.revision,
          changes: { leadSkin: "pack" },
        })
      ).status,
    ).toBe(403);
    expect((await settings.load()).appearance).toEqual({ leadSkin: "pack", petSkin: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reaches hosted devices through the operator and gateway allowlists", async () => {
  expect(hostedOperatorAllows("GET", APPEARANCE_SETTINGS_PATH)).toBe(true);
  expect(hostedOperatorAllows("POST", APPEARANCE_SETTINGS_PATH)).toBe(true);
  expect(hostedOperatorAllows("DELETE", APPEARANCE_SETTINGS_PATH)).toBe(false);
});

it("shares ordered primary navigation, preserving other appearance fields and rejecting invalid lists", async () => {
  const root = await mkdtemp(join(tmpdir(), "navigation-settings-"));
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    const app = createAppearanceRoutes(async () => true, settings);
    const read = async () =>
      AppearanceSettingsSnapshotSchema.parse(await (await app.request(APPEARANCE_SETTINGS_PATH)).json());
    const write = async (revision: string, changes: unknown) =>
      app.request(APPEARANCE_SETTINGS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, expectedRevision: revision, changes }),
      });
    const first = await read();
    const options = {
      ownerFetcher: { fetch: async (path: string, init?: RequestInit) => app.request(path, init) },
    };
    expect((await runNavigationCommand(["set", "messages,work"], options)).navigation).toEqual([
      "messages",
      "work",
    ]);
    expect((await runNavigationCommand([], options)).navigation).toEqual(["messages", "work"]);
    const current = await read();
    expect((await write(current.revision, { navigation: ["work", "messages", "world"] })).status).toBe(200);
    const saved = await read();
    expect(saved.appearance.navigation).toEqual(["work", "messages", "world"]);
    expect((await new SettingsStore(settings.path).load()).appearance.navigation).toEqual(
      saved.appearance.navigation,
    );
    expect((await write(first.revision, { navigation: ["terminal"] })).status).toBe(409);
    for (const navigation of [[], ["work", "work"], ["unknown"], ["search"]]) {
      expect((await write(saved.revision, { navigation })).status).toBe(400);
    }
    await write(saved.revision, { leadSkin: "hoodie" });
    expect((await read()).appearance).toEqual({
      leadSkin: "hoodie",
      navigation: ["work", "messages", "world"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
