import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { ConfiguredMediaGenerator } from "../src/media-generation.ts";
import { SkinDraftService } from "../src/skin-drafts.ts";
import { skinDraftGenerator } from "../src/skin-draft-generation.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { startFixtureServer } from "./owner-settings-surface-fixture.ts";

/** Child-process boundary for actual service death/restart, with a loopback-only provider. */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [root, provider, admission] = process.argv.slice(2);
  if (!root || !provider || new URL(provider).hostname !== "127.0.0.1")
    throw Error("Fixture needs a local provider");
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const credential = await ensureOperatorCredential({ env: {}, store: credentials });
  await credentials.set("openai", { type: "api", key: "local-fixture-only" });
  await mkdir(join(root, "config", "clankie"), { recursive: true });
  await writeFile(
    join(root, "config", "clankie", "clankie.json"),
    JSON.stringify({ image_model: "openai/gpt-image-2" }),
  );
  const attachmentRoot = join(root, "files");
  const mediaRoot = join(root, "private-media");
  const media = new ConfiguredMediaGenerator({
    credentials,
    attachmentRoot: mediaRoot,
    configCwd: root,
    environment: { XDG_CONFIG_HOME: join(root, "config") },
    fetchImpl: (input, init) => fetch(provider + new URL(input).pathname, init),
  });
  const service = new SkinDraftService({
    root: join(root, "drafts"),
    ownerId: "fixture-owner",
    files: new DeliveredFileStore(attachmentRoot),
    generator: skinDraftGenerator({
      media,
      attachmentRoot: mediaRoot,
      admit: async () => admission === "admitted",
    }),
  });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    settings: new SettingsStore(join(root, "settings.json")),
    skinDrafts: service,
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: {},
      store: credentials,
      identity: { operatorId: "fixture-owner" },
    }),
  });
  const server = await startFixtureServer(app.app.fetch);
  process.send?.({ kind: "ready", host: server.host, token: credential.token });
  process.on("message", (message) => {
    if (message !== "stop") return;
    void (async () => {
      app.close();
      await server.close();
      process.disconnect();
    })();
  });
}
