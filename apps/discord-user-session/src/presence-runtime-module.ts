import {
  createDefaultCredentialStore,
  DiscordUserSessionCredentialProvider,
} from "@clankie/credential-broker";
import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import type {
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
  DiscordUserSessionOptIn,
} from "@clankie/protocol";
import { DiscordUserPresenceRuntime } from "./user-presence-runtime.ts";

/**
 * Trusted service load target for the user-session transport
 * (`CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE`, ADR 0048).
 *
 * Mirrors the bot plane's module contract so the service treats both the
 * same way: policy is decided centrally, and only this privileged module ever
 * resolves connection material. The user token is never read from the
 * environment, and a per-action grant is re-checked against the durable opt-in
 * before it is exchanged.
 */
export function createDiscordUserPresenceRuntime(
  options: {
    fetch?: typeof globalThis.fetch;
    resolveOptIn?: (profileHash: string) => Promise<DiscordUserSessionOptIn | undefined>;
  } = {},
): {
  execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
  ): Promise<DiscordPresenceWriteResult>;
} {
  if (process.env.DISCORD_USER_TOKEN) {
    throw new Error(
      "DISCORD_USER_TOKEN must not be set. The user-session runtime reads discord_user_session from the credential broker.",
    );
  }
  const resolveOptIn = options.resolveOptIn ?? loadOptInFromControlPlane;
  const provider = new DiscordUserSessionCredentialProvider({
    store: createDefaultCredentialStore(),
    allowedGuildIds: commaSeparated(process.env.DISCORD_USER_SESSION_GUILD_IDS),
    allowedChannelIds: commaSeparated(process.env.DISCORD_USER_SESSION_CHANNEL_IDS),
    resolveOptIn: async (profileHash) => {
      const optIn = await resolveOptIn(profileHash);
      if (optIn === undefined) return undefined;
      return {
        optInId: optIn.optInId,
        profileHash: optIn.profileHash,
        revoked: optIn.revokedAt !== undefined,
      };
    },
  });
  return {
    async execute(write, session) {
      const guildIds = "guildId" in write.payload ? [write.payload.guildId] : [];
      const channelIds = "channelId" in write.payload ? [write.payload.channelId] : [];
      const principalId = write.identity.workerRunId ?? write.identity.characterId;
      const capabilityScopeId =
        write.identity.missionId ?? `discord-presence:${write.identity.presenceSessionId ?? "unknown"}`;
      const request = {
        principalId,
        missionId: capabilityScopeId,
        profileHash: write.identity.profileHash,
        capability: "discord.presence.act" as const,
        guildIds,
        channelIds,
      };
      const grant = await provider.issueGrant(request);
      const userToken = await provider.resolveUserToken({ grant, ...request });
      return new DiscordUserPresenceRuntime({
        token: userToken,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }).execute(write, session);
    },
  };
}

/**
 * Reads the durable opt-in the service already owns. The record is public
 * to an authenticated local caller and carries no token material, so the module
 * does not need its own store.
 */
async function loadOptInFromControlPlane(profileHash: string): Promise<DiscordUserSessionOptIn | undefined> {
  const { ClankieApiClient } = await import("@clankie/api-client");
  const { resolveDiscordUserBridgeCredential } = await import("@clankie/credential-broker");
  const captainToken = await resolveDiscordUserBridgeCredential({});
  if (captainToken === undefined) return undefined;
  const api = new ClankieApiClient({
    baseUrl: process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310",
    captainToken,
  });
  const optIn = await api.inspectDiscordUserSessionOptIn();
  return optIn?.profileHash === profileHash ? optIn : undefined;
}

function commaSeparated(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
