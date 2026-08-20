import { resolveDiscordActiveBody } from "@clankie/settings";

export function postToDiscordActiveBody(
  path: string,
  body: unknown,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const port =
    resolveDiscordActiveBody(env) === "user_session"
      ? env.CLANKIE_USER_SESSION_CONTROL_PORT?.trim() || "4312"
      : env.CLANKIE_DISCORD_BRIDGE_CONTROL_PORT?.trim() || "4313";
  return fetchImpl(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}
