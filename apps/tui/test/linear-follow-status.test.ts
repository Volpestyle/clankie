import { linearOwnerFixture } from "./linear-owner-fixture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore, LINEAR_WEBHOOK_PROVIDER_ID } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { runLinearCommand } from "../src/command/linear.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("makes an empty owner rule visible in status and stops warning after an explicit owner edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "linear-follow-status-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const secret = "webhook-secret-must-not-appear";
  await credentials.set(LINEAR_WEBHOOK_PROVIDER_ID, { type: "api", key: secret });
  await settings.update((current) => ({
    ...current,
    linearWebhook: {
      ...current.linearWebhook,
      following: true,
      url: "https://example.com/linear",
      wake: { ...current.linearWebhook.wake, ownerUserEmails: [] },
    },
  }));
  const options = await linearOwnerFixture(settings, credentials);
  const before = await settings.load();
  const status = await runLinearCommand(["status"], options);
  expect(status).toMatchObject({
    ok: true,
    following: true,
    active: true,
    wakeWarning: "following is on, but no owner IDs or emails, so owner comments never wake.",
  });
  expect(await settings.load()).toEqual(before);
  expect(JSON.stringify(status)).not.toContain(secret);

  await runLinearCommand(["wake", "set", "--owner-user-ids", "james"], options);
  expect(await runLinearCommand(["status"], options)).toMatchObject({
    following: true,
    active: true,
    wakeWarning: null,
  });
  expect((await settings.load()).linearWebhook.wake).toMatchObject({
    actors: ["owner"],
    ownerUserIds: ["james"],
    excludedNotificationTypes: ["issueSubscribed"],
  });
});
