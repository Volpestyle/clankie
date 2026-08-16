import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import type { AudioPlayer } from "@discordjs/voice";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceMusicQueue,
  applyMusicControl,
  createYoutubeAudioSink,
  isAllowedMusicUrl,
  parseMusicControlPath,
  parseYtDlpSearchJson,
  tryHandleMusicControlRequest,
  type VoiceMusicSink,
  type VoiceMusicTraceEvent,
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

const hits = [
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
] as const;

describe("music control (model tools)", () => {
  it("searches, then plays a numbered pick", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({
      sink,
      sinkKind: "audio",
      search: async () => [...hits],
    });
    const offer = await applyMusicControl(queue, "search", { query: "migos", authorId: "u1" });
    expect(offer.ok).toBe(true);
    expect(offer.message).toContain("1. Migos - Bad and Boujee");
    expect(offer.message).toContain("Say a number to play it.");
    await expect(applyMusicControl(queue, "play", { index: 2, authorId: "u1" })).resolves.toMatchObject({
      ok: true,
      message: expect.stringContaining("https://www.youtube.com/watch?v=bbb"),
    });
    expect(sink.calls).toContain("play:https://www.youtube.com/watch?v=bbb");
  });

  it("queues a pick when the search or play tool says next", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({
      sink,
      sinkKind: "audio",
      search: async () => [...hits],
    });
    await applyMusicControl(queue, "play", { url: "https://youtu.be/now", authorId: "u1" });
    await applyMusicControl(queue, "search", { query: "migos", authorId: "u1" });
    const queued = await applyMusicControl(queue, "queue", { index: 1, authorId: "u1" });
    expect(queued.message).toContain("Queued");
    expect(queue.snapshot().queued).toHaveLength(1);
  });

  it("plays a url and refuses a missing pick", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({ sink, sinkKind: "audio" });
    await expect(
      applyMusicControl(queue, "play", { url: "https://www.youtube.com/watch?v=abc", authorId: "u1" }),
    ).resolves.toMatchObject({ ok: true, message: expect.stringContaining("Playing") });
    await expect(applyMusicControl(queue, "play", { index: 1, authorId: "u1" })).resolves.toMatchObject({
      ok: true,
      message: "I don't have a search waiting. Ask me to play something first.",
    });
    await expect(applyMusicControl(queue, "play", { authorId: "u1" })).resolves.toEqual({
      ok: false,
      message: "Need a YouTube URL or a result number.",
    });
  });

  it("parses /music/* control paths", () => {
    expect(parseMusicControlPath("/music/search")).toBe("search");
    expect(parseMusicControlPath("/music/play?x=1")).toBe("play");
    expect(parseMusicControlPath("/music/nope")).toBeUndefined();
    expect(parseMusicControlPath("/go-live/start")).toBeUndefined();
  });

  it("serves search then pick over loopback HTTP", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({
      sink,
      sinkKind: "audio",
      search: async () => [...hits],
    });
    let playbackReady = false;
    const server = createServer((request, response) => {
      if (!tryHandleMusicControlRequest(request, response, queue, playbackReady)) {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected port");
      const base = `http://127.0.0.1:${String(address.port)}`;
      const search = await fetch(`${base}/music/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "bad and boujee", authorId: "u1" }),
      });
      const searchBody = (await search.json()) as { ok: boolean; message: string };
      expect(searchBody.ok).toBe(true);
      expect(searchBody.message).toContain("1. Migos - Bad and Boujee");
      const play = await fetch(`${base}/music/play`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ index: 1, authorId: "u1" }),
      });
      const playBody = (await play.json()) as { ok: boolean; message: string };
      expect(playBody).toEqual({
        ok: false,
        message: "I can't play music until I'm in a voice channel.",
      });
      expect(sink.calls).toHaveLength(0);
      playbackReady = true;
      const retry = await fetch(`${base}/music/play`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ index: 1, authorId: "u1" }),
      });
      expect((await retry.json()) as { ok: boolean }).toMatchObject({ ok: true });
      expect(sink.calls).toContain("play:https://www.youtube.com/watch?v=aaa");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("parses yt-dlp search JSON into hits", () => {
    const parsed = parseYtDlpSearchJson(
      JSON.stringify({
        entries: [
          { id: "aaa", title: "Bad and Boujee", uploader: "Migos", duration_string: "4:23" },
          { id: "", title: "skip me" },
        ],
      }),
    );
    expect(parsed).toEqual([
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
  it("waits for audio and retries one pre-audio pipeline failure", async () => {
    const events: VoiceMusicTraceEvent[] = [];
    const children: ChildProcess[] = [];
    const kill = vi.fn(() => true);
    let attempt = 0;
    const spawnImpl = ((command: string) => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdin: command === "ffmpeg" ? new PassThrough() : null,
        stdout,
        stderr: null,
        kill,
      }) as unknown as ChildProcess;
      children.push(child);
      if (command === "ffmpeg") {
        const currentAttempt = ++attempt;
        queueMicrotask(() => {
          if (currentAttempt === 1) stdout.end();
          else stdout.write(Buffer.alloc(4));
        });
      }
      return child;
    }) as typeof import("node:child_process").spawn;
    const player = Object.assign(new EventEmitter(), {
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
    }) as unknown as AudioPlayer;
    const queue = new VoiceMusicQueue({
      sink: createYoutubeAudioSink({ player, spawnImpl, trace: (event) => events.push(event) }),
      sinkKind: "audio",
      trace: (event) => events.push(event),
    });

    await expect(
      queue.play("https://youtu.be/one", "u1", { source: "control", callId: "call-1" }),
    ).resolves.toContain("Playing");
    expect(children).toHaveLength(4);
    expect(kill).toHaveBeenCalled();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "pipeline", outcome: "failed", code: "pre_audio_retry" }),
        expect.objectContaining({ component: "pipeline", outcome: "first_audio" }),
        expect.objectContaining({ component: "queue", outcome: "started", current: true }),
      ]),
    );
    queue.stop();
  });

  it("does not claim playback when the audio sink rejects", async () => {
    const queue = new VoiceMusicQueue({
      sink: { ...recordingSink(), play: async () => Promise.reject(new Error("no audio")) },
      sinkKind: "audio",
    });
    await expect(queue.play("https://youtu.be/one")).resolves.toBe("I couldn't start that track.");
    expect(queue.snapshot().current).toBeUndefined();
  });

  it("correlates search and playback without logging the query or URL", async () => {
    const events: VoiceMusicTraceEvent[] = [];
    const queue = new VoiceMusicQueue({
      sink: recordingSink(),
      sinkKind: "audio",
      search: async () => [...hits],
      trace: (event) => events.push(event),
    });
    const trace = { source: "realtime", deliveryId: "delivery-1", callId: "call-1" } as const;
    await queue.searchAndOffer("u1", "private query", "play", trace);
    await queue.pick("u1", 1, "play", trace);
    expect(events).toMatchObject([
      { ...trace, operation: "search", component: "queue", outcome: "offered", resultCount: 2 },
      { ...trace, operation: "play", component: "queue", outcome: "started", current: true },
    ]);
    expect(JSON.stringify(events)).not.toContain("private query");
    expect(JSON.stringify(events)).not.toContain("youtu.be");
  });

  it("plays immediately and queues the next track", async () => {
    const sink = recordingSink();
    const queue = new VoiceMusicQueue({ sink, sinkKind: "audio" });
    await expect(queue.play("https://youtu.be/one", "u1")).resolves.toContain("Playing");
    await expect(queue.enqueue("https://youtu.be/two", "u2")).resolves.toContain("Queued");
    expect(queue.snapshot().queued).toHaveLength(1);
    await expect(queue.skip()).resolves.toContain("Playing");
    expect(sink.calls).toEqual(["play:https://youtu.be/one", "stop", "play:https://youtu.be/two"]);
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
