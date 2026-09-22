import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  FileCredentialStore,
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
  PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID,
  derivePublicGatewayHostId,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  gatewayConfigure,
  gatewayDisable,
  gatewayStatus,
  runGatewayCommand,
} from "../src/command/gateway.ts";

/** The doorway probe is a seam: a test never reads whatever captain is running locally. */
const offline: typeof fetch = () => Promise.reject(new Error("no probe in tests"));

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
      { settings, credentials, env: {}, fetchImpl: offline },
    );
    expect(configured).toMatchObject({ enabled: true, credentialPresent: true });
    expect((await settings.load()).publicGateway).toEqual({
      url: "https://api.clankie.bot",
      hostId: "mac_james_12345678",
    });

    await gatewayDisable({ settings, credentials, env: {}, fetchImpl: offline });
    expect(await gatewayStatus({ settings, credentials, env: {}, fetchImpl: offline })).toMatchObject({
      enabled: false,
      credentialPresent: false,
      publicGateway: {},
    });
  });

  it("rotates only the encryption wrapping key and leaves restart explicit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-gateway-rotation-"));
    tempDirectories.push(directory);
    const settings = new SettingsStore(join(directory, "settings.json"));
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    await credentials.set(PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID, { type: "api", key: "a".repeat(64) });
    const rotated = await runGatewayCommand(["rotate-encryption-key"], {
      settings,
      credentials,
      env: {},
      fetchImpl: offline,
    });
    const key = await credentials.get(PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID);
    expect(key?.type === "api" && key.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(key?.type === "api" && key.key).not.toBe("a".repeat(64));
    expect(rotated.restart).toBe("clankie restart captain");
  });

  it("reports an account-derived host identity and removes it on disable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-gateway-account-command-"));
    tempDirectories.push(directory);
    const settings = new SettingsStore(join(directory, "settings.json"));
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    const accountId = "0f892112-c0d9-4221-b57b-38181aa63f4c";
    const installationId = "YWFhYWFhYWFhYWFhYWFhYQ";
    await credentials.set(CLANKIE_ACCOUNT_PROVIDER_ID, {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId,
      clientId: "client-id",
    });

    await gatewayConfigure(
      { url: "https://api.clankie.bot", installationId },
      { settings, credentials, env: {}, fetchImpl: offline },
    );
    expect(await gatewayStatus({ settings, credentials, env: {}, fetchImpl: offline })).toMatchObject({
      enabled: true,
      credentialPresent: true,
      hostId: derivePublicGatewayHostId(accountId, installationId),
    });

    await gatewayDisable({ settings, credentials, env: {}, fetchImpl: offline });
    expect(await credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID)).toBeUndefined();
  });

  it("reports the doorway the captain has, not the one the settings describe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-gateway-doorway-"));
    tempDirectories.push(directory);
    const settings = new SettingsStore(join(directory, "settings.json"));
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    await credentials.set(CLANKIE_ACCOUNT_PROVIDER_ID, {
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "0f892112-c0d9-4221-b57b-38181aa63f4c",
      clientId: "client-id",
    });
    await gatewayConfigure(
      { url: "https://api.clankie.bot", installationId: "YWFhYWFhYWFhYWFhYWFhYQ" },
      { settings, credentials, env: {}, fetchImpl: offline },
    );

    const signedOut = await gatewayStatus({
      settings,
      credentials,
      env: {},
      fetchImpl: () =>
        Promise.resolve(
          Response.json({
            ok: true,
            service: "clankie",
            doorway: { state: "sign_in_required", since: "2026-09-14T10:11:40.689Z" },
          }),
        ),
    });
    // Configured and credentialled, and still nothing reaches this Mac.
    expect(signedOut).toMatchObject({
      enabled: true,
      credentialPresent: true,
      doorway: { state: "sign_in_required", since: "2026-09-14T10:11:40.689Z" },
    });

    const noCaptain = await gatewayStatus({ settings, credentials, env: {}, fetchImpl: offline });
    expect(noCaptain.doorway).toEqual({ state: "unreachable" });
  });
});
