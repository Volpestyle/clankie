import type { Readable } from "node:stream";

/**
 * Go Live media publication for the personal-lab user-session plane
 * (ADR 0024 VUH-841, on the ADR 0048 transport).
 *
 * ## Why the library is loaded dynamically
 *
 * Publishing video to Discord requires a **selfbot** transport: Discord blocks
 * video from bot accounts, so every implementation depends on
 * `discord.js-selfbot-v13`, which is **GPL-3.0**. This repository is
 * Apache-2.0, and [ADR 0045](../../../docs/adr/0045-official-bot-dave-group-voice.md)
 * already refused an AGPL import on exactly that basis.
 *
 * The dependency is therefore never declared in this workspace. It is imported
 * at runtime, only after an operator deliberately installs it, so the
 * Apache-2.0 dependency graph and CI stay free of copyleft transport and the
 * capability stays as opt-in as ADR 0024 requires it to be.
 *
 * Automating a normal Discord account violates Discord's terms and can get the
 * account terminated. That risk is the operator's to accept, which is why this
 * path is lab-profile-only and denied by the high-assurance and team profiles.
 */

export interface GoLiveStartInput {
  guildId: string;
  channelId: string;
  /** Encoded media the publisher hands to the encoder. */
  source: Readable;
}

export interface GoLiveMediaPublisher {
  start(input: GoLiveStartInput): Promise<void>;
  stop(guildId: string): Promise<void>;
  readonly active: boolean;
}

/** Install hint surfaced verbatim when the optional stack is absent. */
export const GO_LIVE_INSTALL_HINT =
  "Go Live media requires the optional selfbot stack. Install it deliberately: " +
  "pnpm --filter @clankie/discord-user-session add @dank074/discord-video-stream discord.js-selfbot-v13 " +
  "and allow builds for node-av and node-datachannel in pnpm-workspace.yaml. " +
  "discord.js-selfbot-v13 is GPL-3.0 and is intentionally not a declared dependency of this Apache-2.0 repository.";

/** Minimal shape of the optional library, so this module needs no GPL types. */
interface StreamerLike {
  client: { login(token: string): Promise<unknown> };
  joinVoice(guildId: string, channelId: string): Promise<unknown>;
  leaveVoice?: () => void;
}

interface VideoStreamModule {
  Streamer: new (client: unknown) => StreamerLike;
  prepareStream: (
    input: Readable | string,
    options: Record<string, unknown>,
  ) => {
    command: { on(event: "error", listener: (error: unknown) => void): void; kill?: () => void };
    output: unknown;
  };
  playStream: (output: unknown, streamer: StreamerLike, options: { type: string }) => Promise<void>;
  Utils: { normalizeVideoCodec(codec: string): unknown };
  Encoders: { software(options: Record<string, unknown>): unknown };
}

interface SelfbotModule {
  Client: new () => unknown;
}

export interface RealGoLiveMediaPublisherOptions {
  /** Resolved from the credential broker. Never read from the environment. */
  userToken: string;
  height?: number;
  frameRate?: number;
  bitrateVideo?: number;
  bitrateVideoMax?: number;
  /** Injected in tests so no GPL module is ever imported by CI. */
  loadModules?: () => Promise<{ stream: VideoStreamModule; selfbot: SelfbotModule }>;
}

export function createGoLiveMediaPublisher(options: RealGoLiveMediaPublisherOptions): GoLiveMediaPublisher {
  if (options.userToken.trim().length === 0) {
    throw new Error("discord_go_live_user_token_required");
  }
  const load = options.loadModules ?? loadOptionalModules;
  let streamer: StreamerLike | null = null;
  let running: { command: { kill?: () => void } } | null = null;

  return {
    get active() {
      return running !== null;
    },
    async start(input) {
      if (running !== null) throw new Error("discord_go_live_already_active");
      const { stream, selfbot } = await load();

      if (streamer === null) {
        streamer = new stream.Streamer(new selfbot.Client());
        await streamer.client.login(options.userToken);
      }
      await streamer.joinVoice(input.guildId, input.channelId);

      const { command, output } = stream.prepareStream(input.source, {
        encoder: stream.Encoders.software({
          x264: { preset: "superfast" },
          x265: { preset: "superfast" },
        }),
        height: options.height ?? 480,
        frameRate: options.frameRate ?? 30,
        bitrateVideo: options.bitrateVideo ?? 2_500,
        bitrateVideoMax: options.bitrateVideoMax ?? 4_000,
        videoCodec: stream.Utils.normalizeVideoCodec("H264"),
      });
      running = { command };
      command.on("error", () => {
        // An encoder failure ends the stream; leaving `running` set would make
        // stop() a no-op and strand the session as permanently "live".
        running = null;
      });

      await stream.playStream(output, streamer, { type: "go-live" });
    },
    async stop(_guildId) {
      const current = running;
      running = null;
      current?.command.kill?.();
      streamer?.leaveVoice?.();
      await Promise.resolve();
    },
  };
}

async function loadOptionalModules(): Promise<{ stream: VideoStreamModule; selfbot: SelfbotModule }> {
  try {
    // Indirected through variables so bundlers and the workspace dependency
    // checker do not treat these as static dependencies of this package.
    const streamSpecifier = "@dank074/discord-video-stream";
    const selfbotSpecifier = "discord.js-selfbot-v13";
    const [stream, selfbot] = await Promise.all([
      import(/* @vite-ignore */ streamSpecifier) as Promise<VideoStreamModule>,
      import(/* @vite-ignore */ selfbotSpecifier) as Promise<SelfbotModule>,
    ]);
    return { stream, selfbot };
  } catch {
    throw new Error(`discord_presence_go_live_media_unavailable: ${GO_LIVE_INSTALL_HINT}`);
  }
}
