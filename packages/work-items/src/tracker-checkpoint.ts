import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

// Small files keep the inexpensive native JSON parser. Large checkpoints are ordinary JSON
// too, but no string spans a whole collection: only one field or array entry is decoded.
export const STREAM_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
export interface CheckpointRead {
  value: unknown;
  digest: string;
  bytes: number;
}

/** A top-level JSON object, with its top-level arrays assembled entry by entry. JSON.parse
 * checks every key/value; this scanner checks the enclosing grammar, including trailing commas,
 * truncation and trailing data. Quoting, escapes and nesting survive arbitrary chunk boundaries.
 * Unknown fields and duplicate keys retain JSON.parse semantics; no schema decisions live here.
 */
async function decodeCheckpoint(chunks: AsyncIterable<Buffer>): Promise<CheckpointRead> {
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  const value: Record<string, unknown> = {};
  type State =
    | "start"
    | "keyOrEnd"
    | "key"
    | "colon"
    | "value"
    | "entryOrEnd"
    | "entry"
    | "arrayAfter"
    | "objectAfter"
    | "done";
  let state: State = "start";
  let bytes = 0,
    key = "",
    token: string[] | undefined;
  let quoted = false,
    escaped = false,
    depth = 0;
  let array: unknown[] | undefined;
  const invalid = (): never => {
    throw new SyntaxError("Invalid tracker checkpoint JSON");
  };
  const set = (entry: unknown) =>
    Object.defineProperty(value, key, {
      value: entry,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  const complete = () => {
    const entry: unknown = JSON.parse(token!.join(""));
    token = undefined;
    if (state === "key" || state === "keyOrEnd") {
      if (typeof entry !== "string") invalid();
      key = entry as string;
      state = "colon";
    } else if (state === "entry" || state === "entryOrEnd") {
      array!.push(entry);
      state = "arrayAfter";
    } else {
      set(entry);
      state = "objectAfter";
    }
  };
  const whitespace = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t";
  const consume = (text: string) => {
    let from = token ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (
        token &&
        !quoted &&
        depth === 0 &&
        (whitespace(c) || c === "," || c === "]" || c === "}" || c === ":")
      ) {
        token.push(text.slice(from, i));
        complete();
        from = -1;
      }
      if (!token) {
        if (whitespace(c)) continue;
        if (state === "start") {
          if (c !== "{") invalid();
          state = "keyOrEnd";
          continue;
        }
        if (state === "done") invalid();
        if (state === "colon") {
          if (c !== ":") invalid();
          state = "value";
          continue;
        }
        if (state === "objectAfter") {
          if (c === "}") {
            state = "done";
            continue;
          }
          if (c !== ",") invalid();
          state = "key";
          continue;
        }
        if (state === "arrayAfter") {
          if (c === "]") {
            state = "objectAfter";
            array = undefined;
            continue;
          }
          if (c !== ",") invalid();
          state = "entry";
          continue;
        }
        if (state === "keyOrEnd" && c === "}") {
          state = "done";
          continue;
        }
        if (state === "entryOrEnd" && c === "]") {
          state = "objectAfter";
          array = undefined;
          continue;
        }
        if (state === "value" && c === "[") {
          array = [];
          set(array);
          state = "entryOrEnd";
          continue;
        }
        if ((state === "key" || state === "keyOrEnd") && c !== '"') invalid();
        if (c === "," || c === "]" || c === "}" || c === ":") invalid();
        token = [];
        from = i;
        depth = 0;
        quoted = false;
        escaped = false;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") depth--;
    }
    if (token) token.push(text.slice(from));
  };
  for await (const chunk of chunks) {
    bytes += chunk.length;
    hash.update(chunk);
    consume(decoder.write(chunk));
  }
  consume(decoder.end());
  // A valid document ends with the outer }, so no token may remain at EOF.
  const ended = () => state === "done";
  if (token || !ended()) invalid();
  return { value, digest: hash.digest("hex"), bytes };
}

/** Parse bytes already retained for a strict READ identity proof without one giant string. */
export async function readCheckpointBytes(bytes: Buffer): Promise<CheckpointRead> {
  if (bytes.length <= STREAM_CHECKPOINT_BYTES)
    return {
      value: JSON.parse(bytes.toString("utf8")),
      digest: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
  return decodeCheckpoint(
    (async function* () {
      for (let i = 0; i < bytes.length; i += CHUNK_BYTES) yield bytes.subarray(i, i + CHUNK_BYTES);
    })(),
  );
}

/** The hash and parsed records always describe the same bytes, including during replacement. */
export async function readCheckpointFile(path: string): Promise<CheckpointRead> {
  if ((await stat(path)).size <= STREAM_CHECKPOINT_BYTES) return readCheckpointBytes(await readFile(path));
  return decodeCheckpoint(createReadStream(path, { highWaterMark: CHUNK_BYTES }));
}
