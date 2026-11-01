import { postToDiscordActiveBody } from "./discord-active-body.ts";
import type { DiscordMusicCallResult, DiscordMusicPort } from "./ports/discord.ts";

/**
 * Captain client for the active Discord body's DJ desk.
 *
 * Search and play live on the body that owns the voice/Go Live sink. This
 * process never talks to YouTube itself.
 */

export function createDiscordMusicClient(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): DiscordMusicPort {
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
  try {
    const response = await postToDiscordActiveBody(`/music/${action}`, body, env, fetchImpl);
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
