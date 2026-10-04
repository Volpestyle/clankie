import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  openExternalVoiceConversation,
  splitSpeakableUnits,
  type ExternalVoiceConversationOptions,
  type ExternalVoiceRealtimeHandlers,
  type ExternalVoiceRealtimePort,
  type ExternalVoiceSessionFactories,
  type ExternalVoiceTtsHandlers,
  type ExternalVoiceTtsPort,
} from "../src/external-voice.ts";
import {
  MAX_REALTIME_RESPONSE_AUDIO_BYTES,
  type RealtimeResponseMeta,
  type RealtimeTimers,
  type RealtimeSocket,
} from "../src/realtime-session.ts";
import { createVoiceRealtimePorts, parseVoiceRealtimeEnv } from "../src/voice-composition.ts";
import type { VoiceConversationOpenInput } from "../src/voice-session.ts";

class FakeRealtimePort implements ExternalVoiceRealtimePort {
  public isOpen = true;
  public readonly appended: Buffer[] = [];
  public readonly textItems: string[] = [];
  public responseCreates = 0;
  public onCreateResponse: (() => void) | undefined;
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
    this.onCreateResponse?.();
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
    errorItems: (string | null | undefined)[];
  };
  failNextTtsOpen: { value: boolean };
}

async function openHarness(
  onFirstText?: (itemId: string) => void,
  options: ExternalVoiceConversationOptions = {},
  callbacks: { onResponseDone?: () => void; beforeTtsOpen?: () => Promise<void> | undefined } = {},
): Promise<Harness & { port: Awaited<ReturnType<typeof openExternalVoiceConversation>> }> {
  const realtime = new FakeRealtimePort();
  const ttsPorts: FakeTtsPort[] = [];
  const timers = new FakeTimers();
  const ttsHandlers: ExternalVoiceTtsHandlers[] = [];
  const failNextTtsOpen = { value: false };
  let realtimeHandlers: ExternalVoiceRealtimeHandlers | undefined;
  const events: Harness["events"] = { audio: [], done: [], closes: [], errors: [], errorItems: [] };
  const input: VoiceConversationOpenInput = {
    instructions: "Be Clankie.",
    ...(onFirstText === undefined ? {} : { onFirstText }),
    onAudioDelta: (pcm, itemId) => events.audio.push({ pcm: Buffer.from(pcm), itemId }),
    onFunctionCall: () => undefined,
    onResponseDone: (meta) => {
      events.done.push(meta);
      callbacks.onResponseDone?.();
    },
    onClose: (reason) => events.closes.push(reason),
    onError: (message, itemId) => {
      events.errors.push(message);
      events.errorItems.push(itemId);
    },
  };
  const factories: ExternalVoiceSessionFactories = {
    openRealtime: (handlers) => {
      realtimeHandlers = handlers;
      return Promise.resolve(realtime);
    },
    openTts: async (handlers) => {
      await callbacks.beforeTtsOpen?.();
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
  const port = await openExternalVoiceConversation(input, factories, { timers, ...options });
  if (realtimeHandlers === undefined) throw new Error("realtime handlers were not captured");
  return { port, realtime, ttsPorts, timers, realtimeHandlers, ttsHandlers, events, failNextTtsOpen };
}

describe("external voice conversation", () => {
  it("reports first text before clause buffering without exposing its content", async () => {
    const firstItems: string[] = [];
    const harness = await openHarness((itemId) => firstItems.push(itemId));
    harness.realtimeHandlers.onTextDelta("A quiet", "item-timing");
    await settle();
    expect(firstItems).toEqual(["item-timing"]);
    expect(harness.ttsPorts[0]?.frames.filter((frame) => frame.kind === "append")).toEqual([]);
    harness.realtimeHandlers.onTextDelta(" sentence.", "item-timing");
    await settle();
    expect(firstItems).toEqual(["item-timing"]);
    expect(harness.ttsPorts[0]?.frames.filter((frame) => frame.kind === "append")).toHaveLength(1);
    harness.port.close();
  });

  it("correlates live synthesis failures and suppresses errors from intentional teardown", async () => {
    const { port, realtimeHandlers, ttsHandlers, events } = await openHarness();
    realtimeHandlers.onTextDelta("Still speaking.", "failed_item");
    await settle();
    ttsHandlers[0]?.onError("ElevenLabs transport error");
    expect(events.errors).toEqual(["ElevenLabs transport error"]);
    expect(events.errorItems).toEqual(["failed_item"]);
    port.close();
    ttsHandlers[0]?.onError("ElevenLabs transport error");
    expect(events.errors).toHaveLength(1);
  });

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
    expect(realtime.functionResults).toHaveLength(1);
    realtimeHandlers.onResponseDone(doneMeta("tool-call"));
    port.appendAudio(Buffer.from([1, 0]));
    expect(realtime.textItems).toEqual(["Speaker: james"]);
    expect(realtime.responseCreates).toBe(2);
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

it("keeps queued room responses and handoff answers behind the previous TTS drain", async () => {
  const { port, realtime, realtimeHandlers, ttsHandlers, events } = await openHarness();
  port.createResponse();
  realtimeHandlers.onTextDelta("Room banter.", "banter");
  await settle();
  port.submitFunctionResult("alice-result", "For Alice: the game");
  port.createResponse();
  realtimeHandlers.onResponseDone(doneMeta("banter-response"));
  expect(realtime.functionResults).toHaveLength(1);
  expect(realtime.responseCreates).toBe(1);
  expect(events.done).toEqual([]);
  ttsHandlers[0]!.onContextDone("banter");
  expect(events.done).toEqual([doneMeta("banter-response")]);
  expect(realtime.functionResults).toEqual([{ callId: "alice-result", output: "For Alice: the game" }]);
  expect(realtime.responseCreates).toBe(2);
  realtimeHandlers.onResponseDone(doneMeta("alice-answer"));
  expect(realtime.responseCreates).toBe(3);
  port.createResponse();
  port.close();
  realtimeHandlers.onResponseDone(doneMeta("closed"));
  expect(realtime.responseCreates).toBe(3);
});

it("absorbs a burst behind TTS and retains stale function results without speaking them", async () => {
  const { port, realtime, realtimeHandlers, ttsHandlers } = await openHarness();
  let revision = 0;
  port.createResponse();
  realtimeHandlers.onTextDelta("Already speaking.", "first");
  await settle();
  port.submitFunctionResult("old", "Useful context", () => revision === 0);
  for (let index = 1; index <= 3; index += 1) {
    revision = index;
    port.createResponse(`turn ${index}`, () => revision === index);
  }
  realtimeHandlers.onResponseDone(doneMeta("first"));
  expect(realtime.responseCreates).toBe(1);
  ttsHandlers[0]!.onContextDone("first");
  expect(realtime.responseCreates).toBe(2);
  expect(realtime.functionResults).toEqual([{ callId: "old", output: "Useful context" }]);
  realtimeHandlers.onResponseDone(doneMeta("latest"));
  expect(realtime.responseCreates).toBe(2);
  port.close();
});

describe("v4 authored directions and first-clause segments", () => {
  it("flushes the short first clause early, serializes the remainder, and preserves original item identity", async () => {
    const readable: unknown[] = [];
    const h = await openHarness(undefined, { dialogue: true, onTranscript: (event) => readable.push(event) });
    h.realtimeHandlers.onTextDelta("[lau", "original");
    h.realtimeHandlers.onTextDelta("ghs] Nah. [deadpan] Mara, it's mushrooms.", "original");
    await settle();
    expect(h.ttsPorts[0]!.frames).toEqual([
      { kind: "open", contextId: "original" },
      { kind: "append", contextId: "original", text: "[laughs] Nah. " },
      { kind: "flush", contextId: "original" },
    ]);
    h.realtimeHandlers.onResponseDone(doneMeta("response"));
    await settle();
    expect(h.events.done).toEqual([]);
    h.ttsHandlers[0]!.onAudio(Buffer.from([1, 0]), "original");
    h.ttsHandlers[0]!.onContextDone("original");
    await settle();
    const frames = h.ttsPorts[0]!.frames;
    const remainderId = frames[3]!.contextId!;
    expect(remainderId).not.toBe("original");
    expect(frames.slice(3)).toEqual([
      { kind: "open", contextId: remainderId },
      { kind: "append", contextId: remainderId, text: "[deadpan] Mara, it's mushrooms." },
      { kind: "flush", contextId: remainderId },
    ]);
    const late = Buffer.from([9, 0]);
    h.ttsHandlers[0]!.onAudio(late, "original");
    expect([...late]).toEqual([0, 0]);
    h.ttsHandlers[0]!.onAudio(Buffer.from([2, 0]), remainderId);
    expect(h.events.audio.map((event) => event.itemId)).toEqual(["original", "original"]);
    expect(h.events.done).toEqual([]);
    h.ttsHandlers[0]!.onContextDone(remainderId);
    expect(h.events.done).toHaveLength(1);
    expect(readable).toEqual([
      { itemId: "original", text: "Nah. Mara, it's mushrooms.", final: false },
      { itemId: "original", text: "Nah. Mara, it's mushrooms.", final: true },
    ]);
    h.port.close();
  });

  it("can receive the first segment final before later deltas or response.done without ending the utterance", async () => {
    const h = await openHarness(undefined, { dialogue: true });
    h.realtimeHandlers.onTextDelta("Cat.", "cat");
    await settle();
    h.ttsHandlers[0]!.onContextDone("cat");
    expect(h.events.done).toEqual([]);
    h.realtimeHandlers.onTextDelta(" [sighs] Still a cat.", "cat");
    await settle();
    const second = h.ttsPorts[0]!.frames.findLast((frame) => frame.kind === "open")!.contextId!;
    expect(second).not.toBe("cat");
    h.realtimeHandlers.onResponseDone(doneMeta("cat-response"));
    await settle();
    h.ttsHandlers[0]!.onContextDone(second);
    expect(h.events.done).toHaveLength(1);
    h.port.close();
  });

  it.each([false, true])("tag-only speech has no empty readable transcript (v4=%s)", async (dialogue) => {
    const readable: unknown[] = [];
    const h = await openHarness(undefined, { dialogue, onTranscript: (event) => readable.push(event) });
    for (const delta of ["[si", "ghs] [invented]", " [chuckles]"])
      h.realtimeHandlers.onTextDelta(delta, "sound");
    h.realtimeHandlers.onResponseDone(doneMeta("sound-response"));
    await settle();
    const appends = h.ttsPorts[0]!.frames.filter((frame) => frame.kind === "append");
    expect(appends.map((frame) => frame.text)).toEqual(dialogue ? ["[sighs]  [chuckles]"] : []);
    expect(readable).toEqual([]);
    h.port.close();
  });

  it.each([false, true])("only short first v4 clauses get early terminal flush (v4=%s)", async (dialogue) => {
    const h = await openHarness(undefined, { dialogue });
    h.realtimeHandlers.onTextDelta(
      "This first sentence is long enough to stream without a forced short-clause boundary.",
      "long",
    );
    await settle();
    expect(h.ttsPorts[0]!.frames.some((frame) => frame.kind === "flush")).toBe(false);
    h.port.close();
    if (!dialogue) {
      const short = await openHarness(undefined, { dialogue });
      short.realtimeHandlers.onTextDelta("[laughs] Nah.", "short");
      await settle();
      expect(short.ttsPorts[0]!.frames).toEqual([
        { kind: "open", contextId: "short" },
        { kind: "append", contextId: "short", text: " Nah." },
      ]);
      short.port.close();
    }
  });

  it("barge-in drops the current segment and queued remainder without replaying directions or late audio", async () => {
    const h = await openHarness(undefined, { dialogue: true });
    h.realtimeHandlers.onTextDelta("[laughs] Nah. [sighs] Not that one.", "interrupted");
    await settle();
    h.port.truncate("interrupted", 20);
    await settle();
    h.ttsHandlers[0]!.onContextDone("interrupted");
    h.realtimeHandlers.onTextDelta(" [excited] Late tail.", "interrupted");
    h.realtimeHandlers.onResponseDone(doneMeta("interrupted-response"));
    await settle();
    const late = Buffer.from([1, 0]);
    h.ttsHandlers[0]!.onAudio(late, "interrupted");
    expect([...late]).toEqual([0, 0]);
    expect(h.ttsPorts[0]!.frames.filter((frame) => frame.kind === "open")).toHaveLength(1);
    expect(h.ttsPorts[0]!.frames.at(-1)).toEqual({ kind: "close_context", contextId: "interrupted" });
    expect(h.events.done).toHaveLength(1);
    h.port.close();
  });
});

it("keeps one utterance audio budget across both v4 provider contexts", async () => {
  const h = await openHarness(undefined, { dialogue: true });
  h.realtimeHandlers.onTextDelta("Nah. This is the rest.", "budget");
  await settle();
  h.realtimeHandlers.onResponseDone(doneMeta("budget-response"));
  await settle();
  h.ttsHandlers[0]!.onAudio(Buffer.alloc(MAX_REALTIME_RESPONSE_AUDIO_BYTES - 2), "budget");
  h.ttsHandlers[0]!.onContextDone("budget");
  await settle();
  const second = h.ttsPorts[0]!.frames.findLast((frame) => frame.kind === "open")!.contextId!;
  const over = Buffer.from([1, 0, 2, 0]);
  h.ttsHandlers[0]!.onAudio(over, second);
  await settle();
  expect([...over]).toEqual([0, 0, 0, 0]);
  expect(h.events.audio).toHaveLength(1);
  expect(h.events.errors).toContain("External voice utterance audio exceeded the byte limit");
  expect(h.events.done).toHaveLength(1);
  expect(h.ttsPorts[0]!.closed).toBe(true);
  h.port.close();
});
it("bounds held remainder/tag input and releases a failed utterance", async () => {
  const h = await openHarness(undefined, { dialogue: true });
  h.realtimeHandlers.onTextDelta("Nah. [", "bounded");
  await settle();
  h.realtimeHandlers.onTextDelta("x".repeat(8000), "bounded");
  h.realtimeHandlers.onResponseDone(doneMeta("bounded-response"));
  await settle();
  expect(h.events.errors).toContain("External voice utterance text exceeded the character limit");
  expect(h.events.done).toHaveLength(1);
  expect(h.ttsPorts[0]!.frames.filter((frame) => frame.kind === "open")).toHaveLength(1);
  h.port.close();
});
it("barge-in during asynchronous mouth reopen prevents late context creation and old-mouth callbacks", async () => {
  const realtime = new FakeRealtimePort(),
    first = new FakeTtsPort(),
    reopened = new FakeTtsPort();
  let handlers!: ExternalVoiceRealtimeHandlers, resolveOpen!: (port: ExternalVoiceTtsPort) => void;
  const mouths: ExternalVoiceTtsHandlers[] = [],
    heard: string[] = [];
  const port = await openExternalVoiceConversation(
    {
      instructions: "fixture",
      onAudioDelta: (pcm, itemId) => {
        heard.push(itemId);
        pcm.fill(0);
      },
      onFunctionCall: () => {},
      onResponseDone: () => {},
      onClose: () => {},
      onError: () => {},
    },
    {
      openRealtime: async (input) => {
        handlers = input;
        return realtime;
      },
      openTts: async (input) => {
        mouths.push(input);
        return mouths.length === 1
          ? first
          : new Promise<ExternalVoiceTtsPort>((resolve) => {
              resolveOpen = resolve;
            });
      },
    },
    { dialogue: true, timers: new FakeTimers() },
  );
  first.isOpen = false;
  mouths[0]!.onClose();
  handlers.onTextDelta("[laughs] Nah.", "cancelled");
  await settle();
  port.truncate("cancelled", 0);
  resolveOpen(reopened);
  await settle();
  expect(reopened.frames).toEqual([]);
  handlers.onTextDelta("New reply.", "current");
  await settle();
  mouths[0]!.onClose();
  const stale = Buffer.from([3, 0]);
  mouths[0]!.onAudio(stale, "current");
  expect([...stale]).toEqual([0, 0]);
  mouths[1]!.onAudio(Buffer.from([1, 0]), "current");
  expect(heard).toEqual(["current"]);
  port.close();
});

it.each([
  { failure: "close", admission: "queued start" },
  { failure: "timeout", admission: "queued start" },
  { failure: "step failure", admission: "queued start" },
  { failure: "close", admission: "owner callback" },
  { failure: "timeout", admission: "owner callback" },
  { failure: "step failure", admission: "owner callback" },
])(
  "preserves a synchronous $admission response through mouth $failure teardown",
  async ({ failure, admission }) => {
    let admitFromOwner = () => {};
    let openGate: Promise<void> | undefined;
    const h = await openHarness(
      undefined,
      { dialogue: true },
      {
        onResponseDone: () => admitFromOwner(),
        beforeTtsOpen: () => openGate,
      },
    );
    let resolveOpen!: () => void;
    openGate = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    h.port.createResponse();
    if (admission === "queued start") h.port.createResponse();
    const oldMouth = h.ttsPorts[0]!;
    if (failure === "step failure") oldMouth.failNextOpenContext = true;
    h.realtimeHandlers.onTextDelta("Old answer.", "old");
    h.realtimeHandlers.onResponseDone(doneMeta("old-response"));
    const admitNext = () => {
      admitFromOwner = () => {};
      h.realtimeHandlers.onTextDelta("New answer. And its remaining sentence.", "new");
      h.realtimeHandlers.onResponseDone(doneMeta("new-response"));
    };
    if (admission === "queued start") h.realtime.onCreateResponse = admitNext;
    else admitFromOwner = admitNext;
    if (failure === "step failure") await settle();
    else {
      await settle();
      if (failure === "close") {
        oldMouth.close();
        h.ttsHandlers[0]!.onClose();
      } else h.timers.fire();
    }
    expect(h.realtime.responseCreates).toBe(admission === "queued start" ? 2 : 1);
    expect(h.events.done).toEqual([doneMeta("old-response")]);
    expect(oldMouth.closed).toBe(true);
    // Obsolete callbacks must not kill the new item, even before its queued
    // context open runs. Also send the new id to catch generation confusion.
    const late = Buffer.from([9, 0]);
    h.ttsHandlers[0]!.onAudio(late, "new");
    h.ttsHandlers[0]!.onContextDone("new");
    h.ttsHandlers[0]!.onClose();
    h.ttsHandlers[0]!.onError("obsolete mouth error");
    expect([...late]).toEqual([0, 0]);
    await settle();
    expect(h.ttsPorts).toHaveLength(1);
    h.ttsHandlers[0]!.onClose();
    expect(h.events.done).toEqual([doneMeta("old-response")]);
    resolveOpen();
    await settle();
    expect(h.ttsPorts).toHaveLength(2);
    expect(h.ttsPorts[1]!.frames).toEqual([
      { kind: "open", contextId: "new" },
      { kind: "append", contextId: "new", text: "New answer. " },
      { kind: "flush", contextId: "new" },
    ]);
    h.ttsHandlers[1]!.onAudio(Buffer.from([1, 0]), "new");
    h.ttsHandlers[1]!.onContextDone("new");
    await settle();
    expect(h.events.done).toEqual([doneMeta("old-response")]);
    const remainder = h.ttsPorts[1]!.frames.find(
      (frame) => frame.kind === "open" && frame.contextId !== "new",
    )!.contextId!;
    h.ttsHandlers[1]!.onAudio(Buffer.from([2, 0]), remainder);
    h.ttsHandlers[1]!.onContextDone(remainder);
    expect(h.events.audio).toEqual([
      { pcm: Buffer.from([1, 0]), itemId: "new" },
      { pcm: Buffer.from([2, 0]), itemId: "new" },
    ]);
    expect(h.events.done).toEqual([doneMeta("old-response"), doneMeta("new-response")]);
    expect(h.events.errors).not.toContain("obsolete mouth error");
    expect(h.timers.scheduled.every((timer) => timer.cleared)).toBe(true);
    h.port.close();
  },
);

/** Runs the real composition, realtime adapter and ElevenLabs adapter without provider I/O. */
class RecoverySocket implements RealtimeSocket {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  onSend: ((frame: Record<string, unknown>) => void) | undefined;
  private message: ((data: string) => void) | undefined;
  private closing: (() => void) | undefined;
  send(data: string | Uint8Array): void {
    if (typeof data !== "string") throw new Error("Expected a JSON provider frame");
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    this.onSend?.(frame);
  }
  onMessage(handler: (data: string) => void): void {
    this.message = handler;
  }
  onClose(handler: () => void): void {
    this.closing = handler;
  }
  onError(_handler: (error: unknown) => void): void {}
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.closing?.();
    }
  }
  emit(frame: Record<string, unknown>): void {
    this.message?.(JSON.stringify(frame));
  }
  creates(): Record<string, unknown>[] {
    return this.sent.filter((frame) => frame.type === "response.create");
  }
}

async function openRecoveryComposition(onError?: () => void) {
  const realtime = new RecoverySocket(),
    tts = new RecoverySocket();
  const opened: string[] = [],
    heard: string[] = [],
    done: RealtimeResponseMeta[] = [],
    errors: string[] = [];
  const timers = new FakeTimers();
  const ports = createVoiceRealtimePorts({
    apiKey: "fixture-realtime-key",
    elevenLabsApiKey: "fixture-tts-key",
    config: parseVoiceRealtimeEnv({
      CLANKIE_VOICE_TTS_PROVIDER: "elevenlabs",
      CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "fixture",
    }),
    timers,
    socketFactory: async (url) => {
      opened.push(url);
      return url.includes("elevenlabs") ? tts : realtime;
    },
  });
  const port = await ports.openConversation({
    instructions: "fixture",
    onAudioDelta: (pcm, itemId) => {
      heard.push(itemId);
      pcm.fill(0);
    },
    onFunctionCall: () => {},
    onResponseDone: (meta) => done.push(meta),
    onClose: () => {},
    onError: (message) => {
      errors.push(message);
      onError?.();
    },
  });
  const text = (responseId: string, itemId: string) =>
    realtime.emit({
      type: "response.output_text.delta",
      response_id: responseId,
      item_id: itemId,
      delta: "A spoken sentence.",
    });
  return { port, realtime, tts, opened, heard, done, errors, timers, text };
}

describe("production external-voice response recovery", () => {
  it("abandons only failed speech, admits the latest offer, and fences old terminals through TTS drain", async () => {
    let revision = 0;
    const h = await openRecoveryComposition(() => {
      revision = 1;
    });
    h.port.createResponse("failed offer");
    const oldEventId = h.realtime.creates()[0]!.event_id;
    h.realtime.emit({ type: "response.created", response: { id: "old" } });
    h.text("old", "old-item");
    await settle();
    h.port.createResponse("stale offer", () => revision === 0);
    h.port.createResponse("current offer", () => revision === 1);
    h.realtime.emit({ type: "error", error: { type: "server_error" } });
    expect(h.realtime.creates()).toHaveLength(2);
    expect(h.done).toEqual([]);
    h.port.createResponse("third offer");
    const oldDone = { type: "response.done", response: { id: "old", status: "failed" } };
    h.realtime.emit(oldDone);
    h.realtime.emit({ type: "response.created", response: { id: "new" } });
    h.text("new", "new-item");
    h.text("old", "late-old-item");
    h.realtime.emit(oldDone);
    h.realtime.emit({ type: "error", error: { type: "server_error", event_id: oldEventId } });
    h.realtime.emit({ type: "response.done", response: { id: "new", status: "completed" } });
    await settle();
    expect(h.realtime.creates()).toHaveLength(2);
    expect(h.done).toEqual([]);
    h.tts.emit({ contextId: "old-item", audio: Buffer.from([1, 0]).toString("base64") });
    h.tts.emit({ contextId: "old-item", isFinal: true });
    h.tts.emit({ contextId: "new-item", audio: Buffer.from([1, 0]).toString("base64") });
    expect(h.heard).toEqual(["new-item"]);
    h.tts.emit({ contextId: "new-item", isFinal: true });
    expect(h.done.map((meta) => [meta.responseId, meta.status])).toEqual([["new", "completed"]]);
    expect(h.realtime.creates()).toHaveLength(3);
    expect(h.tts.sent.some((frame) => frame.context_id === "old-item" && frame.close_context === true)).toBe(
      true,
    );
    expect(h.tts.sent.some((frame) => frame.context_id === "late-old-item")).toBe(false);
    expect(h.realtime.sent.filter((frame) => frame.type === "conversation.item.create")).toMatchObject([
      { item: { content: [{ text: "failed offer" }] } },
      { item: { content: [{ text: "current offer" }] } },
      { item: { content: [{ text: "third offer" }] } },
    ]);
    expect(h.opened).toHaveLength(2);
    h.port.close();
  });

  it("closes on a pre-created uncorrelated error without inventing completion or replay", async () => {
    const h = await openRecoveryComposition();
    h.port.createResponse("failed before created");
    h.realtime.emit({ type: "error", error: { type: "server_error" } });
    expect(h.port.isOpen).toBe(false);
    expect(() => h.port.createResponse("next offer")).toThrow();
    h.realtime.emit({ type: "response.created", response: { id: "late-old" } });
    h.realtime.emit({ type: "response.done", response: { id: "late-old", status: "completed" } });
    expect(h.realtime.creates()).toHaveLength(1);
    expect(h.errors).toEqual(["Realtime session error"]);
    expect(h.done).toEqual([]);
    expect(h.opened).toHaveLength(2);
    h.port.close();
  });

  it("does not abandon a completed model response whose TTS is still draining", async () => {
    const h = await openRecoveryComposition();
    h.port.createResponse();
    h.realtime.emit({ type: "response.created", response: { id: "held" } });
    h.text("held", "held-item");
    await settle();
    h.realtime.emit({ type: "response.done", response: { id: "held", status: "completed" } });
    h.port.createResponse();
    h.realtime.emit({ type: "error", error: { type: "server_error" } });
    expect(h.realtime.creates()).toHaveLength(1);
    expect(h.done).toEqual([]);
    await settle();
    h.tts.emit({ contextId: "held-item", isFinal: true });
    expect(h.realtime.creates()).toHaveLength(2);
    expect(h.done.map((meta) => meta.responseId)).toEqual(["held"]);
    h.port.close();
  });

  it.each([false, true])("handles a synchronous context-send error and owner close=%s", async (close) => {
    let fail = true;
    const h = await openRecoveryComposition(() => {
      h.port.createResponse("callback offer");
      if (close) h.port.close();
    });
    h.realtime.onSend = (frame) => {
      if (frame.type !== "conversation.item.create" || !fail) return;
      fail = false;
      h.realtime.emit({ type: "error", error: { type: "server_error" } });
    };
    h.port.createResponse("failed offer");
    expect(h.realtime.creates()).toHaveLength(0);
    expect(h.done).toEqual([]);
    expect(h.port.isOpen).toBe(false);
    h.port.close();
  });
});
