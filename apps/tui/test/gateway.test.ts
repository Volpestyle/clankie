import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore, PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { gatewayDisable, gatewayStatus, runGatewayCommand } from "../src/command/gateway.ts";

describe("gateway command", () => {
  const tempDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("configures non-secret routing and removes both halves on disable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-gateway-command-"));
    tempDirectories.push(directory);
    const settings = new SettingsStore(join(directory, "settings.json"));
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    await credentials.set(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID, { type: "api", key: "x".repeat(32) });

    const configured = await runGatewayCommand(
      ["set", "--host-id", "mac_james_12345678", "--url", "https://api.clankie.bot"],
      { settings, credentials, env: {} },
    );
    expect(configured).toMatchObject({ enabled: true, credentialPresent: true });
    expect((await settings.load()).publicGateway).toEqual({
      url: "https://api.clankie.bot",
      hostId: "mac_james_12345678",
    });

    await gatewayDisable({ settings, credentials, env: {} });
    expect(await gatewayStatus({ settings, credentials, env: {} })).toMatchObject({
      enabled: false,
      credentialPresent: false,
      publicGateway: {},
    });
  });
});
