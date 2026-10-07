import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  OfficialDiscordBodyRefusalSchema,
  type OfficialDiscordBodyStatus,
} from "@clankie/protocol/official-discord";
import { commandHost } from "./io.ts";

const DISCORD_OFFICIAL_USAGE = [
  "Usage: clankie discord official [status]",
  "       clankie discord official on    (needs clankie remote-access on)",
  "       clankie discord official off",
].join("\n");

export interface DiscordOfficialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly credentials?: CredentialStore;
  readonly fetchImpl?: typeof fetch;
}

export type DiscordOfficialResult = { readonly ok: true } & OfficialDiscordBodyStatus;

/**
 * The free official Clankie bot (VUH-1766), through the running service's
 * `/v1/discord/official` route: the same one the app uses. On and off take
 * effect at once. Adding the bot to a server finishes in a browser, because
 * Discord's installation is an OAuth consent the owner gives there.
 */
export async function runDiscordOfficialCommand(
  args: readonly string[],
  options: DiscordOfficialOptions = {},
): Promise<DiscordOfficialResult> {
  const env = options.env ?? process.env;
  const verb = args[0] ?? "status";
  if (args.length > 1 || !["status", "on", "off"].includes(verb)) throw new Error(DISCORD_OFFICIAL_USAGE);
  const credential = await resolveOperatorCredential({
    env,
    ...(options.credentials === undefined ? {} : { store: options.credentials }),
  });
  if (!credential) throw new Error("Operator authentication is unavailable");
  const client = new ClankieApiClient({
    baseUrl: commandHost({ env, ...(options.host === undefined ? {} : { host: options.host }) }),
    operatorToken: credential.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  try {
    const status =
      verb === "status" ? await client.discordOfficial() : await client.setDiscordOfficial(verb === "on");
    return { ok: true, ...status };
  } catch (error) {
    // A refusal names why and changed nothing; say it in its own words.
    const body = error instanceof Error ? /^Clankie API \d+: (.*)$/su.exec(error.message)?.[1] : undefined;
    let refusal;
    try {
      refusal = body === undefined ? undefined : OfficialDiscordBodyRefusalSchema.safeParse(JSON.parse(body));
    } catch {
      refusal = undefined;
    }
    if (refusal?.success) throw new Error(refusal.data.detail);
    throw error;
  }
}

export function formatDiscordOfficial(result: DiscordOfficialResult): string[] {
  const lines = [
    `official Clankie bot: ${result.enabled ? (result.running ? "on" : "on, not running yet") : "off"}`,
  ];
  const official = result.official;
  if (official) {
    lines.push(`registered with your account: ${official.registered ? "yes" : "no"}`);
    lines.push(
      `server: ${official.discord.connected ? `${official.discord.guildName ?? official.discord.guildId ?? "connected"}` : "not added yet"}`,
    );
    if (official.blocked) lines.push(`blocked (${official.blocked.scope}): ${official.blocked.reason}`);
    for (const usage of official.usage ?? [])
      lines.push(`  ${usage.limit}: ${String(usage.used)}/${String(usage.max)}`);
  } else if (result.fleetError) lines.push(`account status unavailable: ${result.fleetError}`);
  if (result.installUrl) lines.push(`add to Discord: ${result.installUrl}`);
  if (result.next) lines.push(result.next);
  return lines;
}
