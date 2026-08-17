import { DiscordVoicePresenceResultSchema, type DiscordVoicePresenceResult } from "@clankie/protocol";
import { resolveDiscordActiveBody } from "@clankie/settings";

export function createDiscordVoicePresenceClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): {
  join(input: { guildId?: string; actorId?: string }): Promise<DiscordVoicePresenceResult>;
  leave(input: { guildId?: string; actorId?: string }): Promise<DiscordVoicePresenceResult>;
} {
  const call = (action: "join" | "leave", body: { guildId?: string; actorId?: string }) =>
    postVoicePresence(action, body, env, fetchImpl);
  return { join: (input) => call("join", input), leave: (input) => call("leave", input) };
}

async function postVoicePresence(
  action: "join" | "leave",
  body: { guildId?: string; actorId?: string },
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<DiscordVoicePresenceResult> {
  const refused = action === "join" ? ("join_refused" as const) : ("leave_refused" as const);
  try {
    const port =
      resolveDiscordActiveBody(env) === "user_session"
        ? env.CLANKIE_USER_SESSION_CONTROL_PORT?.trim() || "4312"
        : env.CLANKIE_DISCORD_BRIDGE_CONTROL_PORT?.trim() || "4313";
    const response = await fetchImpl(`http://127.0.0.1:${port}/voice/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { action: refused, reason: "failed" };
    const parsed = DiscordVoicePresenceResultSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : { action: refused, reason: "failed" };
  } catch {
    return { action: refused, reason: "failed" };
  }
}
