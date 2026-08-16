import { resolveDiscordActiveBody } from "@clankie/settings";

/**
 * Captain client for the active Discord body's DJ desk.
 *
 * Search and play live on the body that owns the voice/Go Live sink. This
 * process never talks to YouTube itself.
 */

export interface DiscordMusicCallResult {
  readonly ok: boolean;
  readonly message: string;
}

export function createDiscordMusicClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): {
  search(input: { query: string; next?: boolean; authorId: string }): Promise<DiscordMusicCallResult>;
  play(input: { url?: string; index?: number; authorId: string }): Promise<DiscordMusicCallResult>;
  queue(input: { url?: string; index?: number; authorId: string }): Promise<DiscordMusicCallResult>;
  skip(): Promise<DiscordMusicCallResult>;
  pause(): Promise<DiscordMusicCallResult>;
  resume(): Promise<DiscordMusicCallResult>;
  stop(): Promise<DiscordMusicCallResult>;
  now(): Promise<DiscordMusicCallResult>;
} {
  const call = (action: string, body: Record<string, unknown> = {}): Promise<DiscordMusicCallResult> =>
    postMusic(action, body, env, fetchImpl);
  return {
    search: (input) => call("search", input),
    play: (input) => call("play", input),
    queue: (input) => call("queue", input),
    skip: () => call("skip"),
    pause: () => call("pause"),
    resume: () => call("resume"),
    stop: () => call("stop"),
    now: () => call("now"),
  };
}

async function postMusic(
  action: string,
  body: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<DiscordMusicCallResult> {
  const port =
    resolveDiscordActiveBody(env) === "user_session"
      ? env.CLANKIE_USER_SESSION_CONTROL_PORT?.trim() || "4312"
      : env.CLANKIE_DISCORD_BRIDGE_CONTROL_PORT?.trim() || "4313";
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/music/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const parsed = (await response.json()) as { ok?: boolean; message?: string };
    if (typeof parsed.message === "string") {
      return { ok: parsed.ok === true, message: parsed.message };
    }
    return { ok: false, message: "The live Discord body did not accept that music request." };
  } catch {
    return {
      ok: false,
      message: "I can't reach the live Discord body to play music. Get me in a voice channel and try again.",
    };
  }
}
