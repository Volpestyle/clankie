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
  gatewayEnableWithAccount,
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

  it("configures explicit direct endpoints without changing gateway pairing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-direct-command-"));
    tempDirectories.push(directory);
    const settings = new SettingsStore(join(directory, "settings.json"));
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    const options = { settings, credentials, env: {}, fetchImpl: offline };
    const route = { controlPlaneUrl: "http://mac.tailnet:4310", relayUrl: "http://mac.tailnet:4321" };
    const result = await runGatewayCommand(
      ["direct", "--control-plane-url", route.controlPlaneUrl, "--relay-url", route.relayUrl],
      options,
    );
    expect(result.directRoute).toEqual(route);
    expect((await settings.load()).relay).toEqual({
      controlPlaneUrl: route.controlPlaneUrl,
      url: route.relayUrl,
    });
    expect(result.publicGateway).toEqual({});
    await expect(
      runGatewayCommand(
        [
          "direct",
          "--control-plane-url",
          "https://api.clankie.bot/h/mac_james_12345678",
          "--relay-url",
          route.relayUrl,
        ],
        options,
      ),
    ).rejects.toThrow();
    await expect(runGatewayCommand(["direct", "--relay-url", route.relayUrl], options)).rejects.toThrow();
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

  it("re-signs a signed-out Mac in under its existing installation id and host id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-gateway-resign-"));
    tempDirectories.push(directory);
    const settings = new SettingsStore(join(directory, "settings.json"));
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    const installationId = "YWFhYWFhYWFhYWFhYWFhYQ";
    await settings.update((current) => ({
      ...current,
      publicGateway: { url: "https://api.clankie.bot", installationId },
    }));
    const options = { settings, credentials, env: {}, fetchImpl: offline };
    const before = await gatewayStatus(options);
    expect(before.enabled).toBe(false);

    const signedIn = await gatewayEnableWithAccount(
      {
        gatewayUrl: "https://api.clankie.bot",
        credential: {
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 3_600_000,
          accountId: "0f892112-c0d9-4221-b57b-38181aa63f4c",
        },
      },
      options,
    );
    expect(signedIn).toMatchObject({ enabled: true, credentialPresent: true });
    expect(signedIn.publicGateway.installationId).toBe(installationId);
    expect(signedIn.hostId).toBe(
      derivePublicGatewayHostId("0f892112-c0d9-4221-b57b-38181aa63f4c", installationId),
    );
  });

  it("accepts the short on/off/rotate-key verbs as the long ones", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-gateway-verbs-"));
    tempDirectories.push(directory);
    const settings = new SettingsStore(join(directory, "settings.json"));
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    const options = { settings, credentials, env: {}, fetchImpl: offline };
    await runGatewayCommand(["rotate-key"], options);
    expect((await credentials.get(PUBLIC_GATEWAY_ENCRYPTION_PROVIDER_ID))?.type).toBe("api");
    await gatewayConfigure({ url: "https://api.clankie.bot", hostId: "mac_james_12345678" }, options);
    expect((await runGatewayCommand(["off"], options)).publicGateway).toEqual({});
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
