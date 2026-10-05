import type { BodyEffectGuard } from "@clankie/discord-presence-core";
import {
  createDefaultCredentialStore,
  DiscordUserSessionCredentialProvider,
} from "@clankie/credential-broker";
import {
  executeDiscordServerAction,
  parseDiscordIdSet,
  presenceActGrantRequest,
} from "@clankie/discord-presence-core";
import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import type {
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
  DiscordServerAction,
  DiscordServerActionResult,
  DiscordUserSessionOptIn,
} from "@clankie/protocol";
import { readDiscordServerSettings } from "@clankie/settings";
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
    env?: NodeJS.ProcessEnv;
    profileHash?: string;
    resolveOptIn?: (profileHash: string) => Promise<DiscordUserSessionOptIn | undefined>;
  } = {},
): {
  serverAction(
    input: DiscordServerAction,
    origin?: { source: "operator" | "discord"; sourceGuildId?: string | undefined },
  ): Promise<DiscordServerActionResult>;
  execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
    guard?: BodyEffectGuard,
  ): Promise<DiscordPresenceWriteResult>;
} {
  if (process.env.DISCORD_USER_TOKEN) {
    throw new Error(
      "DISCORD_USER_TOKEN must not be set. The user-session runtime reads discord_user_session from the credential broker.",
    );
  }
  const env = options.env ?? process.env;
  const resolveOptIn = options.resolveOptIn ?? loadOptInFromControlPlane;
  const provider = new DiscordUserSessionCredentialProvider({
    store: createDefaultCredentialStore(),
    allowedGuildIds: [...parseDiscordIdSet(process.env.DISCORD_USER_SESSION_GUILD_IDS)],
    allowedChannelIds: [...parseDiscordIdSet(process.env.DISCORD_USER_SESSION_CHANNEL_IDS)],
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
    async serverAction(input, origin) {
      const authority = await readDiscordServerSettings(env);
      // The lab body retains its separately recorded account opt-in. Its current
      // protocol covers selected channels, so it cannot authorize server-wide admin.
      if (authority.role === "admin")
        return {
          ok: false,
          message:
            "The lab account opt-in covers selected channels; server administration requires the official bot body.",
        };
      let userToken: string | undefined;
      return executeDiscordServerAction(
        input,
        authority,
        async (action) => {
          if (userToken === undefined) {
            const profileHash = options.profileHash ?? (await loadProfileHashFromControlPlane());
            const optIn = await resolveOptIn(profileHash);
            if (
              optIn === undefined ||
              optIn.revokedAt !== undefined ||
              !optIn.guildIds.includes(authority.serverId!) ||
              authority.fleetChannelId === undefined ||
              !optIn.channelIds.includes(authority.fleetChannelId)
            )
              throw new Error("discord_user_session_opt_in_scope_mismatch");
            const scoped = new DiscordUserSessionCredentialProvider({
              store: createDefaultCredentialStore(),
              allowedGuildIds: [authority.serverId!],
              allowedChannelIds: [],
              resolveOptIn: async (hash) => {
                const optIn = await resolveOptIn(hash);
                return optIn === undefined
                  ? undefined
                  : {
                      optInId: optIn.optInId,
                      profileHash: optIn.profileHash,
                      revoked: optIn.revokedAt !== undefined,
                    };
              },
            });
            const scope = {
              principalId: "clankie-server",
              missionId: "discord-server-action",
              profileHash,
              capability: "discord.presence.act" as const,
              guildIds: [authority.serverId!],
              channelIds: [],
            };
            const grant = await scoped.issueGrant(scope);
            userToken = await scoped.resolveUserToken({ grant, ...scope });
          }
          if (action.method !== "GET") {
            // Membership reads and credential resolution can yield while the
            // owner revokes this action. Recheck immediately before dispatch.
            const current = await readDiscordServerSettings(env);
            if (
              (
                [
                  "serverId",
                  "role",
                  "fleetEnabled",
                  "fleetChannelId",
                  "trackingLevel",
                  "teamVisible",
                ] as const
              ).some((field) => current[field] !== authority[field])
            )
              throw new Error("discord_server_authority_changed");
          }
          const response = await (options.fetch ?? globalThis.fetch)(
            `https://discord.com/api/v10${action.path}`,
            {
              method: action.method,
              headers: {
                authorization: userToken,
                ...(action.body === undefined ? {} : { "content-type": "application/json" }),
              },
              ...(action.body === undefined ? {} : { body: JSON.stringify(action.body) }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!response.ok) throw new Error("discord_server_action_failed");
          if (response.status === 204) return undefined;
          const text = await response.text();
          return text.length === 0 ? undefined : (JSON.parse(text) as unknown);
        },
        origin,
      );
    },
    async execute(write, session, guard) {
      const request = presenceActGrantRequest(write);
      const grant = await provider.issueGrant(request);
      const userToken = await provider.resolveUserToken({ grant, ...request });
      return new DiscordUserPresenceRuntime({
        token: userToken,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }).execute(write, session, guard);
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

async function loadProfileHashFromControlPlane(): Promise<string> {
  const { ClankieApiClient } = await import("@clankie/api-client");
  const api = new ClankieApiClient({ baseUrl: process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310" });
  return (await api.getHealth()).profileHash;
}
