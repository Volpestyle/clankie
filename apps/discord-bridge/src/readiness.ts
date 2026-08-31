import type { DiscordControlPlaneReadiness } from "@clankie/api-client";
import {
  DISCORD_BOT_PROVIDER_ID,
  resolveDiscordBridgeCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { ApplicationFlagsBitField, REST, Routes } from "discord.js";

export interface DiscordReadinessCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly remediation: string;
}

export interface DiscordTextReadinessReport {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly checks: readonly DiscordReadinessCheck[];
}

interface DiscordRestReadPort {
  get(route: `/${string}`): Promise<unknown>;
}

interface DiscordControlPlaneReadinessPort {
  inspectDiscordReadiness(): Promise<DiscordControlPlaneReadiness>;
}

export interface InspectDiscordTextReadinessOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly store: CredentialStore;
  readonly api: DiscordControlPlaneReadinessPort;
  readonly rest?: DiscordRestReadPort;
  readonly clock?: () => Date;
}

/**
 * Performs credential-safe live readiness checks for the official-bot text path.
 * No token, Discord message content, user name, guild name, or channel name enters
 * the report.
 */
export async function inspectDiscordTextReadiness(
  options: InspectDiscordTextReadinessOptions,
): Promise<DiscordTextReadinessReport> {
  const checks: DiscordReadinessCheck[] = [];
  const add = (name: string, ok: boolean, detail: string, remediation: string): DiscordReadinessCheck => {
    const check = { name, ok, detail, remediation };
    checks.push(check);
    return check;
  };
  const forbiddenEnvironmentCredentials = ["DISCORD_BOT_TOKEN", "DISCORD_USER_TOKEN"].filter(
    (name) => options.env[name],
  );
  add(
    "credential environment",
    forbiddenEnvironmentCredentials.length === 0,
    forbiddenEnvironmentCredentials.length === 0
      ? "Discord credentials are absent from the process environment"
      : `${forbiddenEnvironmentCredentials.length.toString()} forbidden credential variable(s) are set`,
    "Remove Discord token environment variables; store the official bot token as discord_bot.",
  );

  const botCredential = await options.store.get(DISCORD_BOT_PROVIDER_ID);
  const botToken = botCredential?.type === "api" ? botCredential.key : undefined;
  add(
    "official bot credential",
    botToken !== undefined,
    botToken === undefined
      ? "broker entry discord_bot is missing or not an API credential"
      : "present in broker",
    "Run clankie, open /auth, and add the official bot token under provider discord_bot.",
  );

  try {
    const bridgeToken = await resolveDiscordBridgeCredential({ store: options.store });
    add(
      "bridge identity",
      bridgeToken !== undefined,
      bridgeToken === undefined ? "broker entry clankie_discord_bridge is missing" : "present in broker",
      "Start the clankie service once so it can mint the local Discord bridge identity.",
    );
  } catch (error) {
    add(
      "bridge identity",
      false,
      error instanceof Error ? error.message : "stored bridge identity is invalid",
      "Remove the malformed clankie_discord_bridge entry and restart the clankie service.",
    );
  }
  const applicationId = discordId(options.env.DISCORD_APPLICATION_ID);
  const guildId = discordId(options.env.DISCORD_GUILD_ID);
  const swarmGuildId = discordId(options.env.DISCORD_SWARM_GUILD_ID);
  const ambientRoles = discordIdSet(options.env.DISCORD_AMBIENT_ROLE_IDS);
  const ambientUsers = discordIdSet(options.env.DISCORD_AMBIENT_USER_IDS);
  const ingressGuilds = discordIdSet(options.env.DISCORD_INGRESS_GUILD_IDS);
  const ingressChannels = discordIdSet(options.env.DISCORD_INGRESS_CHANNEL_IDS);
  const presenceGuilds = discordIdSet(options.env.DISCORD_PRESENCE_GUILD_IDS);
  const presenceChannels = discordIdSet(options.env.DISCORD_PRESENCE_CHANNEL_IDS);

  add(
    "application id",
    applicationId !== undefined,
    applicationId === undefined ? "DISCORD_APPLICATION_ID is missing or invalid" : "configured",
    "Set DISCORD_APPLICATION_ID to the official Discord application's numeric id.",
  );
  add(
    "target guild",
    guildId !== undefined,
    guildId === undefined ? "DISCORD_GUILD_ID is missing or invalid" : "configured",
    "Set DISCORD_GUILD_ID to the guild used for live proof.",
  );
  add(
    "swarm home",
    swarmGuildId !== undefined,
    swarmGuildId === undefined ? "DISCORD_SWARM_GUILD_ID is missing or invalid" : "configured",
    "Set DISCORD_SWARM_GUILD_ID to the one server Clankie controls; channels are made only there.",
  );
  // Either binding admits: `authorizeAmbientCommand` takes a named user or a
  // mapped role, so an owner who granted themselves directly is configured, not
  // incomplete. Counts only — no id, name, or handle enters the report.
  const ambientBindings = ambientRoles.size + ambientUsers.size;
  add(
    "ambient authority",
    ambientBindings > 0,
    ambientBindings === 0
      ? "no ambient role or user binding is configured"
      : `${ambientRoles.size.toString()} role binding(s) and ${ambientUsers.size.toString()} user binding(s) configured`,
    "Set DISCORD_AMBIENT_ROLE_IDS or DISCORD_AMBIENT_USER_IDS to grant the ambient command tier by role or by named user.",
  );
  add(
    "text ingress enabled",
    options.env.DISCORD_TEXT_INGRESS_ENABLED === "true",
    options.env.DISCORD_TEXT_INGRESS_ENABLED === "true" ? "enabled" : "disabled",
    "Set DISCORD_TEXT_INGRESS_ENABLED=true and enable Message Content Intent in the Discord portal.",
  );
  // An empty channel allowlist is the wildcard, not a gap (ADR 0133): it admits
  // every channel inside an approved guild. Requiring a channel here would
  // report the ordinary whole-guild configuration as incomplete.
  const ingressReady = guildId !== undefined && ingressGuilds.has(guildId);
  add(
    "ingress allowlist",
    ingressReady,
    !ingressReady
      ? "the target guild is not on the ingress allowlist"
      : ingressChannels.size === 0
        ? "every channel in the target guild is admitted"
        : `${ingressChannels.size.toString()} channel(s) admitted in the target guild`,
    "Include DISCORD_GUILD_ID in DISCORD_INGRESS_GUILD_IDS; leave DISCORD_INGRESS_CHANNEL_IDS empty to admit the whole guild.",
  );
  // Presence has to cover whatever ingress admits. A presence wildcard covers
  // anything; a restricted presence list covers a named ingress subset, but
  // cannot cover an ingress wildcard — that would leave admitted channels with
  // no way to answer.
  const presenceCoversIngress =
    presenceChannels.size === 0
      ? true
      : ingressChannels.size > 0 && [...ingressChannels].every((id) => presenceChannels.has(id));
  const presenceReady = guildId !== undefined && presenceGuilds.has(guildId) && presenceCoversIngress;
  add(
    "presence allowlist",
    presenceReady,
    presenceReady
      ? presenceChannels.size === 0
        ? "every channel in the target guild can receive governed replies"
        : "every admitted ingress channel can receive governed replies"
      : guildId === undefined || !presenceGuilds.has(guildId)
        ? "the target guild is not on the presence allowlist"
        : "presence grants do not cover every admitted ingress channel",
    "Mirror the target guild into DISCORD_PRESENCE_GUILD_IDS, and either leave DISCORD_PRESENCE_CHANNEL_IDS empty or include every admitted ingress channel.",
  );

  try {
    const readiness = await options.api.inspectDiscordReadiness();
    const ready = readiness.ready && Object.values(readiness.checks).every(Boolean);
    add(
      "service composition",
      ready,
      ready
        ? "event store, Clankie channel turns, and Discord presence runtime are ready"
        : "one or more Discord service dependencies are unavailable",
      "Start the clankie service with CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE configured.",
    );
  } catch (error) {
    add(
      "service composition",
      false,
      error instanceof Error ? error.message : "service readiness request failed",
      "Start the clankie service on CLANKIE_API_URL with the Discord presence runtime configured.",
    );
  }

  if (botToken !== undefined && applicationId !== undefined) {
    const rest = options.rest ?? new REST({ version: "10" }).setToken(botToken);
    try {
      const application = asRecord(await rest.get(Routes.currentApplication()));
      const liveApplicationId = typeof application.id === "string" ? application.id : undefined;
      add(
        "Discord application identity",
        liveApplicationId === applicationId,
        liveApplicationId === applicationId
          ? "brokered bot token matches DISCORD_APPLICATION_ID"
          : "brokered bot token does not match DISCORD_APPLICATION_ID",
        "Store the matching official bot token or correct DISCORD_APPLICATION_ID.",
      );
      const flags = typeof application.flags === "number" ? application.flags : 0;
      const applicationFlags = new ApplicationFlagsBitField(flags);
      const messageContentEnabled =
        applicationFlags.has(ApplicationFlagsBitField.Flags.GatewayMessageContent) ||
        applicationFlags.has(ApplicationFlagsBitField.Flags.GatewayMessageContentLimited);
      add(
        "Message Content Intent",
        messageContentEnabled,
        messageContentEnabled ? "enabled for the Discord application" : "not enabled for the application",
        "Enable Message Content Intent on the Bot page in the Discord developer portal.",
      );
    } catch (error) {
      add(
        "Discord application identity",
        false,
        error instanceof Error ? error.message : "Discord application lookup failed",
        "Verify the brokered bot token and network access, then rerun readiness.",
      );
      add(
        "Message Content Intent",
        false,
        "not checked because the Discord application lookup failed",
        "Resolve the Discord application identity check first.",
      );
    }

    if (guildId !== undefined) {
      try {
        // See voice-readiness.ts: fetching the guild is the bot-usable
        // membership probe; the `@me` member routes are unavailable to bots.
        await rest.get(Routes.guild(guildId));
        add("Discord guild membership", true, "official bot is installed in the target guild", "");
      } catch (error) {
        add(
          "Discord guild membership",
          false,
          error instanceof Error ? error.message : "target guild membership lookup failed",
          "Install the official bot in DISCORD_GUILD_ID with application.commands and required bot permissions.",
        );
      }
    } else {
      add(
        "Discord guild membership",
        false,
        "not checked because the target guild is missing",
        "Resolve the target guild check first.",
      );
    }

    if (swarmGuildId !== undefined) {
      // Making a room needs two permissions the ordinary text lane never
      // exercises, so an install can be perfectly healthy and still fail the
      // first time a channel is projected. Checked here so that lands as a
      // readiness line rather than a failed room.
      try {
        const missing = await missingSwarmPermissions(rest, swarmGuildId, applicationId);
        add(
          "swarm home permissions",
          missing.length === 0,
          missing.length === 0
            ? "Manage Channels, Manage Webhooks, and Send Messages are granted in the swarm home"
            : `missing ${missing.join(" and ")} in the swarm home`,
          "Reinstall the bot with the invite from /discord invite, which requests all three. Guild-wide grants can still be denied on one room by that channel's permission overwrites.",
        );
      } catch (error) {
        add(
          "swarm home permissions",
          false,
          error instanceof Error ? error.message : "swarm home permission lookup failed",
          "Verify the bot is installed in DISCORD_SWARM_GUILD_ID, then rerun readiness.",
        );
      }
    } else {
      add(
        "swarm home permissions",
        false,
        "not checked because the swarm home is missing",
        "Resolve the swarm home check first.",
      );
    }
  } else {
    add(
      "Discord application identity",
      false,
      "not checked because the bot credential or application id is missing",
      "Resolve the official bot credential and application id checks first.",
    );
    add(
      "Message Content Intent",
      false,
      "not checked because the bot credential or application id is missing",
      "Resolve the official bot credential and application id checks first.",
    );
    add(
      "Discord guild membership",
      false,
      "not checked because live Discord identity is incomplete",
      "Resolve the bot credential, application id, and target guild checks first.",
    );
    add(
      "swarm home permissions",
      false,
      "not checked because live Discord identity is incomplete",
      "Resolve the bot credential and application id checks first.",
    );
  }

  return {
    schemaVersion: 1,
    ready: checks.every((check) => check.ok),
    checkedAt: (options.clock ?? (() => new Date()))().toISOString(),
    checks,
  };
}

const MANAGE_CHANNELS = 1n << 4n;
const MANAGE_WEBHOOKS = 1n << 29n;
const SEND_MESSAGES = 1n << 11n;
const ADMINISTRATOR = 1n << 3n;

/**
 * Which room-making permissions the bot lacks across the swarm home,
 * by name of the permission only — no guild, channel, role, or member name
 * enters the report. A bot application's user id is its application id, so the
 * member lookup needs no extra identity call.
 */
async function missingSwarmPermissions(
  rest: DiscordRestReadPort,
  swarmGuildId: string,
  applicationId: string,
): Promise<readonly string[]> {
  const member = asRecord(await rest.get(`/guilds/${swarmGuildId}/members/${applicationId}`));
  const held = new Set(Array.isArray(member.roles) ? member.roles.map(String) : []);
  const guild = asRecord(await rest.get(`/guilds/${swarmGuildId}`));
  const roles = Array.isArray(guild.roles) ? guild.roles : [];
  let granted = 0n;
  for (const entry of roles) {
    const role = asRecord(entry);
    const id = typeof role.id === "string" ? role.id : undefined;
    // The guild id is `@everyone`, which every member holds without listing it.
    if (id === undefined || !(id === swarmGuildId || held.has(id))) continue;
    if (typeof role.permissions === "string") granted |= BigInt(role.permissions);
  }
  if ((granted & ADMINISTRATOR) !== 0n) return [];
  return [
    ...((granted & MANAGE_CHANNELS) === 0n ? ["Manage Channels"] : []),
    ...((granted & MANAGE_WEBHOOKS) === 0n ? ["Manage Webhooks"] : []),
    ...((granted & SEND_MESSAGES) === 0n ? ["Send Messages"] : []),
  ];
}

export function discordId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{5,30}$/u.test(trimmed) ? trimmed : undefined;
}

export function discordIdSet(value: string | undefined): ReadonlySet<string> {
  return new Set(
    value
      ?.split(",")
      .map((entry) => discordId(entry))
      .filter((entry): entry is string => entry !== undefined) ?? [],
  );
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
