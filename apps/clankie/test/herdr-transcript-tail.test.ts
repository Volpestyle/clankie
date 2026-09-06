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
