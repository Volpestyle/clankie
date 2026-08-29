import { describe, expect, it } from "vitest";
import {
  DISCORD_USER_SESSION_PROVIDER_ID,
  DiscordUserSessionCredentialProvider,
  DiscordUserSessionDenied,
  type DiscordUserSessionOptInProof,
} from "../src/discord-user-session-provider.ts";
import type { CredentialStore, ProviderCredential } from "../src/credential-store.ts";

const PROFILE_HASH = "profile-hash-1";

describe("DiscordUserSessionCredentialProvider", () => {
  it("issues and redeems a scoped grant when a matching opt-in is live", async () => {
    const provider = build({ optIn: activeOptIn() });
    const request = grantRequest();
    const grant = await provider.issueGrant(request);
    await expect(provider.resolveUserToken({ grant, ...request })).resolves.toBe("user-token");
  });

  it("refuses to mint a grant when no opt-in was ever recorded", async () => {
    const provider = build({ optIn: undefined });
    await expect(provider.issueGrant(grantRequest())).rejects.toMatchObject({
      name: "DiscordUserSessionDenied",
      code: "discord_user_session_opt_in_required",
    });
  });

  it("stops the next action when the opt-in is revoked mid-grant", async () => {
    // Revocation must bite immediately rather than waiting for grant expiry:
    // the owner pulling consent is the whole point of the control.
    let optIn: DiscordUserSessionOptInProof | undefined = activeOptIn();
    const provider = build({ resolveOptIn: () => Promise.resolve(optIn) });
    const request = grantRequest();
    const grant = await provider.issueGrant(request);
    optIn = { ...activeOptIn(), revoked: true };
    await expect(provider.resolveUserToken({ grant, ...request })).rejects.toMatchObject({
      code: "discord_user_session_opt_in_revoked",
    });
  });

  it("refuses an opt-in recorded under a different profile hash", async () => {
    const provider = build({ optIn: { optInId: "opt-1", profileHash: "other-profile", revoked: false } });
    await expect(provider.issueGrant(grantRequest())).rejects.toMatchObject({
      code: "discord_user_session_opt_in_profile_mismatch",
    });
  });

  it("refuses guilds and channels outside the configured allowlist", async () => {
    const provider = build({ optIn: activeOptIn() });
    await expect(provider.issueGrant({ ...grantRequest(), guildIds: ["guild-9"] })).rejects.toMatchObject({
      code: "discord_user_session_guild_not_allowed",
    });
    await expect(provider.issueGrant({ ...grantRequest(), channelIds: ["channel-9"] })).rejects.toMatchObject(
      { code: "discord_user_session_channel_not_allowed" },
    );
    await expect(
      provider.issueGrant({ ...grantRequest(), guildIds: [], channelIds: [] }),
    ).rejects.toMatchObject({ code: "discord_user_session_resource_required" });
  });

  it("refuses a grant redeemed for a resource it does not cover", async () => {
    const provider = build({ optIn: activeOptIn() });
    const request = grantRequest();
    const grant = await provider.issueGrant({ ...request, channelIds: [] });
    await expect(provider.resolveUserToken({ grant, ...request })).rejects.toBeInstanceOf(
      DiscordUserSessionDenied,
    );
  });

  it("refuses when the broker holds no user credential", async () => {
    const provider = build({ optIn: activeOptIn(), credential: undefined });
    await expect(provider.issueGrant(grantRequest())).rejects.toMatchObject({
      code: "discord_user_session_credential_missing",
    });
  });
});

function activeOptIn(): DiscordUserSessionOptInProof {
  return { optInId: "opt-1", profileHash: PROFILE_HASH, revoked: false };
}

function grantRequest() {
  return {
    principalId: "clankie",
    missionId: "discord-presence:discord:guild-1:channel-1",
    profileHash: PROFILE_HASH,
    capability: "discord.presence.act" as const,
    guildIds: ["guild-1"],
    channelIds: ["channel-1"],
  };
}

function build(options: {
  optIn?: DiscordUserSessionOptInProof | undefined;
  resolveOptIn?: () => Promise<DiscordUserSessionOptInProof | undefined>;
  credential?: ProviderCredential | undefined;
}): DiscordUserSessionCredentialProvider {
  const credential: ProviderCredential | undefined =
    "credential" in options ? options.credential : { type: "api", key: "user-token" };
  const store: CredentialStore = {
    get: (providerId: string) =>
      Promise.resolve(providerId === DISCORD_USER_SESSION_PROVIDER_ID ? credential : undefined),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve([]),
  } as unknown as CredentialStore;
  return new DiscordUserSessionCredentialProvider({
    store,
    allowedGuildIds: ["guild-1"],
    allowedChannelIds: ["channel-1"],
    resolveOptIn: options.resolveOptIn ?? (() => Promise.resolve(options.optIn)),
  });
}
