import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { APPEARANCE_SETTINGS_PATH, AppearanceSettingsSnapshotSchema } from "@clankie/protocol/owner-settings";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { createAppearanceRoutes } from "../src/appearance-routes.ts";

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
    expect(first.appearance).toEqual({ leadSkin: "pack" });

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

    const stale = await request("POST", {
      schemaVersion: 1,
      expectedRevision: first.revision,
      changes: { leadSkin: "pack" },
    });
    expect(stale.status).toBe(409);
    for (const changes of [{}, { leadSkin: "Not An Id" }, { leadSkin: "pack", extra: true }]) {
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
    expect((await settings.load()).appearance.leadSkin).toBe("clankie.lead.operator");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reaches hosted devices through the operator and gateway allowlists", async () => {
  expect(hostedOperatorAllows("GET", APPEARANCE_SETTINGS_PATH)).toBe(true);
  expect(hostedOperatorAllows("POST", APPEARANCE_SETTINGS_PATH)).toBe(true);
  expect(hostedOperatorAllows("DELETE", APPEARANCE_SETTINGS_PATH)).toBe(false);
});
