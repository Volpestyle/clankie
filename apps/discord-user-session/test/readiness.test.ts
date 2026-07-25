import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";
import type { DiscordUserSessionOptIn } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { assertUserSessionAdmissible, type UserSessionAdmissionPort } from "../src/readiness.ts";

const PROFILE_HASH = "profile-hash-1";

describe("user-session admission (ADR 0048)", () => {
  it("admits a fully gated configuration and returns the brokered token", async () => {
    await expect(assertUserSessionAdmissible(input())).resolves.toMatchObject({
      profileHash: PROFILE_HASH,
      userToken: "user-token",
      optIn: { optInId: "opt-1" },
    });
  });

  it("refuses unless the plane is explicitly enabled", async () => {
    await expect(
      assertUserSessionAdmissible(input({ env: { ...env(), DISCORD_USER_SESSION_ENABLED: undefined } })),
    ).rejects.toMatchObject({ code: "discord_user_session_disabled" });
  });

  it("refuses an empty guild or channel allowlist", async () => {
    await expect(
      assertUserSessionAdmissible(input({ env: { ...env(), DISCORD_USER_SESSION_CHANNEL_IDS: "" } })),
    ).rejects.toMatchObject({ code: "discord_user_session_allowlist_required" });
  });

  it("refuses when no opt-in was recorded, and when it was revoked", async () => {
    await expect(assertUserSessionAdmissible(input({ optIn: undefined }))).rejects.toMatchObject({
      code: "discord_user_session_opt_in_required",
    });
    await expect(
      assertUserSessionAdmissible(input({ optIn: { ...optIn(), revokedAt: "2026-07-25T19:00:00.000Z" } })),
    ).rejects.toMatchObject({ code: "discord_user_session_opt_in_revoked" });
  });

  it("refuses an opt-in recorded under different doctrine or a different character", async () => {
    await expect(
      assertUserSessionAdmissible(input({ optIn: { ...optIn(), profileHash: "other-profile" } })),
    ).rejects.toMatchObject({ code: "discord_user_session_opt_in_profile_mismatch" });
    await expect(
      assertUserSessionAdmissible(input({ optIn: { ...optIn(), characterId: "someone-else" } })),
    ).rejects.toMatchObject({ code: "discord_user_session_opt_in_character_mismatch" });
  });

  it("refuses configuration that reaches past the recorded scope", async () => {
    // Editing an env var must not be able to extend a consent the owner gave
    // for a specific set of channels.
    await expect(
      assertUserSessionAdmissible(
        input({ env: { ...env(), DISCORD_USER_SESSION_CHANNEL_IDS: "channel-1,channel-99" } }),
      ),
    ).rejects.toMatchObject({ code: "discord_user_session_opt_in_scope_mismatch" });
  });

  it("allows configuration that narrows the recorded scope", async () => {
    await expect(
      assertUserSessionAdmissible(
        input({
          optIn: { ...optIn(), channelIds: ["channel-1", "channel-2"] },
          env: { ...env(), DISCORD_USER_SESSION_CHANNEL_IDS: "channel-1" },
        }),
      ),
    ).resolves.toMatchObject({ userToken: "user-token" });
  });

  it("never resolves the user credential when the run is refused", async () => {
    // Ordering matters: a refused run must not materialise a normal-user token
    // in process memory at all.
    const reads: string[] = [];
    await expect(
      assertUserSessionAdmissible(input({ optIn: undefined, onCredentialRead: (id) => reads.push(id) })),
    ).rejects.toThrow();
    expect(reads).toEqual([]);
  });

  it("refuses when the broker holds no user credential", async () => {
    await expect(assertUserSessionAdmissible(input({ credential: undefined }))).rejects.toMatchObject({
      code: "discord_user_session_credential_missing",
    });
  });
});

function optIn(): DiscordUserSessionOptIn {
  return {
    schemaVersion: 1,
    optInId: "opt-1",
    characterId: "clankie",
    credentialRef: "discord_user_session",
    profileHash: PROFILE_HASH,
    acknowledgement: "accepted",
    guildIds: ["guild-1"],
    channelIds: ["channel-1"],
    dmPolicy: "owner_only",
    recordedAt: "2026-07-25T18:00:00.000Z",
  };
}

function env(): NodeJS.ProcessEnv {
  return {
    DISCORD_USER_SESSION_ENABLED: "true",
    DISCORD_USER_SESSION_GUILD_IDS: "guild-1",
    DISCORD_USER_SESSION_CHANNEL_IDS: "channel-1",
  };
}

function input(
  overrides: {
    env?: NodeJS.ProcessEnv;
    optIn?: DiscordUserSessionOptIn | undefined;
    credential?: ProviderCredential | undefined;
    onCredentialRead?: (providerId: string) => void;
  } = {},
) {
  const credential: ProviderCredential | undefined =
    "credential" in overrides ? overrides.credential : { type: "api", key: "user-token" };
  const store = {
    get: (providerId: string) => {
      overrides.onCredentialRead?.(providerId);
      return Promise.resolve(credential);
    },
  } as unknown as CredentialStore;
  const resolved = "optIn" in overrides ? overrides.optIn : optIn();
  const api: UserSessionAdmissionPort = {
    getHealth: () => Promise.resolve({ profileHash: PROFILE_HASH }),
    inspectDiscordUserSessionOptIn: () => Promise.resolve(resolved),
  };
  return { env: overrides.env ?? env(), store, api, characterId: "clankie" };
}
