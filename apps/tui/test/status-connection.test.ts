import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { statusCommand } from "../src/command/status.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

it("folds whoami and the phone-access next step into status without reading credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-status-connection-"));
  directories.push(directory);
  const status = await statusCommand({
    repoRoot: "/unused",
    env: {
      CLANKIE_SETTINGS_FILE: join(directory, "settings.json"),
      CLANKIE_OPERATOR_TOKEN: "operator-secret",
    },
    operatorCredentialStore: new FileCredentialStore(join(directory, "operator.json")),
    captainCredentialStore: new FileCredentialStore(join(directory, "captain.json")),
    listProcessCommandsImpl: () => [],
    listPortOwnersImpl: () => [],
    fetchImpl: (async () =>
      Response.json({
        ok: true,
        doorway: { state: "sign_in_required", since: "2026-09-29T13:27:00Z" },
      })) as typeof fetch,
  });

  expect(status.connection).toEqual({ mode: "local", label: "This Mac" });
  expect(status.doorway).toEqual({ state: "sign_in_required", since: "2026-09-29T13:27:00Z" });
  expect(status.nextStep).toContain('"Sign this Mac back in"');
});
