import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  disconnectHostedCli,
  NO_HOSTED_CLANKIE_MESSAGE,
  routeSignedInAccount,
} from "../src/command/hosted.ts";

const credential = {
  type: "oauth",
  access: "access",
  refresh: "refresh",
  expires: Date.now() + 3_600_000,
  accountId: "0f892112-c0d9-4221-b57b-38181aa63f4c",
} as const;

describe("clankie login routing", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function stores() {
    const directory = await mkdtemp(join(tmpdir(), "clankie-login-routing-"));
    directories.push(directory);
    const settingsFile = join(directory, "settings.json");
    return {
      env: { CLANKIE_SETTINGS_FILE: settingsFile } as NodeJS.ProcessEnv,
      settings: new SettingsStore(settingsFile),
      store: new FileCredentialStore(join(directory, "credentials.json")),
    };
  }

  const account = (tenant: unknown): typeof fetch => (async () => Response.json({ tenant })) as typeof fetch;

  it("signs this Mac in for remote access when the account has no hosted Clankie", async () => {
    const { env, settings, store } = await stores();
    const route = await routeSignedInAccount({
      target: "auto",
      gatewayUrl: "https://api.clankie.bot",
      credential,
      env,
      store,
      settings,
      fetchImpl: account(null),
    });
    expect(route).toMatchObject({ kind: "this-mac", output: { ok: true, mode: "remote-access" } });
    expect((await store.get("clankie-account"))?.type).toBe("oauth");
    expect((await settings.load()).publicGateway.url).toBe("https://api.clankie.bot");
  });

  it("connects the hosted Clankie instead when the account has one", async () => {
    const { env, settings, store } = await stores();
    const route = await routeSignedInAccount({
      target: "auto",
      gatewayUrl: "https://api.clankie.bot",
      credential,
      env,
      store,
      settings,
      fetchImpl: account({ id: "tenant" }),
    });
    expect(route).toEqual({ kind: "hosted" });
    expect(await store.get("clankie-account")).toBeUndefined();
  });

  it("keeps `remote-access on` on this Mac even when the account has a hosted Clankie", async () => {
    const { env, settings, store } = await stores();
    const route = await routeSignedInAccount({
      target: "this-mac",
      gatewayUrl: "https://api.clankie.bot",
      credential,
      env,
      store,
      settings,
      fetchImpl: account({ id: "tenant" }),
    });
    expect(route.kind).toBe("this-mac");
  });

  it("makes `connect hosted` explain, not enable a doorway, when there is no hosted Clankie", async () => {
    const { env, settings, store } = await stores();
    await expect(
      routeSignedInAccount({
        target: undefined,
        gatewayUrl: "https://api.clankie.bot",
        credential,
        env,
        store,
        settings,
        fetchImpl: account(null),
      }),
    ).rejects.toThrow(NO_HOSTED_CLANKIE_MESSAGE);
    expect(await store.get("clankie-account")).toBeUndefined();
  });

  it("treats a fleet that has never heard of the account as having no hosted Clankie", async () => {
    const { env, settings, store } = await stores();
    await expect(
      routeSignedInAccount({
        target: "auto",
        gatewayUrl: "https://api.clankie.bot",
        credential,
        env,
        store,
        settings,
        fetchImpl: (async () => Response.json({ error: "not_found" }, { status: 404 })) as typeof fetch,
      }),
    ).resolves.toMatchObject({ kind: "this-mac" });
  });

  it("still signs this Mac in when the fleet rejects this client's token (401)", async () => {
    const { env, settings, store } = await stores();
    const route = await routeSignedInAccount({
      target: "auto",
      gatewayUrl: "https://api.clankie.bot",
      credential,
      env,
      store,
      settings,
      fetchImpl: (async () => Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch,
    });
    expect(route.kind).toBe("this-mac");
    expect((await store.get("clankie-account"))?.type).toBe("oauth");
  });

  it("logout on a Mac that is not a hosted client points at remote-access off and changes nothing", async () => {
    const { env, store } = await stores();
    await store.set("clankie-account", credential);
    const result = await disconnectHostedCli(env);
    expect(result.message).toContain("clankie remote-access off");
    expect((await store.get("clankie-account"))?.type).toBe("oauth");
  });
});
