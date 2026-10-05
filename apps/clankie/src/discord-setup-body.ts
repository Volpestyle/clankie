import {
  DISCORD_BODY_PERMISSIONS_PATH,
  DISCORD_BODY_TEST_POST_PATH,
  DiscordPermissionsSnapshotSchema,
  DiscordSetupTestPostResultSchema,
  parseProtocolResponse,
  type DiscordPermissionsRequest,
  type DiscordPermissionsSnapshot,
  type DiscordBodyTestPostRequest,
  type DiscordSetupTestPostResult,
} from "@clankie/protocol";

interface BodyOptions {
  body: "bot" | "user_session";
  token: string;
  env: NodeJS.ProcessEnv;
}
function bodyUrl(path: string, options: BodyOptions) {
  const port =
    options.body === "bot"
      ? (options.env.CLANKIE_DISCORD_BRIDGE_CONTROL_PORT ?? "4313")
      : (options.env.CLANKIE_USER_SESSION_CONTROL_PORT ?? "4312");
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535 || !options.token)
    throw new Error("discord_setup_runtime_unavailable");
  return new URL(path, `http://127.0.0.1:${port}`);
}
export async function readDiscordBodyPermissions(
  query: DiscordPermissionsRequest,
  options: BodyOptions,
): Promise<DiscordPermissionsSnapshot> {
  const unknown: DiscordPermissionsSnapshot = {
    body: options.body,
    ...query,
    permissions: {
      view_channel: "not_checked",
      send_messages: "not_checked",
      manage_channels: "not_checked",
      manage_webhooks: "not_checked",
    },
  };
  try {
    const url = bodyUrl(DISCORD_BODY_PERMISSIONS_PATH, options);
    for (const [key, value] of Object.entries(query)) if (value) url.searchParams.set(key, value);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return unknown;
    const snapshot = parseProtocolResponse(DiscordPermissionsSnapshotSchema, await response.json());
    if (
      snapshot.body !== options.body ||
      (query.guildId && snapshot.guildId !== query.guildId) ||
      snapshot.channelId !== query.channelId
    )
      return unknown;
    return snapshot;
  } catch {
    return unknown;
  }
}
export async function postDiscordBodyTest(
  query: DiscordBodyTestPostRequest,
  options: BodyOptions,
): Promise<DiscordSetupTestPostResult> {
  let url: URL;
  try {
    url = bodyUrl(DISCORD_BODY_TEST_POST_PATH, options);
  } catch {
    return { outcome: "unavailable", reason: "runtime_unavailable" };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(12_000),
    });
    if ([400, 401, 403, 404, 405].includes(response.status))
      return { outcome: "unavailable", reason: "runtime_unavailable" };
    if (!response.ok) return { outcome: "unconfirmed", reason: "post_receipt_unavailable" };
    const result = parseProtocolResponse(DiscordSetupTestPostResultSchema, await response.json());
    if (
      result.outcome === "posted" &&
      (result.body !== options.body ||
        result.guildId !== query.guildId ||
        result.channelId !== query.channelId)
    )
      return { outcome: "unconfirmed", reason: "post_receipt_unavailable" };
    return result;
  } catch {
    return { outcome: "unconfirmed", reason: "post_receipt_unavailable" };
  }
}
