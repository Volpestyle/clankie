import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LinearWakeSettingsSchema, SettingsStore, linearWakeMatches } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const legacyDefaults = {
  ownerUserIds: [],
  actors: ["owner"],
  userIds: [],
  notificationTypes: [],
  excludedNotificationTypes: ["issueSubscribed"],
};

async function storedRules(wake: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "linear-wake-migration-"));
  roots.push(root);
  const store = new SettingsStore(join(root, "settings.json"));
  await writeFile(store.path, JSON.stringify({ schemaVersion: 1, linearWebhook: { following: true, wake } }));
  return store;
}

it.each([{ ownerUserIds: [] }, { ownerUserIds: ["configured-owner"] }])(
  "migrates saved legacy defaults once while preserving owner identity %j",
  async ({ ownerUserIds }) => {
    const store = await storedRules({ ...legacyDefaults, ownerUserIds });
    const original = await readFile(store.path, "utf8");
    const expected = LinearWakeSettingsSchema.parse({ ownerUserIds });
    const loaded = await store.load();
    expect(loaded.linearWebhook).toMatchObject({
      following: true,
      wakeConversationId: "global-default",
      wake: expected,
    });
    const fenced = await store.loadFenced();
    expect(fenced.settings.linearWebhook.wake).toEqual(expected);
    expect(() => fenced.assertCurrent()).not.toThrow();
    expect(await readFile(store.path, "utf8")).toBe(original);
    // No owner email is assumed: only a saved owner ID identifies the owner.
    const owner = { id: "configured-owner", email: "owner@example.test" };
    const configured = ownerUserIds.length > 0;
    expect(expected.ownerUserEmails).toEqual([]);
    expect(linearWakeMatches(expected, "issueNewComment", owner, "app")).toBe(configured);
    expect(linearWakeMatches(expected, "issueStatusChanged", owner, "app")).toBe(false);

    // A normal settings write persists the new shape, so an intentional later
    // all-types setting is not mistaken for the legacy saved default again.
    await store.update((current) => current);
    expect(JSON.parse(await readFile(store.path, "utf8")).linearWebhook.wake).toEqual(expected);
    await store.update((current) => ({
      ...current,
      linearWebhook: {
        ...current.linearWebhook,
        wake: { ...current.linearWebhook.wake, notificationTypes: [] },
      },
    }));
    const reloaded = await new SettingsStore(store.path).load();
    expect(reloaded.linearWebhook.wake).toEqual({ ...expected, notificationTypes: [] });
    expect(linearWakeMatches(reloaded.linearWebhook.wake, "issueStatusChanged", owner, "app")).toBe(
      configured,
    );
  },
);

it.each([
  { actors: ["human"] },
  { actors: [] },
  { userIds: ["selected-user"] },
  { notificationTypes: ["issueStatusChanged"] },
  { excludedNotificationTypes: [] },
  { excludedNotificationTypes: ["issueSubscribed", "issueNewComment"] },
  { ownerUserEmails: ["owner@example.test"] },
  { ownerUserEmails: [] },
])("preserves owner-edited rules %j", async (patch) => {
  const wake = { ...legacyDefaults, ...patch };
  const store = await storedRules(wake);
  expect((await store.load()).linearWebhook.wake).toEqual(LinearWakeSettingsSchema.parse(wake));
  await store.update((current) => current);
  expect((await new SettingsStore(store.path).load()).linearWebhook.wake).toEqual(
    LinearWakeSettingsSchema.parse(wake),
  );
});

it.each([{ ownerUserIds: [""] }, { unexpected: true }])(
  "does not hide malformed legacy rules %j",
  async (patch) => {
    const store = await storedRules({ ...legacyDefaults, ...patch });
    const original = await readFile(store.path, "utf8");
    await expect(store.load()).rejects.toThrow();
    await expect(store.loadFenced()).rejects.toThrow();
    expect(await readFile(store.path, "utf8")).toBe(original);
  },
);
