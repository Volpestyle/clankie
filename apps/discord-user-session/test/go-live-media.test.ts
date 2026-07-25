import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { GO_LIVE_INSTALL_HINT, createGoLiveMediaPublisher } from "../src/go-live-media.ts";

/**
 * The optional selfbot stack is GPL-3.0 and deliberately not a dependency of
 * this Apache-2.0 repository, so every test injects a fake module pair. CI
 * therefore exercises the whole publication path without ever importing it.
 */
function fakeModules() {
  const login = vi.fn(async () => undefined);
  const joinVoice = vi.fn(async () => undefined);
  const leaveVoice = vi.fn();
  const kill = vi.fn();
  const playStream = vi.fn(async () => undefined);
  let errorListener: ((error: unknown) => void) | undefined;

  const prepareStream = vi.fn(() => ({
    command: {
      on: (_event: "error", listener: (error: unknown) => void) => {
        errorListener = listener;
      },
      kill,
    },
    output: "encoded-output",
  }));

  return {
    login,
    joinVoice,
    leaveVoice,
    kill,
    playStream,
    prepareStream,
    fireEncoderError: () => errorListener?.(new Error("encoder died")),
    load: async () => ({
      stream: {
        Streamer: class {
          public client = { login };
          public joinVoice = joinVoice;
          public leaveVoice = leaveVoice;
        },
        prepareStream,
        playStream,
        Utils: { normalizeVideoCodec: (codec: string) => codec },
        Encoders: { software: (options: Record<string, unknown>) => options },
      },
      selfbot: { Client: class {} },
    }),
  } as never as {
    login: ReturnType<typeof vi.fn>;
    joinVoice: ReturnType<typeof vi.fn>;
    leaveVoice: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    playStream: ReturnType<typeof vi.fn>;
    prepareStream: ReturnType<typeof vi.fn>;
    fireEncoderError: () => void;
    load: () => Promise<never>;
  };
}

describe("Go Live media publisher", () => {
  it("logs in, joins voice, and publishes a go-live stream", async () => {
    const modules = fakeModules();
    const publisher = createGoLiveMediaPublisher({
      userToken: "user-token",
      loadModules: modules.load,
    });
    expect(publisher.active).toBe(false);

    await publisher.start({
      guildId: "guild-1",
      channelId: "voice-1",
      source: Readable.from(["frame-bytes"]),
    });

    expect(modules.login).toHaveBeenCalledWith("user-token");
    expect(modules.joinVoice).toHaveBeenCalledWith("guild-1", "voice-1");
    expect(modules.playStream).toHaveBeenCalledWith("encoded-output", expect.anything(), {
      type: "go-live",
    });
    expect(publisher.active).toBe(true);
  });

  it("refuses a second concurrent stream and stops cleanly", async () => {
    const modules = fakeModules();
    const publisher = createGoLiveMediaPublisher({
      userToken: "user-token",
      loadModules: modules.load,
    });
    const start = () =>
      publisher.start({
        guildId: "guild-1",
        channelId: "voice-1",
        source: Readable.from(["x"]),
      });

    await start();
    await expect(start()).rejects.toThrow(/already_active/);

    await publisher.stop("guild-1");
    expect(modules.kill).toHaveBeenCalled();
    expect(modules.leaveVoice).toHaveBeenCalled();
    expect(publisher.active).toBe(false);
    // Stopping twice is not an error: the operator's intent is "not live".
    await expect(publisher.stop("guild-1")).resolves.toBeUndefined();
  });

  it("clears active state when the encoder dies so stop is not a no-op", async () => {
    const modules = fakeModules();
    const publisher = createGoLiveMediaPublisher({
      userToken: "user-token",
      loadModules: modules.load,
    });
    await publisher.start({
      guildId: "guild-1",
      channelId: "voice-1",
      source: Readable.from(["x"]),
    });
    expect(publisher.active).toBe(true);

    modules.fireEncoderError();
    // Leaving this set would strand the session as permanently "live".
    expect(publisher.active).toBe(false);
  });

  it("requires a token and reports an actionable install hint when the stack is absent", async () => {
    expect(() => createGoLiveMediaPublisher({ userToken: "   " })).toThrow(/go_live_user_token_required/);

    const publisher = createGoLiveMediaPublisher({
      userToken: "user-token",
      loadModules: () => Promise.reject(new Error("Cannot find module")),
    });
    await expect(
      publisher.start({ guildId: "g", channelId: "c", source: Readable.from(["x"]) }),
    ).rejects.toThrow(/Cannot find module/);

    // The hint names the GPL boundary rather than silently suggesting an install.
    expect(GO_LIVE_INSTALL_HINT).toMatch(/GPL-3\.0/);
    expect(GO_LIVE_INSTALL_HINT).toMatch(/discord\.js-selfbot-v13/);
  });
});
