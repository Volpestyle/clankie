import {
  CLANKIE_ACCOUNT_PROVIDER_ID,
  createClankieAccountTokenProvider,
  createDefaultCredentialStore,
  type CredentialStore,
} from "@clankie/credential-broker";
import { hostedOrigin } from "@clankie/protocol/hosted-pairing";
import {
  OFFICIAL_DISCORD_ACCOUNT_PAGE,
  OFFICIAL_DISCORD_PATHS,
  OfficialDiscordStatusSchema,
  type OfficialDiscordStatus,
} from "@clankie/protocol/official-discord";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";

const DISCORD_OFFICIAL_USAGE = [
  "Usage: clankie discord official [status]",
  "       clankie discord official on    (needs clankie remote-access on; then clankie restart)",
  "       clankie discord official off",
].join("\n");

export interface DiscordOfficialOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
  readonly credentials?: CredentialStore;
  readonly fetchImpl?: typeof fetch;
}

export interface DiscordOfficialResult {
  readonly ok: true;
  readonly enabled: boolean;
  /** What the hosted fleet reports; absent when this machine is not signed in. */
  readonly official?: OfficialDiscordStatus;
  /** Where to finish Add to Discord, in a browser signed in to the same account. */
  readonly installUrl?: string;
  readonly next?: string;
}

/**
 * The free official Clankie bot (VUH-1766), API-first: these commands only edit
 * this machine's setting and read the account's route from the hosted fleet.
 * Adding the bot to a server finishes in a browser, because Discord's
 * installation is an OAuth consent the owner gives there.
 */
export async function runDiscordOfficialCommand(
  args: readonly string[],
  options: DiscordOfficialOptions = {},
): Promise<DiscordOfficialResult> {
  const env = options.env ?? process.env;
  const settings = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  const credentials = options.credentials ?? createDefaultCredentialStore({ env });
  const verb = args[0] ?? "status";
  if (args.length > 1 || !["status", "on", "off"].includes(verb)) throw new Error(DISCORD_OFFICIAL_USAGE);
  const current = await settings.load();
  const gatewayUrl = current.publicGateway.url;
  const account = await credentials.get(CLANKIE_ACCOUNT_PROVIDER_ID);
  const signedIn =
    gatewayUrl !== undefined &&
    current.publicGateway.installationId !== undefined &&
    account?.type === "oauth" &&
    account.accountId !== undefined;
  const request = async (path: string, method: "GET" | "POST"): Promise<unknown> => {
    if (!signedIn || gatewayUrl === undefined) throw new Error("not_signed_in");
    const { token } = await createClankieAccountTokenProvider({
      gatewayUrl,
      store: credentials,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    })();
    const response = await (options.fetchImpl ?? fetch)(new URL(path, hostedOrigin(gatewayUrl)), {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify({}) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = (body as { error?: unknown } | undefined)?.error;
      throw new Error(
        `Clankie account refused the official bot request: ${typeof code === "string" ? code : String(response.status)}`,
      );
    }
    return body;
  };
  const installUrl =
    gatewayUrl === undefined
      ? undefined
      : new URL(OFFICIAL_DISCORD_ACCOUNT_PAGE, hostedOrigin(gatewayUrl)).toString();

  if (verb === "on") {
    if (!signedIn)
      throw new Error(
        "Sign in to your Clankie account first: clankie remote-access on. The official bot uses that account's connection.",
      );
    // One gateway connection per bot token: a bring-your-own bot stays on its own
    // token, but this machine must not also run the official application's token.
    const official = OfficialDiscordStatusSchema.parse(await request(OFFICIAL_DISCORD_PATHS.status, "GET"));
    if (
      official.applicationId !== undefined &&
      current.discord.applicationId === official.applicationId &&
      current.discord.activeBody === "bot"
    )
      throw new Error(
        "This machine's own Discord bot is the official Clankie application. Stop its direct bridge first (clankie discord clear --application-id and remove the bot token in /discord), so only the hosted edge holds that token.",
      );
    await settings.update((value) => ({ ...value, discord: { ...value.discord, officialBotEnabled: true } }));
    return {
      ok: true,
      enabled: true,
      ...(installUrl === undefined ? {} : { installUrl }),
      next: "Run clankie restart, then open installUrl in a browser signed in to the same Clankie account and choose Add to Discord.",
    };
  }
  if (verb === "off") {
    await settings.update((value) => ({
      ...value,
      discord: { ...value.discord, officialBotEnabled: false },
    }));
    // Removing the route disconnects the server and deletes the edge's buffered chat.
    if (signedIn) await request(OFFICIAL_DISCORD_PATHS.unregister, "POST");
    return { ok: true, enabled: false, next: "Run clankie restart." };
  }
  const enabled = current.discord.officialBotEnabled;
  if (!signedIn)
    return {
      ok: true,
      enabled,
      next: "Sign in with clankie remote-access on to use the free official Clankie bot.",
    };
  const official = OfficialDiscordStatusSchema.parse(await request(OFFICIAL_DISCORD_PATHS.status, "GET"));
  return {
    ok: true,
    enabled,
    official,
    installUrl: official.installUrl,
    ...(official.blocked
      ? {
          next: `The official bot is blocked for this ${official.blocked.scope === "account" ? "account" : "server"}: ${official.blocked.reason}`,
        }
      : !enabled
        ? { next: "Turn it on with clankie discord official on." }
        : !official.registered
          ? { next: "Run clankie restart so this machine registers with your account." }
          : !official.discord.connected
            ? { next: "Open installUrl and choose Add to Discord." }
            : {}),
  };
}

export function formatDiscordOfficial(result: DiscordOfficialResult): string[] {
  const lines = [`official Clankie bot: ${result.enabled ? "on" : "off"}`];
  const official = result.official;
  if (official) {
    lines.push(`registered with your account: ${official.registered ? "yes" : "no"}`);
    lines.push(
      `server: ${official.discord.connected ? `${official.discord.guildName ?? official.discord.guildId ?? "connected"}` : "not added yet"}`,
    );
    if (official.blocked) lines.push(`blocked (${official.blocked.scope}): ${official.blocked.reason}`);
    for (const usage of official.usage ?? [])
      lines.push(`  ${usage.limit}: ${String(usage.used)}/${String(usage.max)}`);
  }
  if (result.installUrl) lines.push(`add to Discord: ${result.installUrl}`);
  if (result.next) lines.push(result.next);
  return lines;
}
