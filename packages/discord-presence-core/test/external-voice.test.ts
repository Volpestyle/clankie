import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  openExternalVoiceConversation,
  splitSpeakableUnits,
  type ExternalVoiceRealtimeHandlers,
  type ExternalVoiceRealtimePort,
  type ExternalVoiceSessionFactories,
  type ExternalVoiceTtsHandlers,
  type ExternalVoiceTtsPort,
} from "../src/external-voice.ts";
import type { RealtimeResponseMeta, RealtimeTimers } from "../src/realtime-session.ts";
import type { VoiceConversationOpenInput } from "../src/voice-session.ts";

class FakeRealtimePort implements ExternalVoiceRealtimePort {
  public isOpen = true;
  public readonly appended: Buffer[] = [];
  public readonly textItems: string[] = [];
  public responseCreates = 0;
  public readonly functionResults: { callId: string; output: string }[] = [];
  public closed = false;

  public appendAudio(pcm: Buffer): void {
    this.appended.push(Buffer.from(pcm));
  }

  public createTextItem(text: string): void {
    this.textItems.push(text);
  }

  public createImageItem(_pngBase64: string, _mimeType?: "image/png"): void {}

  public createResponse(): void {
    this.responseCreates += 1;
  }

  public submitFunctionResult(callId: string, output: string): void {
    this.functionResults.push({ callId, output });
  }

  public close(): void {
    this.closed = true;
    this.isOpen = false;
  }
}

class FakeTtsPort implements ExternalVoiceTtsPort {
  public isOpen = true;
  public readonly frames: { kind: string; contextId?: string; text?: string }[] = [];
  public closed = false;
  /** Fails one openContext without the socket dying — the state-poisoning shape. */
  public failNextOpenContext = false;

  public openContext(contextId: string): void {
    if (this.failNextOpenContext) {
      this.failNextOpenContext = false;
      throw new Error("ElevenLabs context id is already open");
    }
    this.frames.push({ kind: "open", contextId });
  }

  public appendText(contextId: string, text: string): void {
    this.frames.push({ kind: "append", contextId, text });
  }

  public flush(contextId: string): void {
    this.frames.push({ kind: "flush", contextId });
  }

  public closeContext(contextId: string): void {
    this.frames.push({ kind: "close_context", contextId });
  }

  public close(): void {
    this.closed = true;
    this.isOpen = false;
  }
}

class FakeTimers implements RealtimeTimers {
  public readonly scheduled: { handle: number; delayMs: number; handler: () => void; cleared: boolean }[] =
    [];
  private nextHandle = 1;

  public setTimeout(handler: () => void, delayMs: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.scheduled.push({ handle, delayMs, handler, cleared: false });
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    const entry = this.scheduled.find((candidate) => candidate.handle === handle);
    if (entry !== undefined) entry.cleared = true;
  }

  public fire(): void {
    const entry = this.scheduled.find((candidate) => !candidate.cleared);
    if (entry === undefined) throw new Error("No armed timer to fire");
    entry.cleared = true;
    entry.handler();
  }
}

async function settle(): Promise<void> {
  // Drain the port's internal ops chain: each queued step is several
  // microtasks deep, so yield whole macrotask turns instead of counting them.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function doneMeta(responseId: string): RealtimeResponseMeta {
  return { responseId, status: "completed", audioBytes: 0, textCharacters: 12 };
}

interface Harness {
  realtime: FakeRealtimePort;
  ttsPorts: FakeTtsPort[];
  timers: FakeTimers;
  realtimeHandlers: ExternalVoiceRealtimeHandlers;
  ttsHandlers: ExternalVoiceTtsHandlers[];
  events: {
    audio: { pcm: Buffer; itemId: string }[];
    done: RealtimeResponseMeta[];
    closes: string[];
    errors: string[];
  };
  failNextTtsOpen: { value: boolean };
}

async function openHarness(): Promise<
  Harness & { port: Awaited<ReturnType<typeof openExternalVoiceConversation>> }
> {
  const realtime = new FakeRealtimePort();
  const ttsPorts: FakeTtsPort[] = [];
  const timers = new FakeTimers();
  const ttsHandlers: ExternalVoiceTtsHandlers[] = [];
  const failNextTtsOpen = { value: false };
  let realtimeHandlers: ExternalVoiceRealtimeHandlers | undefined;
  const events: Harness["events"] = { audio: [], done: [], closes: [], errors: [] };
  const input: VoiceConversationOpenInput = {
    instructions: "Be Clankie.",
    onAudioDelta: (pcm, itemId) => events.audio.push({ pcm: Buffer.from(pcm), itemId }),
    onFunctionCall: () => undefined,
    onResponseDone: (meta) => events.done.push(meta),
    onClose: (reason) => events.closes.push(reason),
    onError: (message) => events.errors.push(message),
  };
  const factories: ExternalVoiceSessionFactories = {
    openRealtime: (handlers) => {
      realtimeHandlers = handlers;
      return Promise.resolve(realtime);
    },
    openTts: (handlers) => {
      if (failNextTtsOpen.value) {
        failNextTtsOpen.value = false;
        return Promise.reject(new Error("ElevenLabs session error"));
      }
      const port = new FakeTtsPort();
      ttsPorts.push(port);
      ttsHandlers.push(handlers);
      return Promise.resolve(port);
    },
  };
  const port = await openExternalVoiceConversation(input, factories, { timers });
  if (realtimeHandlers === undefined) throw new Error("realtime handlers were not captured");
  return { port, realtime, ttsPorts, timers, realtimeHandlers, ttsHandlers, events, failNextTtsOpen };
}

describe("external voice conversation", () => {
  it("closes the ears when the mouth cannot open", async () => {
    const realtime = new FakeRealtimePort();
    const factories: ExternalVoiceSessionFactories = {
      openRealtime: () => Promise.resolve(realtime),
      openTts: () => Promise.reject(new Error("ElevenLabs session error")),
    };
    const input: VoiceConversationOpenInput = {
      instructions: "Be Clankie.",
      onAudioDelta: () => undefined,
      onFunctionCall: () => undefined,
      onResponseDone: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    };
    await expect(openExternalVoiceConversation(input, factories)).rejects.toThrow("ElevenLabs session error");
    expect(realtime.closed).toBe(true);
  });

  it("streams text deltas into one context per item, in order", async () => {
    const { realtimeHandlers, ttsPorts } = await openHarness();
    realtimeHandlers.onTextDelta("Sure — ", "item_a");
    realtimeHandlers.onTextDelta("one sec.", "item_a");
    await settle();
    // Held until the boundary lands: `auto_mode` voices each frame as its own
    // unit, so a partial phrase would be spoken as a partial phrase.
    expect(ttsPorts[0]?.frames).toEqual([
      { kind: "open", contextId: "item_a" },
      { kind: "append", contextId: "item_a", text: "Sure — one sec." },
    ]);
  });

  it("never sends a bare token, which is what made every word its own utterance", async () => {
    const { realtimeHandlers, ttsPorts } = await openHarness();
    for (const token of ["I", " walked", " into", " the", " wall", " again", "."]) {
      realtimeHandlers.onTextDelta(token, "item_a");
    }
    await settle();
    const appends = (ttsPorts[0]?.frames ?? []).filter((frame) => frame.kind === "append");
    expect(appends).toEqual([{ kind: "append", contextId: "item_a", text: "I walked into the wall again." }]);
  });

  it("speaks each sentence as it completes, rather than waiting for the whole reply", async () => {
    const { realtimeHandlers, ttsPorts } = await openHarness();
    realtimeHandlers.onTextDelta("Got it. Heading", "item_a");
    await settle();
    realtimeHandlers.onTextDelta(" north now.", "item_a");
    await settle();
    const appends = (ttsPorts[0]?.frames ?? []).filter((frame) => frame.kind === "append");
    expect(appends).toEqual([
      { kind: "append", contextId: "item_a", text: "Got it. " },
      { kind: "append", contextId: "item_a", text: "Heading north now." },
    ]);
  });

  it("flushes a held tail that never got its punctuation", async () => {
    const { realtimeHandlers, ttsPorts, events } = await openHarness();
    realtimeHandlers.onTextDelta("no period here", "item_a");
    await settle();
    expect((ttsPorts[0]?.frames ?? []).filter((frame) => frame.kind === "append")).toEqual([]);

    realtimeHandlers.onResponseDone(doneMeta("resp_1"));
    await settle();
    // The tail is spoken before the flush, or the last words are simply lost.
    expect(ttsPorts[0]?.frames.slice(-2)).toEqual([
      { kind: "append", contextId: "item_a", text: "no period here" },
      { kind: "flush", contextId: "item_a" },
    ]);
    expect(events.errors).toHaveLength(0);
  });

  it("holds response done until the synthesis context drains, then forwards it", async () => {
    const { realtimeHandlers, ttsHandlers, ttsPorts, timers, events } = await openHarness();
    realtimeHandlers.onTextDelta("Hello there.", "item_a");
    await settle();
    realtimeHandlers.onResponseDone(doneMeta("resp_1"));
    await settle();
    expect(ttsPorts[0]?.frames.at(-1)).toEqual({ kind: "flush", contextId: "item_a" });
    expect(events.done).toHaveLength(0);

    const pcm = Buffer.from([1, 0, 2, 0]);
    ttsHandlers[0]?.onAudio(pcm, "item_a");
    expect(events.audio).toEqual([{ pcm: Buffer.from([1, 0, 2, 0]), itemId: "item_a" }]);

    ttsHandlers[0]?.onContextDone("item_a");
    expect(events.done).toEqual([doneMeta("resp_1")]);
    expect(timers.scheduled[0]?.cleared).toBe(true);
    expect(events.errors).toHaveLength(0);
  });

  it("forwards a no-speech response done immediately", async () => {
    const { realtimeHandlers, events } = await openHarness();
    realtimeHandlers.onResponseDone(doneMeta("resp_tool"));
    expect(events.done).toEqual([doneMeta("resp_tool")]);
  });

  it("forces the done through when synthesis does not drain in time", async () => {
    const { realtimeHandlers, timers, events } = await openHarness();
    realtimeHandlers.onTextDelta("Hello there.", "item_a");
    await settle();
    realtimeHandlers.onResponseDone(doneMeta("resp_1"));
    expect(events.done).toHaveLength(0);

    timers.fire();
    expect(events.errors).toEqual(["External voice synthesis did not drain in time"]);
    expect(events.done).toEqual([doneMeta("resp_1")]);
  });

  it("abandons the wedged context, so a drain timeout costs one utterance and not the call", async () => {
    const { realtimeHandlers, timers, ttsPorts, events } = await openHarness();
    const first = ttsPorts[0];
    if (first === undefined) throw new Error("no mouth");
    realtimeHandlers.onTextDelta("Hello there.", "item_a");
    await settle();
    realtimeHandlers.onResponseDone(doneMeta("resp_1"));
    timers.fire();
    await settle();

    // Left live, the timed-out item kept its ElevenLabs context slot and
    // pinned the mouth in place: four of these and every later utterance hit
    // the open-context limit while the model went on writing replies.
    expect(first.closed).toBe(true);
    realtimeHandlers.onTextDelta("Second answer.", "item_b");
    await settle();
    expect(ttsPorts).toHaveLength(2);
    expect(ttsPorts[1]?.frames).toEqual([
      { kind: "open", contextId: "item_b" },
      { kind: "append", contextId: "item_b", text: "Second answer." },
    ]);
    expect(events.errors).toEqual(["External voice synthesis did not drain in time"]);
  });

  it("turns barge-in into context close, a marker item, and dropped late output", async () => {
    const { port, realtimeHandlers, ttsHandlers, ttsPorts, realtime, events } = await openHarness();
    // A complete phrase, so it reaches the mouth and the late-delta assertion
    // below is measuring the drop rather than the boundary buffer.
    realtimeHandlers.onTextDelta("A very long answer. ", "item_a");
    await settle();

    port.truncate("item_a", 420);
    await settle();
    expect(ttsPorts[0]?.frames.at(-1)).toEqual({ kind: "close_context", contextId: "item_a" });
    expect(realtime.textItems.at(-1)).toContain("interrupted about 420ms");

    // Late deltas and late audio for the truncated item never reach anything.
    realtimeHandlers.onTextDelta("tail that nobody hears", "item_a");
    await settle();
    expect(ttsPorts[0]?.frames.filter((frame) => frame.kind === "append")).toHaveLength(1);
    const late = Buffer.from([7, 0]);
    ttsHandlers[0]?.onAudio(late, "item_a");
    expect(events.audio).toHaveLength(0);
    expect(late.equals(Buffer.alloc(2))).toBe(true);

    // The response done for a truncated item is not held.
    realtimeHandlers.onResponseDone(doneMeta("resp_1"));
    expect(events.done).toEqual([doneMeta("resp_1")]);
  });

  it("releases held dones when the mouth dies and reopens it for the next utterance", async () => {
    const { realtimeHandlers, ttsHandlers, ttsPorts, realtime, events, failNextTtsOpen } =
      await openHarness();
    realtimeHandlers.onTextDelta("Hello there.", "item_a");
    await settle();
    realtimeHandlers.onResponseDone(doneMeta("resp_1"));
    expect(events.done).toHaveLength(0);

    ttsPorts[0]?.close();
    ttsHandlers[0]?.onClose();
    expect(events.done).toEqual([doneMeta("resp_1")]);
    expect(realtime.textItems).toEqual([
      "(Your external voice failed before completing your reply; the room may have heard only a prefix, and the exact cutoff is unknown.)",
    ]);

    // Next utterance opens a fresh TTS session and speaks normally.
    realtimeHandlers.onTextDelta("Still here.", "item_b");
    await settle();
    expect(ttsPorts).toHaveLength(2);
    expect(ttsPorts[1]?.frames).toEqual([
      { kind: "open", contextId: "item_b" },
      { kind: "append", contextId: "item_b", text: "Still here." },
    ]);
    expect(failNextTtsOpen.value).toBe(false);
  });

  it("reports a reopen failure and still settles the turn", async () => {
    const { realtimeHandlers, ttsHandlers, ttsPorts, events, failNextTtsOpen } = await openHarness();
    ttsPorts[0]?.close();
    ttsHandlers[0]?.onClose();
    failNextTtsOpen.value = true;

    realtimeHandlers.onTextDelta("Hello?", "item_a");
    await settle();
    expect(events.errors).toEqual(["ElevenLabs session error"]);

    realtimeHandlers.onResponseDone(doneMeta("resp_1"));
    await settle();
    // The failed open dropped the utterance, so its done event is forwarded
    // immediately instead of waiting out the drain timer.
    expect(events.done).toEqual([doneMeta("resp_1")]);
  });

  it("does not reuse a mouth that just failed a step, so one bad frame is not a mute call", async () => {
    const { realtimeHandlers, ttsPorts, events } = await openHarness();
    // The session still reports itself open, so nothing else would reopen it:
    // before this, every later utterance reused it and he stayed silent for
    // the rest of the call while the model kept writing replies.
    const first = ttsPorts[0];
    if (first === undefined) throw new Error("no mouth");
    first.failNextOpenContext = true;

    realtimeHandlers.onTextDelta("First answer.", "item_a");
    await settle();
    expect(events.errors).toEqual(["ElevenLabs context id is already open"]);
    // The dropped utterance settles rather than waiting out the drain timer.
    realtimeHandlers.onResponseDone(doneMeta("resp_1"));
    await settle();
    expect(events.done).toEqual([doneMeta("resp_1")]);

    realtimeHandlers.onTextDelta("Second answer.", "item_b");
    await settle();
    expect(ttsPorts).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(ttsPorts[1]?.frames).toEqual([
      { kind: "open", contextId: "item_b" },
      { kind: "append", contextId: "item_b", text: "Second answer." },
    ]);
  });

  it("delegates the realtime-only surface and closes both sessions", async () => {
    const { port, realtime, ttsPorts, realtimeHandlers, events } = await openHarness();
    port.createTextItem("Speaker: james");
    port.createResponse();
    port.submitFunctionResult("call_1", "done");
    port.appendAudio(Buffer.from([1, 0]));
    expect(realtime.textItems).toEqual(["Speaker: james"]);
    expect(realtime.responseCreates).toBe(1);
    expect(realtime.functionResults).toEqual([{ callId: "call_1", output: "done" }]);
    expect(realtime.appended).toHaveLength(1);

    port.close();
    expect(realtime.closed).toBe(true);
    expect(ttsPorts[0]?.closed).toBe(true);
    expect(port.isOpen).toBe(false);

    // A close arriving from the realtime side after local close still reaches
    // the media owner exactly once.
    realtimeHandlers.onClose("socket");
    expect(events.closes).toEqual(["socket"]);
  });
});

describe("splitSpeakableUnits", () => {
  it("holds a partial phrase and releases it once a boundary lands", () => {
    expect(splitSpeakableUnits("Heading north")).toEqual({ emit: "", rest: "Heading north" });
    expect(splitSpeakableUnits("Heading north. Then")).toEqual({
      emit: "Heading north. ",
      rest: "Then",
    });
  });

  it("treats a boundary at the very end as complete, since no more text has arrived", () => {
    expect(splitSpeakableUnits("Done.")).toEqual({ emit: "Done.", rest: "" });
  });

  it("does not split a decimal or an abbreviation mid-word", () => {
    expect(splitSpeakableUnits("Route 1.5 is")).toEqual({ emit: "", rest: "Route 1.5 is" });
  });

  it("breaks a long unpunctuated run at a word break rather than holding the mouth shut", () => {
    const run = `${"word ".repeat(60)}tail`;
    const { emit, rest } = splitSpeakableUnits(run);
    expect(emit.length).toBeGreaterThan(0);
    expect(emit.endsWith(" ")).toBe(true);
    expect(rest).toBe("tail");
    expect(emit + rest).toBe(run);
  });

  it("splits on clause enders too, so a long sentence still starts speaking", () => {
    expect(splitSpeakableUnits("Two things: first")).toEqual({
      emit: "Two things: ",
      rest: "first",
    });
  });
});
