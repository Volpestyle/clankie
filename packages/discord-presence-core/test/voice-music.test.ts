import { describe, expect, it } from "vitest";
import {
  VoiceMusicQueue,
  isAllowedMusicUrl,
  parseMusicIntent,
  parseVoiceMusicCommand,
  parseYtDlpSearchJson,
  type VoiceMusicSink,
} from "../src/voice-music.ts";

function recordingSink(): VoiceMusicSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    play(url) {
      calls.push(`play:${url}`);
    },
    pause() {
      calls.push("pause");
    },
    resume() {
      calls.push("resume");
    },
    stop() {
      calls.push("stop");
    },
  };
}

describe("voice music commands", () => {
  it("parses natural-language play-next as a search, then a numbered pick", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({
      sink,
      sinkKind: "audio",
      search: async () => [
        {
          videoId: "aaa",
          url: "https://www.youtube.com/watch?v=aaa",
          title: "Migos - Bad and Boujee",
          channel: "Migos",
        },
        {
          videoId: "bbb",
          url: "https://www.youtube.com/watch?v=bbb",
          title: "Migos - MotorSport",
        },
      ],
    });
    const offer = await queue.handleUtterance("clankie play migos next", "u1", ["clankie"]);
    expect(offer).toContain("1. Migos - Bad and Boujee");
    expect(offer).toContain("Say a number to queue it.");
    await expect(queue.handleUtterance("the second one", "u1", ["clankie"])).resolves.toContain(
      "https://www.youtube.com/watch?v=bbb",
    );
    expect(sink.calls).toContain("play:https://www.youtube.com/watch?v=bbb");
  });

  it("parses play, queue, transport verbs, and a bare YouTube URL", () => {
    expect(parseVoiceMusicCommand("play https://www.youtube.com/watch?v=abc")).toEqual({
      kind: "play",
      url: "https://www.youtube.com/watch?v=abc",
    });
    expect(parseVoiceMusicCommand("clankie skip", { names: ["clankie"] })).toEqual({ kind: "skip" });
    expect(parseVoiceMusicCommand("!pause")).toEqual({ kind: "pause" });
    expect(parseVoiceMusicCommand("https://youtu.be/xyz")).toEqual({
      kind: "play",
      url: "https://youtu.be/xyz",
    });
    expect(parseVoiceMusicCommand("https://youtu.be/xyz", { hasCurrent: true })).toEqual({
      kind: "queue",
      url: "https://youtu.be/xyz",
    });
    expect(parseVoiceMusicCommand("play https://example.com/x")).toBeUndefined();
    expect(parseMusicIntent("clankie play migos next", { names: ["clankie"] })).toEqual({
      kind: "queue_search",
      query: "migos",
    });
    expect(parseMusicIntent("can u come and play bad and boujee")).toEqual({
      kind: "play_search",
      query: "bad and boujee",
    });
    expect(parseMusicIntent("play pokemon")).toBeUndefined();
    expect(parseMusicIntent("the second one")).toEqual({ kind: "pick", index: 2 });
    expect(parseMusicIntent("the song")).toEqual({ kind: "song_clarify" });
    expect(parseMusicIntent("i mean the song")).toEqual({ kind: "song_clarify" });
  });

  it("treats 'the song' as confirming a previous play request", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({
      sink,
      sinkKind: "audio",
      search: async () => [
        { videoId: "x", url: "https://www.youtube.com/watch?v=x", title: "Bad and Boujee" },
      ],
    });
    await queue.handleUtterance("can u come and play bad and boujee", "u1", ["clankie"]);
    await expect(queue.handleUtterance("the song", "u1", ["clankie"])).resolves.toContain(
      "https://www.youtube.com/watch?v=x",
    );
    expect(sink.calls).toContain("play:https://www.youtube.com/watch?v=x");
  });

  it("treats a directed play request as a search even without a leading name", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({
      sink,
      sinkKind: "audio",
      search: async (query) => [
        { videoId: "x", url: "https://www.youtube.com/watch?v=x", title: query },
      ],
    });
    const offer = await queue.handleUtterance("can u come and play bad and boujee", "u1", ["clankie"]);
    expect(offer).toContain("1. bad and boujee");
    expect(offer).toContain("Say a number to play it.");
  });

  it("parses yt-dlp search JSON into hits", () => {
    const hits = parseYtDlpSearchJson(
      JSON.stringify({
        entries: [
          { id: "aaa", title: "Bad and Boujee", uploader: "Migos", duration_string: "4:23" },
          { id: "", title: "skip me" },
        ],
      }),
    );
    expect(hits).toEqual([
      {
        videoId: "aaa",
        url: "https://www.youtube.com/watch?v=aaa",
        title: "Bad and Boujee",
        channel: "Migos",
        duration: "4:23",
      },
    ]);
  });

  it("only allows YouTube hosts", () => {
    expect(isAllowedMusicUrl("https://youtu.be/a")).toBe(true);
    expect(isAllowedMusicUrl("https://example.com/a")).toBe(false);
    expect(isAllowedMusicUrl("not-a-url")).toBe(false);
  });
});

describe("voice music queue", () => {
  it("plays immediately and queues the next track", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({ sink, sinkKind: "audio" });
    await expect(queue.play("https://youtu.be/one", "u1")).resolves.toContain("Playing");
    await expect(queue.enqueue("https://youtu.be/two", "u2")).resolves.toContain("Queued");
    expect(queue.snapshot().queued).toHaveLength(1);
    await expect(queue.skip()).resolves.toContain("Playing");
    expect(sink.calls).toEqual([
      "play:https://youtu.be/one",
      "stop",
      "play:https://youtu.be/two",
    ]);
  });

  it("ducks and unducks without clearing the queue", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({ sink, sinkKind: "video" });
    await queue.play("https://youtu.be/one");
    queue.duck();
    queue.unduck();
    expect(sink.calls).toEqual(["play:https://youtu.be/one", "pause", "resume"]);
    expect(queue.snapshot().current?.url).toBe("https://youtu.be/one");
  });

  it("does not unduck after an explicit pause", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({ sink, sinkKind: "audio" });
    await queue.play("https://youtu.be/one");
    expect(queue.pause()).toBe("Paused.");
    queue.unduck();
    expect(sink.calls.filter((call) => call === "resume")).toHaveLength(0);
  });
});
