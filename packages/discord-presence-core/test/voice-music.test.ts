import { createServer } from "node:http";
import {
  VoxClientError,
  type VoxClient,
  type VoxControlEvent,
  type VoxProcessStatus,
} from "@clankie/vox-client";
import { describe, expect, it, vi } from "vitest";
import {
  VoiceMusicQueue,
  applyMusicControl,
  createVoxMusicSink,
  isAllowedMusicUrl,
  parseMusicControlPath,
  parseYtDlpSearchJson,
  tryHandleMusicControlRequest,
  type VoiceMusicSink,
  type VoiceMusicTraceEvent,
} from "../src/voice-music.ts";

function fakeVox() {
  const listeners = new Set<(event: VoxControlEvent) => void>();
  const statusListeners = new Set<(status: VoxProcessStatus, detail: string) => void>();
  const errors: Partial<Record<"play" | "stop" | "pause" | "resume" | "gain", Error>> = {};
  const musicPlay = vi.fn((_input: { musicId: string; url: string }) => {
    if (errors.play !== undefined) throw errors.play;
  });
  const musicStop = vi.fn((_musicId: string) => {
    if (errors.stop !== undefined) throw errors.stop;
  });
  const musicPause = vi.fn((_musicId: string) => {
    if (errors.pause !== undefined) throw errors.pause;
  });
  const musicResume = vi.fn((_musicId: string) => {
    if (errors.resume !== undefined) throw errors.resume;
  });
  const musicSetGain = vi.fn((_musicId: string, _target: number, _fadeMs?: number) => {
    if (errors.gain !== undefined) throw errors.gain;
  });
  const vox = {
    available: true,
    status: "ready" as VoxProcessStatus,
    detail: "fake Vox",
    musicPlay,
    musicStop,
    musicPause,
    musicResume,
    musicSetGain,
    onEvent(listener: (event: VoxControlEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatus(listener: (status: VoxProcessStatus, detail: string) => void) {
      statusListeners.add(listener);
      listener("ready", "fake Vox");
      return () => statusListeners.delete(listener);
    },
  } as unknown as VoxClient;
  return {
    vox,
    musicPlay,
    musicStop,
    musicPause,
    musicResume,
    musicSetGain,
    errors,
    emit: (event: VoxControlEvent): void => {
      for (const listener of listeners) listener(event);
    },
    setStatus: (status: VoxProcessStatus): void => {
      for (const listener of statusListeners) listener(status, "fake Vox");
    },
  };
}

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

  it("clears pending search picks when music is stopped", async () => {
    const queue = new VoiceMusicQueue({
      sink: recordingSink(),
      sinkKind: "audio",
      search: async () => [...hits],
    });
    await queue.searchAndOffer("u1", "migos", "play");
    queue.stop();
    await expect(queue.pick("u1", 1)).resolves.toBe(
      "I don't have a search waiting. Ask me to play something first.",
    );
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
  it("starts only on matching Vox playback, advances on matching idle, and ducks with gain", async () => {
    const events: VoiceMusicTraceEvent[] = [];
    const fake = fakeVox();
    let queue: VoiceMusicQueue;
    const sink = createVoxMusicSink({
      vox: fake.vox,
      trace: (event) => events.push(event),
      onEnded: () => {
        void queue.ended();
      },
    });
    queue = new VoiceMusicQueue({
      sink,
      sinkKind: "audio",
      trace: (event) => events.push(event),
    });

    let settled = false;
    const first = queue.play("https://youtu.be/one", "u1", { source: "control", callId: "call-1" });
    void first.then(() => {
      settled = true;
    });
    const firstId = fake.musicPlay.mock.calls[0]?.[0].musicId as string;
    expect(queue.snapshot().starting).toBe(true);
    fake.emit({ type: "player_state", status: "playing", musicId: "some-other-track" });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(queue.snapshot().starting).toBe(true);
    fake.emit({ type: "player_state", status: "playing", musicId: firstId });
    await expect(first).resolves.toContain("Playing");
    expect(queue.snapshot().starting).toBe(false);
    await queue.enqueue("https://youtu.be/two", "u2");
    queue.duck();
    queue.unduck();
    expect(fake.musicSetGain).toHaveBeenNthCalledWith(1, firstId, 0.2, 150);
    expect(fake.musicSetGain).toHaveBeenNthCalledWith(2, firstId, 1, 150);

    fake.emit({ type: "music_idle", musicId: "some-other-track" });
    expect(fake.musicPlay).toHaveBeenCalledTimes(1);
    fake.emit({ type: "music_idle", musicId: firstId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.musicPlay).toHaveBeenCalledTimes(2);
    const secondId = fake.musicPlay.mock.calls[1]?.[0].musicId as string;
    fake.emit({ type: "player_state", status: "playing", musicId: secondId });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(queue.snapshot().current?.url).toBe("https://youtu.be/two");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ outcome: "playing" })]));
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

  it("rejects only the matching native Vox music error", async () => {
    const fake = fakeVox();
    const events: VoiceMusicTraceEvent[] = [];
    const queue = new VoiceMusicQueue({
      sink: createVoxMusicSink({ vox: fake.vox, trace: (event) => events.push(event) }),
      sinkKind: "audio",
      trace: (event) => events.push(event),
    });
    const playing = queue.play("https://youtu.be/one", undefined, {
      source: "control",
      callId: "music-error",
    });
    const musicId = fake.musicPlay.mock.calls[0]?.[0].musicId as string;
    fake.emit({
      type: "music_error",
      musicId: "stale-track",
      code: "pipeline_failed",
      message: "ignore me",
    });
    fake.emit({
      type: "music_error",
      musicId,
      code: "format_unavailable",
      message: "private native detail",
    });
    await expect(playing).resolves.toBe("I couldn't start that track.");
    expect(queue.snapshot().current).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ outcome: "failed", code: "format_unavailable" }));
    expect(JSON.stringify(events)).not.toContain("private native detail");
  });

  it("does not let an older rejected play clear or stop a newer concurrent track", async () => {
    const fake = fakeVox();
    const queue = new VoiceMusicQueue({
      sink: createVoxMusicSink({ vox: fake.vox }),
      sinkKind: "audio",
    });
    const first = queue.play("https://youtu.be/one");
    const firstId = fake.musicPlay.mock.calls[0]?.[0].musicId as string;
    const second = queue.play("https://youtu.be/two");
    const secondId = fake.musicPlay.mock.calls[1]?.[0].musicId as string;
    expect(secondId).not.toBe(firstId);
    await expect(first).resolves.toBe("I couldn't start that track.");
    fake.emit({ type: "music_idle", musicId: firstId });
    fake.emit({
      type: "music_error",
      musicId: firstId,
      code: "pipeline_failed",
      message: "stale failure",
    });
    expect(queue.snapshot().current?.url).toBe("https://youtu.be/two");

    fake.emit({ type: "player_state", status: "playing", musicId: secondId });
    await expect(second).resolves.toContain("Playing");
    expect(queue.snapshot().current?.url).toBe("https://youtu.be/two");
    expect(fake.musicStop).toHaveBeenCalledWith(firstId);
    expect(fake.musicStop).not.toHaveBeenCalledWith(secondId);
  });

  it("classifies a synchronous Vox play rejection without retaining the failed track", async () => {
    const fake = fakeVox();
    const events: VoiceMusicTraceEvent[] = [];
    fake.errors.play = new VoxClientError("stdin_queue_overflow", "Vox command queue is full");
    const queue = new VoiceMusicQueue({
      sink: createVoxMusicSink({ vox: fake.vox, trace: (event) => events.push(event) }),
      sinkKind: "audio",
      trace: (event) => events.push(event),
    });

    const rejected = queue.play("https://youtu.be/one", undefined, {
      source: "control",
      callId: "play-rejected",
    });
    await queue.enqueue("https://youtu.be/queued");
    await expect(rejected).resolves.toBe("I couldn't start that track.");
    expect(queue.snapshot()).toMatchObject({ current: undefined, queued: [] });
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "failed", code: "stdin_queue_overflow" })]),
    );
  });

  it("contains terminal Vox control throws while preserving queue identity", async () => {
    const fake = fakeVox();
    const events: VoiceMusicTraceEvent[] = [];
    const trace = { source: "control", callId: "terminal-controls" } as const;
    const queue = new VoiceMusicQueue({
      sink: createVoxMusicSink({ vox: fake.vox }),
      sinkKind: "audio",
      trace: (event) => events.push(event),
    });
    const playing = queue.play("https://youtu.be/one", "u1", trace);
    const firstId = fake.musicPlay.mock.calls[0]?.[0].musicId as string;
    fake.emit({ type: "player_state", status: "playing", musicId: firstId });
    await playing;
    await queue.enqueue("https://youtu.be/two", "u2");

    fake.errors.pause = new VoxClientError("not_ready", "Vox unavailable");
    expect(queue.pause(trace)).toBe("I couldn't pause that just now.");
    expect(queue.snapshot()).toMatchObject({ current: { url: "https://youtu.be/one" }, paused: false });
    delete fake.errors.pause;
    expect(queue.pause(trace)).toBe("Paused.");

    fake.errors.resume = new VoxClientError("closed", "Vox closed");
    expect(queue.resume(trace)).toBe("I couldn't resume that just now.");
    expect(queue.snapshot().paused).toBe(true);
    delete fake.errors.resume;
    expect(queue.resume(trace)).toBe("Resumed.");

    fake.errors.gain = new VoxClientError("not_ready", "Vox unavailable");
    expect(() => queue.duck()).not.toThrow();
    expect(() => queue.unduck()).not.toThrow();
    expect(queue.snapshot().current?.url).toBe("https://youtu.be/one");
    delete fake.errors.gain;

    fake.errors.stop = new VoxClientError("stdin_write_failed", "Vox stdin closed");
    expect(queue.stop(trace)).toBe("Stopped.");
    expect(queue.snapshot()).toEqual({
      current: undefined,
      queued: [],
      paused: false,
      starting: false,
      sink: "audio",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "pause", outcome: "failed", code: "not_ready" }),
        expect.objectContaining({ operation: "resume", outcome: "failed", code: "closed" }),
        expect.objectContaining({ operation: "stop", outcome: "failed", code: "stdin_write_failed" }),
      ]),
    );
    expect(() => queue.dispose()).not.toThrow();
  });

  it("advances to the queued identity even when terminal Vox stop throws during skip", async () => {
    const fake = fakeVox();
    const queue = new VoiceMusicQueue({
      sink: createVoxMusicSink({ vox: fake.vox }),
      sinkKind: "audio",
    });
    const first = queue.play("https://youtu.be/one");
    fake.emit({
      type: "player_state",
      status: "playing",
      musicId: fake.musicPlay.mock.calls[0]?.[0].musicId as string,
    });
    await first;
    await queue.enqueue("https://youtu.be/two");
    fake.errors.stop = new VoxClientError("closed", "Vox closed during stop");
    const skipping = queue.skip();
    delete fake.errors.stop;
    const secondId = fake.musicPlay.mock.calls[1]?.[0].musicId as string;
    fake.emit({ type: "player_state", status: "playing", musicId: secondId });
    await expect(skipping).resolves.toContain("Playing");
    expect(queue.snapshot()).toMatchObject({ current: { url: "https://youtu.be/two" }, queued: [] });
  });

  it("contains terminal status cleanup after native music has started", async () => {
    const fake = fakeVox();
    const queue = new VoiceMusicQueue({
      sink: createVoxMusicSink({ vox: fake.vox, onEnded: () => void queue.ended() }),
      sinkKind: "audio",
    });
    const playing = queue.play("https://youtu.be/one");
    fake.emit({
      type: "player_state",
      status: "playing",
      musicId: fake.musicPlay.mock.calls[0]?.[0].musicId as string,
    });
    await playing;
    fake.errors.stop = new VoxClientError("closed", "Vox is closed");
    expect(() => fake.setStatus("error")).not.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
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
