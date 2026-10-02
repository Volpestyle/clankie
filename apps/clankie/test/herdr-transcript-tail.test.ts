import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// node:fs exports are not configurable in ESM, so the counters this file asserts
// on have to be installed as the module is loaded rather than spied afterwards.
const io = vi.hoisted(() => ({ reads: [] as { position: number; length: number }[], wholeFile: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: actual,
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
      io.reads.push({ position, length });
      return actual.readSync(fd, buffer, offset, length, position);
    },
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      io.wholeFile += 1;
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const { appendFileSync, mkdtempSync, renameSync, statSync, utimesSync, writeFileSync } =
  await import("node:fs");
const { parseHerdrSeatTranscript, readHerdrSeatTranscript } =
  await import("../src/captain/herdr-transcript.ts");
type HerdrAgentSession = import("../src/captain/herdr-transcript.ts").HerdrAgentSession;
type HerdrTranscriptEntry = import("../src/captain/herdr-transcript.ts").HerdrTranscriptEntry;

const roots: string[] = [];
afterEach(async () => {
  io.reads.length = 0;
  io.wholeFile = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("incremental seat transcript tailing", () => {
  const codexLine = (id: string, text: string) =>
    `${JSON.stringify({
      timestamp: "2026-09-05T00:00:00Z",
      type: "response_item",
      payload: {
        id,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
      },
    })}\n`;

  const codexImageLine = (id: string, path: string) =>
    `${JSON.stringify({
      timestamp: "2026-09-05T00:00:01Z",
      type: "event_msg",
      payload: { type: "item_completed", item: { type: "ImageView", id, path } },
    })}\n`;

  const seatFile = (contents: string) => {
    const root = mkdtempSync(join(tmpdir(), "herdr-tail-"));
    roots.push(root);
    const file = join(root, "rollout.jsonl");
    writeFileSync(file, contents);
    return file;
  };

  const sessionAt = (file: string, source = "herdr:codex"): HerdrAgentSession => ({
    source,
    kind: "path",
    value: file,
  });

  const textsOf = (transcript: { readonly entries: readonly HerdrTranscriptEntry[] } | undefined) =>
    (transcript?.entries ?? []).flatMap((entry) => (entry.type === "message" ? [entry.text] : []));

  it("reads only the appended bytes, and touches the file at all only when it grew", () => {
    // The equivalence case above also passes a whole-file re-read, so pin the
    // property that actually cost a core: a tick reads the suffix, or nothing.
    const file = seatFile(codexLine("m1", "one") + codexLine("m2", "two"));
    readHerdrSeatTranscript("codex", sessionAt(file));
    io.reads.length = 0;
    io.wholeFile = 0;

    readHerdrSeatTranscript("codex", sessionAt(file));
    expect(io.reads).toEqual([]);
    expect(io.wholeFile).toBe(0);

    const appendedAt = statSync(file).size;
    const rest = codexLine("m3", "three");
    appendFileSync(file, rest);
    const tailed = readHerdrSeatTranscript("codex", sessionAt(file));

    expect(io.reads).toEqual([{ position: appendedAt, length: Buffer.byteLength(rest) }]);
    expect(io.wholeFile).toBe(0);
    expect(textsOf(tailed)).toEqual(["one", "two", "three"]);
  });

  it("folds an append in without re-reading history, matching a whole-file parse", () => {
    const first = codexLine("m1", "one") + codexLine("m2", "two");
    const file = seatFile(first);
    expect(textsOf(readHerdrSeatTranscript("codex", sessionAt(file)))).toEqual(["one", "two"]);

    const rest = codexLine("m3", "three");
    appendFileSync(file, rest);
    const tailed = readHerdrSeatTranscript("codex", sessionAt(file));

    expect(textsOf(tailed)).toEqual(["one", "two", "three"]);
    expect(tailed?.entries).toEqual(parseHerdrSeatTranscript("codex", first + rest));
  });

  it("keeps an appended Codex ImageView in native order without duplicating its item id", () => {
    const first = codexLine("m1", "before");
    const file = seatFile(first);
    expect(readHerdrSeatTranscript("codex", sessionAt(file))?.entries).toHaveLength(1);

    const image = codexImageLine("exec-image-1", "file:///workspace/frames/f01.png");
    appendFileSync(file, image + image + codexLine("m2", "after"));

    expect(readHerdrSeatTranscript("codex", sessionAt(file))?.entries).toEqual([
      expect.objectContaining({ type: "message", id: "codex:m1", text: "before" }),
      {
        type: "viewed_image",
        id: "codex:image:exec-image-1",
        path: "/workspace/frames/f01.png",
        occurredAt: "2026-09-05T00:00:01.000Z",
      },
      expect.objectContaining({ type: "message", id: "codex:m2", text: "after" }),
    ]);
  });

  it("leaves a half-written record for the next tick instead of dropping it", () => {
    const file = seatFile(codexLine("m1", "one"));
    expect(textsOf(readHerdrSeatTranscript("codex", sessionAt(file)))).toEqual(["one"]);

    const complete = codexLine("m2", "two");
    appendFileSync(file, complete.slice(0, 40));
    expect(textsOf(readHerdrSeatTranscript("codex", sessionAt(file)))).toEqual(["one"]);

    appendFileSync(file, complete.slice(40));
    expect(textsOf(readHerdrSeatTranscript("codex", sessionAt(file)))).toEqual(["one", "two"]);
  });

  it("re-reads a same-length rewrite in place rather than reporting stale history", () => {
    const file = seatFile(codexLine("m1", "AAA"));
    expect(textsOf(readHerdrSeatTranscript("codex", sessionAt(file)))).toEqual(["AAA"]);

    const before = statSync(file).size;
    writeFileSync(file, codexLine("m1", "BBB"));
    expect(statSync(file).size).toBe(before);
    const later = new Date(Date.now() + 5_000);
    utimesSync(file, later, later);

    expect(textsOf(readHerdrSeatTranscript("codex", sessionAt(file)))).toEqual(["BBB"]);
  });

  it("re-reads an atomic replace that lands on the same size and mtime", () => {
    const file = seatFile(codexLine("m1", "AAA"));
    // utimesSync only carries whole milliseconds, so pin one both files can hold
    // exactly — the point of the case is an identical size and mtime.
    const stamp = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    utimesSync(file, stamp, stamp);
    expect(textsOf(readHerdrSeatTranscript("codex", sessionAt(file)))).toEqual(["AAA"]);
    const original = statSync(file);

    const replacement = `${file}.new`;
    writeFileSync(replacement, codexLine("m1", "BBB"));
    renameSync(replacement, file);
    utimesSync(file, stamp, stamp);

    expect(statSync(file).size).toBe(original.size);
    expect(statSync(file).mtimeMs).toBe(original.mtimeMs);
    expect(statSync(file).ino).not.toBe(original.ino);
    expect(textsOf(readHerdrSeatTranscript("codex", sessionAt(file)))).toEqual(["BBB"]);
  });

  it("folds a long cold read in bounded chunks, matching a whole-file parse", () => {
    // ~10 MB of history: more than one 8 MiB read, with one record wider than
    // a normal line so a chunk boundary lands inside it.
    const lines = Array.from({ length: 5_000 }, (_, index) => codexLine(`m${index}`, "x".repeat(2_000)));
    lines[2_000] = codexLine("wide", "y".repeat(64 * 1024));
    const file = seatFile(lines.join(""));
    const tailed = readHerdrSeatTranscript("codex", sessionAt(file));

    expect(io.reads.length).toBeGreaterThan(1);
    expect(Math.max(...io.reads.map((read) => read.length))).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(tailed?.entries).toEqual(parseHerdrSeatTranscript("codex", lines.join("")));
  });

  it("forgets call names past its bound the same way incrementally and whole-file", () => {
    const call = (id: string) =>
      `${JSON.stringify({
        timestamp: "2026-09-05T00:00:00Z",
        type: "response_item",
        payload: { id: `c-${id}`, type: "function_call", call_id: id, name: `named_${id}`, arguments: "{}" },
      })}\n`;
    const output = (id: string) =>
      `${JSON.stringify({
        timestamp: "2026-09-05T00:00:01Z",
        type: "response_item",
        payload: { id: `o-${id}`, type: "function_call_output", call_id: id, output: "ok" },
      })}\n`;
    const first = call("old") + call("recent");
    const file = seatFile(first);
    readHerdrSeatTranscript("codex", sessionAt(file));
    // 18,000 newer calls push "old" out of memory; "recent" is rewritten last.
    const newer = Array.from({ length: 18_000 }, (_, index) => call(`n${index}`)).join("") + call("recent");
    appendFileSync(file, newer + output("old") + output("recent"));

    const tailed = readHerdrSeatTranscript("codex", sessionAt(file));
    const results = (tailed?.entries ?? []).filter(
      (entry) => entry.type === "tool" && entry.phase === "completed",
    );
    expect(results.map((entry) => (entry.type === "tool" ? entry.name : ""))).toEqual([
      "tool",
      "named_recent",
    ]);
    expect(tailed?.entries).toEqual(
      parseHerdrSeatTranscript("codex", first + newer + output("old") + output("recent")).slice(-9_000),
    );
  });

  it("reports the identity of the session asked for, not the one that filled the tail", () => {
    const file = seatFile(codexLine("m1", "one"));

    expect(readHerdrSeatTranscript("codex", sessionAt(file, "herdr:codex"))?.sessionKey).toBe(
      `herdr:codex:path:${file}`,
    );
    expect(readHerdrSeatTranscript("codex", sessionAt(file, "herdr:alias"))?.sessionKey).toBe(
      `herdr:alias:path:${file}`,
    );
  });
});
