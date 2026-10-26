import { createHash } from "node:crypto";
import { constants, type FileHandle, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ReviewDiffHunk, ReviewDiffLine } from "./review-git.ts";

/**
 * A supplied local Git patch for a guided review (VUH-1906, the plain-patch
 * fallback). Only the one named file is read; nothing is applied, no Git or
 * other process runs, and no path named inside the patch is opened. Every
 * header, path and line is the patch's own untrusted assertion: object IDs on
 * its `index` lines are claims, never resolved commits or blobs.
 */

export interface ReviewPatchLimits {
  /** Bytes of patch file allowed; a larger file is refused unread past this. */
  readonly maxPatchBytes: number;
  /** File sections allowed. */
  readonly maxFiles: number;
  /** Hunks allowed across the whole patch. */
  readonly maxHunks: number;
}

export const REVIEW_PATCH_LIMITS: ReviewPatchLimits = {
  maxPatchBytes: 1024 * 1024,
  maxFiles: 200,
  maxHunks: 2000,
};

export interface ReviewPatchFile {
  readonly change: "added" | "deleted" | "modified" | "renamed" | "copied";
  readonly oldPath: string | null;
  readonly newPath: string | null;
  /** Modes as the patch states them; null on the missing side or when it states none. */
  readonly oldMode: string | null;
  readonly newMode: string | null;
  /** IDs from the section's `index OLD..NEW` line exactly as printed, often abbreviated; unverified. */
  readonly claimedObjects: { readonly old: string | null; readonly new: string | null } | null;
  /** Rename/copy similarity percentage the patch asserts. */
  readonly similarity?: number;
  /** "Binary files … differ": the patch carries no content for this file. */
  readonly binary: boolean;
  /** A gitlink: its hunk is the patch's "Subproject commit" text; nothing is resolved. */
  readonly submodule: boolean;
  readonly hunks: readonly ReviewDiffHunk[];
}

export interface ReviewPatch {
  /** The review came from a supplied patch, not from repository objects. */
  readonly source: "patch";
  readonly patch: {
    /** The path as the caller named it. */
    readonly path: string;
    readonly bytes: number;
    /** SHA-256 of exactly the bytes parsed. */
    readonly sha256: string;
  };
  /** Always true: anything that cannot be parsed whole is refused instead. */
  readonly complete: true;
  readonly fileCount: number;
  readonly files: readonly ReviewPatchFile[];
  readonly limits: ReviewPatchLimits;
}

export type ReviewPatchErrorCode =
  | "invalid_path"
  | "empty"
  | "too_large"
  | "too_many_files"
  | "too_many_hunks"
  | "invalid_utf8"
  | "malformed"
  | "unsupported";

export class ReviewPatchError extends Error {
  readonly code: ReviewPatchErrorCode;
  constructor(code: ReviewPatchErrorCode, message: string) {
    super(message);
    this.name = "ReviewPatchError";
    this.code = code;
  }
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const malformed = (line: number, message: string) =>
  new ReviewPatchError("malformed", `Line ${line}: ${message}`);
const unsupported = (line: number, message: string) =>
  new ReviewPatchError("unsupported", `Line ${line}: ${message}`);

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  if (!isAbsolute(path)) throw new ReviewPatchError("invalid_path", "The patch path must be absolute.");
  let handle: FileHandle;
  try {
    // No symlink and no blocking open of a FIFO: only the regular file the caller named.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReviewPatchError(
      "invalid_path",
      code === "ELOOP" ? `Refused a symbolic link: ${path}` : `Cannot open ${path} (${code ?? "error"})`,
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ReviewPatchError("invalid_path", `Not a regular file: ${path}`);
    if (info.size > maxBytes)
      throw new ReviewPatchError("too_large", `The patch is ${info.size} bytes; the limit is ${maxBytes}.`);
    // Read one byte past the limit so a file that grew after stat is still refused.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes)
      throw new ReviewPatchError("too_large", `The patch exceeds the ${maxBytes}-byte limit.`);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Git's C-style quoted name, starting at `start` (a `"`); returns the name and the index after it. */
function unquote(text: string, start: number, line: number): { name: string; end: number } {
  const bytes: number[] = [];
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      try {
        return { name: STRICT_UTF8.decode(Uint8Array.from(bytes)), end: index + 1 };
      } catch {
        throw new ReviewPatchError("invalid_utf8", `Line ${line}: a quoted path is not valid UTF-8.`);
      }
    }
    if (char !== "\\") {
      // Whole code points: encoding a lone surrogate half would substitute U+FFFD.
      const point = String.fromCodePoint(text.codePointAt(index)!);
      bytes.push(...Buffer.from(point, "utf8"));
      index += point.length - 1;
      continue;
    }
    const next = text[index + 1] ?? "";
    const octal = /^[0-3][0-7]{2}/u.exec(text.slice(index + 1, index + 4));
    if (octal) {
      // Git paths never hold NUL; an escaped one is not what Git prints.
      if (octal[0] === "000") throw malformed(line, "NUL in a quoted path.");
      bytes.push(Number.parseInt(octal[0], 8));
      index += 3;
    } else if (ESCAPES[next] !== undefined) {
      bytes.push(ESCAPES[next]);
      index += 1;
    } else throw malformed(line, "unknown escape in a quoted path.");
  }
  throw malformed(line, "unterminated quoted path.");
}

/** A whole-value name: quoted, or the literal rest of the value. */
function name(value: string, line: number): string {
  if (!value.startsWith('"')) {
    if (value === "") throw malformed(line, "empty path.");
    return value;
  }
  const { name: parsed, end } = unquote(value, 0, line);
  if (end !== value.length) throw malformed(line, "text after a quoted path.");
  if (parsed === "") throw malformed(line, "empty path.");
  return parsed;
}

function stripPrefix(path: string, prefix: "a/" | "b/", line: number): string {
  if (!path.startsWith(prefix) || path.length === prefix.length)
    throw unsupported(line, `paths must carry Git's default "${prefix}" prefix.`);
  return path.slice(prefix.length);
}

/** The two names of `diff --git A B`, or null when unquoted names with spaces leave them ambiguous. */
function gitHeaderNames(rest: string, line: number): readonly [string, string] | null {
  let first: string;
  let after: string;
  if (rest.startsWith('"')) {
    const quoted = unquote(rest, 0, line);
    if (rest[quoted.end] !== " ") throw malformed(line, "file header needs two names.");
    first = quoted.name;
    after = rest.slice(quoted.end + 1);
  } else {
    // An unquoted name holds no '"', so a quoted second name starts at the first ' "'.
    const split = rest.indexOf(' "');
    if (split === -1) {
      const half = (rest.length - 1) / 2;
      const left = rest.slice(0, half);
      const right = rest.slice(half + 1);
      if (!Number.isInteger(half) || rest[half] !== " " || left.slice(2) !== right.slice(2)) return null;
      return [stripPrefix(left, "a/", line), stripPrefix(right, "b/", line)];
    }
    first = rest.slice(0, split);
    after = rest.slice(split + 1);
  }
  return [stripPrefix(first, "a/", line), stripPrefix(name(after, line), "b/", line)];
}

/**
 * A `---`/`+++` name: /dev/null, or a prefixed path. Git ends it with a tab when
 * it holds a space; a name containing a tab is always quoted, so one trailing tab is never part of it.
 */
function markerName(value: string, prefix: "a/" | "b/", line: number): string | null {
  const plain = value.replace(/\t$/u, "");
  if (plain === "/dev/null") return null;
  return stripPrefix(name(plain, line), prefix, line);
}

const MODE = /^(?:100644|100755|120000|160000)$/u;
// core.abbrev may go as low as 4.
const INDEX = /^index ([0-9a-f]{4,64})\.\.([0-9a-f]{4,64})(?: (\d{6}))?$/u;
// `[^\n]*`, not `.*`: a heading or name may hold CR, U+2028 or U+2029.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ([^\n]*))?$/u;
const ZERO = /^0+$/u;
const NO_NEWLINE = "\\ No newline at end of file";
const GITLINK_LINE = /^Subproject commit (?:[0-9a-f]{40}|[0-9a-f]{64})(?:-dirty)?$/u;
// The empty blob in SHA-1 and SHA-256 repositories; an empty file's section has no hunks.
const EMPTY_BLOBS = [
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
];

interface Headers {
  oldMode?: string;
  newMode?: string;
  newFileMode?: string;
  deletedFileMode?: string;
  similarity?: number;
  renameFrom?: string;
  renameTo?: string;
  copyFrom?: string;
  copyTo?: string;
  index?: { old: string; new: string; mode?: string };
  /** The two labels of "Binary files A and B differ". */
  binary?: string;
}

function parseHunks(
  lines: readonly string[],
  start: number,
  budget: { hunks: number; maxHunks: number },
): { hunks: ReviewDiffHunk[]; next: number } {
  const hunks: ReviewDiffHunk[] = [];
  let index = start;
  let delta = 0;
  let previousEnd = { old: 0, new: 0 };
  let ended = false;
  while (lines[index]?.startsWith("@@")) {
    const number = index + 1;
    const header = HUNK.exec(lines[index]!);
    if (!header) throw malformed(number, "invalid hunk header.");
    if (ended) throw malformed(number, "hunk after the end of the file.");
    budget.hunks += 1;
    if (budget.hunks > budget.maxHunks)
      throw new ReviewPatchError("too_many_hunks", `More than ${budget.maxHunks} hunks; refused whole.`);
    const [oldStart, oldLines, newStart, newLines] = [header[1], header[2], header[3], header[4]].map(
      (value, position) => (value === undefined ? (position % 2 === 1 ? 1 : 0) : Number(value)),
    ) as [number, number, number, number];
    if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger))
      throw malformed(number, "hunk header number out of range.");
    if (oldLines === 0 && newLines === 0) throw malformed(number, "empty hunk.");
    if ((oldStart === 0 && oldLines !== 0) || (newStart === 0 && newLines !== 0))
      throw malformed(number, "hunk starts at line 0 but has lines on that side.");
    // An empty side names the line before the change; normalize so both sides line up.
    const oldFirst = oldLines === 0 ? oldStart + 1 : oldStart;
    const newFirst = newLines === 0 ? newStart + 1 : newStart;
    const oldEnd = oldFirst + oldLines;
    const newEnd = newFirst + newLines;
    // Keep normalized empty-side positions, line increments and exclusive ends exact too.
    if (![oldFirst, newFirst, oldEnd, newEnd].every(Number.isSafeInteger))
      throw malformed(number, "hunk range out of range.");
    if (oldFirst < previousEnd.old || newFirst < previousEnd.new)
      throw malformed(number, "hunks overlap or are out of order.");
    if (newFirst - oldFirst !== delta)
      throw malformed(number, "hunk position contradicts the lines added and removed before it.");
    const body: ReviewDiffLine[] = [];
    let oldLine = oldStart;
    let newLine = newStart;
    let oldLeft = oldLines;
    let newLeft = newLines;
    let oldClosed = false;
    let newClosed = false;
    index += 1;
    // Count lines from the header so content can never be read as a file or hunk header.
    while (oldLeft > 0 || newLeft > 0 || lines[index]?.startsWith("\\")) {
      const text = lines[index];
      if (text === undefined) throw malformed(index + 1, "truncated hunk.");
      index += 1;
      const marker = text[0];
      if (marker === "\\") {
        if (text !== NO_NEWLINE) throw malformed(index, "unrecognized marker line inside a hunk.");
        const previous = body.at(-1);
        if (!previous || previous.noNewlineAtEnd)
          throw malformed(index, "no-newline marker without a preceding line.");
        body[body.length - 1] = { ...previous, noNewlineAtEnd: true };
        if (previous.kind !== "add") oldClosed = true;
        if (previous.kind !== "delete") newClosed = true;
        continue;
      }
      const oldSide = marker === " " || marker === "-";
      const newSide = marker === " " || marker === "+";
      if (!oldSide && !newSide) throw malformed(index, "unrecognized line inside a hunk.");
      if ((oldSide && oldClosed) || (newSide && newClosed))
        throw malformed(index, "line after that side's no-newline marker.");
      if ((oldSide && oldLeft === 0) || (newSide && newLeft === 0))
        throw malformed(index, "hunk longer than its header.");
      const content = text.slice(1);
      if (marker === " ")
        body.push({ kind: "context", text: content, oldLine: oldLine++, newLine: newLine++ });
      else if (marker === "-") body.push({ kind: "delete", text: content, oldLine: oldLine++ });
      else body.push({ kind: "add", text: content, newLine: newLine++ });
      if (oldSide) oldLeft -= 1;
      if (newSide) newLeft -= 1;
    }
    ended = oldClosed || newClosed;
    delta = newEnd - oldEnd;
    previousEnd = { old: oldEnd, new: newEnd };
    hunks.push({ oldStart, oldLines, newStart, newLines, heading: header[5] ?? "", lines: body });
  }
  return { hunks, next: index };
}

function parse(text: string, limits: ReviewPatchLimits): ReviewPatchFile[] {
  if (!text.endsWith("\n")) throw malformed(text.split("\n").length, "truncated: no final newline.");
  const lines = text.slice(0, -1).split("\n");
  const files: ReviewPatchFile[] = [];
  const budget = { hunks: 0, maxHunks: limits.maxHunks };
  const touched = { old: new Set<string>(), new: new Set<string>() };
  let index = 0;
  while (index < lines.length) {
    const number = index + 1;
    const first = lines[index]!;
    if (first.startsWith("diff --cc ") || first.startsWith("diff --combined "))
      throw unsupported(number, "combined (merge) diffs are not supported.");
    if (!first.startsWith("diff --git "))
      throw index === 0
        ? unsupported(1, 'expected a Git patch starting with "diff --git" (no mail headers or plain diffs).')
        : malformed(number, "unexpected text between file sections.");
    if (files.length === limits.maxFiles)
      throw new ReviewPatchError("too_many_files", `More than ${limits.maxFiles} files; refused whole.`);
    const headerNames = first.slice("diff --git ".length);
    const names = gitHeaderNames(headerNames, number);
    index += 1;
    const headers: Headers = {};
    const once = <K extends keyof Headers>(key: K, value: Headers[K], at: number) => {
      if (headers[key] !== undefined) throw malformed(at, `repeated ${key} header.`);
      headers[key] = value;
    };
    for (; index < lines.length; index += 1) {
      const line = lines[index]!;
      const at = index + 1;
      const [, keyword = "", value = ""] =
        /^(old mode|new mode|new file mode|deleted file mode|similarity index|dissimilarity index|rename from|rename to|copy from|copy to) ([^\n]*)$/u.exec(
          line,
        ) ?? [];
      if (keyword.endsWith("mode")) {
        if (!MODE.test(value)) throw unsupported(at, `unsupported file mode ${JSON.stringify(value)}.`);
        const key = (
          {
            "old mode": "oldMode",
            "new mode": "newMode",
            "new file mode": "newFileMode",
            "deleted file mode": "deletedFileMode",
          } as const
        )[keyword]!;
        once(key, value, at);
      } else if (keyword === "similarity index") {
        const match = /^(\d{1,3})%$/u.exec(value);
        if (!match || Number(match[1]) > 100) throw malformed(at, "invalid similarity index.");
        once("similarity", Number(match[1]), at);
      } else if (keyword === "dissimilarity index")
        throw unsupported(at, "break-rewrite (dissimilarity) sections are not supported.");
      else if (keyword !== "") {
        const key = (
          {
            "rename from": "renameFrom",
            "rename to": "renameTo",
            "copy from": "copyFrom",
            "copy to": "copyTo",
          } as const
        )[keyword]!;
        once(key, name(value, at), at);
      } else if (line.startsWith("index ")) {
        const match = INDEX.exec(line);
        if (!match) throw malformed(at, "invalid index line.");
        once("index", { old: match[1]!, new: match[2]!, ...(match[3] ? { mode: match[3] } : {}) }, at);
        if (match[3] && !MODE.test(match[3])) throw unsupported(at, `unsupported file mode ${match[3]}.`);
      } else if (line === "GIT binary patch")
        throw unsupported(at, "binary patch payloads are not supported.");
      else if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
        once("binary", line.slice("Binary files ".length, -" differ".length), at);
      } else break;
      if (headers.binary !== undefined) {
        index += 1;
        break;
      }
    }
    // Content markers and hunks.
    let oldMarker: string | null | undefined;
    let newMarker: string | null | undefined;
    let hunks: ReviewDiffHunk[] = [];
    if (headers.binary === undefined && lines[index]?.startsWith("--- ")) {
      oldMarker = markerName(lines[index]!.slice(4), "a/", index + 1);
      index += 1;
      if (!lines[index]?.startsWith("+++ ")) throw malformed(index + 1, 'expected "+++" after "---".');
      newMarker = markerName(lines[index]!.slice(4), "b/", index + 1);
      index += 1;
      if (oldMarker === null && newMarker === null) throw malformed(index, "both sides are /dev/null.");
      ({ hunks, next: index } = parseHunks(lines, index, budget));
      if (hunks.length === 0) throw malformed(index + 1, "truncated: file markers without a hunk.");
    }
    if (index < lines.length && !lines[index]!.startsWith("diff --"))
      throw malformed(index + 1, "unrecognized line in a file section.");
    files.push(section(number, names, headerNames, headers, oldMarker, newMarker, hunks, touched));
  }
  return files;
}

/** Splits "A and B"; unquoted labels holding " and " must equal the expected pair exactly. */
function binaryLabels(
  text: string,
  line: number,
  expected: readonly [string, string],
): readonly [string, string] {
  let first: string;
  let rest: string;
  if (text.startsWith('"')) {
    const quoted = unquote(text, 0, line);
    first = quoted.name;
    rest = text.slice(quoted.end);
  } else {
    // An unquoted label holds no '"', so a quoted second label starts at the first ' and "'.
    const split = text.indexOf(' and "');
    if (split === -1) {
      if (text !== `${expected[0]} and ${expected[1]}`) throw malformed(line, "binary line names disagree.");
      return expected;
    }
    first = text.slice(0, split);
    rest = text.slice(split);
  }
  if (!rest.startsWith(" and ")) throw malformed(line, "invalid binary line.");
  return [first, name(rest.slice(" and ".length), line)];
}

/** Cross-checks one section's assertions; any contradiction refuses the whole patch. */
function section(
  number: number,
  names: readonly [string, string] | null,
  headerNames: string,
  headers: Headers,
  oldMarker: string | null | undefined,
  newMarker: string | null | undefined,
  hunks: readonly ReviewDiffHunk[],
  touched: { readonly old: Set<string>; readonly new: Set<string> },
): ReviewPatchFile {
  const fail = (message: string) => malformed(number, `${message} (file section starting here).`);
  const added = headers.newFileMode !== undefined;
  const deleted = headers.deletedFileMode !== undefined;
  const renamed = headers.renameFrom !== undefined || headers.renameTo !== undefined;
  const copied = headers.copyFrom !== undefined || headers.copyTo !== undefined;
  if ([added, deleted, renamed, copied].filter(Boolean).length > 1)
    throw fail("contradictory add, delete, rename or copy headers");
  if (renamed && (headers.renameFrom === undefined || headers.renameTo === undefined))
    throw fail("rename needs both from and to");
  if (copied && (headers.copyFrom === undefined || headers.copyTo === undefined))
    throw fail("copy needs both from and to");
  if ((renamed || copied) !== (headers.similarity !== undefined))
    throw fail("similarity index belongs only to a rename or copy");
  if ((added || deleted) && (headers.oldMode !== undefined || headers.newMode !== undefined))
    throw fail("mode change on an added or deleted file");
  if ((headers.oldMode === undefined) !== (headers.newMode === undefined))
    throw fail("old and new mode must appear together");
  if (headers.index?.mode !== undefined && (added || deleted || headers.oldMode !== undefined))
    throw fail("index line mode contradicts the mode headers");

  // Every name the section states must agree; the header line alone may be ambiguous.
  const oldNames = [names?.[0], headers.renameFrom ?? headers.copyFrom, added ? undefined : oldMarker];
  const newNames = [names?.[1], headers.renameTo ?? headers.copyTo, deleted ? undefined : newMarker];
  const agreed = (candidates: (string | null | undefined)[]) => {
    const stated = candidates.filter((value): value is string => typeof value === "string");
    if (stated.some((value) => value !== stated[0])) throw fail("file names disagree");
    return stated[0];
  };
  const oldName = agreed(oldNames);
  const newName = agreed(newNames);
  if (oldName === undefined || newName === undefined) throw fail("ambiguous file names");
  // Ambiguous unquoted rename/copy names must still match the entire original header.
  if (names === null && headerNames !== `a/${oldName} b/${newName}`) throw fail("file header names disagree");
  if (!renamed && !copied && oldName !== newName) throw fail("names differ without a rename or copy");
  if (added && oldMarker !== undefined && oldMarker !== null)
    throw fail('an added file needs "--- /dev/null"');
  if (deleted && newMarker !== undefined && newMarker !== null)
    throw fail('a deleted file needs "+++ /dev/null"');
  if (!added && oldMarker === null) throw fail('"--- /dev/null" without "new file mode"');
  if (!deleted && newMarker === null) throw fail('"+++ /dev/null" without "deleted file mode"');

  const claims = headers.index;
  if (claims) {
    if (ZERO.test(claims.old) !== added || ZERO.test(claims.new) !== deleted)
      throw fail("index line contradicts whether the file is added or deleted");
  }
  // A whole-file side: /dev/null is empty at line 0 and the file starts at line 1, in one hunk.
  for (const hunk of hunks) {
    if (added && (hunks.length !== 1 || hunk.oldStart !== 0 || hunk.oldLines !== 0 || hunk.newStart !== 1))
      throw fail("an added file's hunk must be @@ -0,0 +1,N @@");
    if (deleted && (hunks.length !== 1 || hunk.newStart !== 0 || hunk.newLines !== 0 || hunk.oldStart !== 1))
      throw fail("a deleted file's hunk must be @@ -1,N +0,0 @@");
  }
  // Git prints neither an index line nor hunks for an exact (100%) rename or copy.
  if (
    headers.similarity === 100 &&
    (claims !== undefined || hunks.length > 0 || headers.binary !== undefined)
  )
    throw fail("a 100% similar rename or copy carries content");
  if (headers.binary !== undefined) {
    // Git always prints the index line and the same two names it put on the header.
    if (!claims) throw fail("binary change without an index line");
    const labels = binaryLabels(headers.binary, number, [
      added ? "/dev/null" : `a/${oldName}`,
      deleted ? "/dev/null" : `b/${newName}`,
    ]);
    const stated = (label: string, prefix: "a/" | "b/") =>
      label === "/dev/null" ? null : stripPrefix(label, prefix, number);
    if (
      stated(labels[0], "a/") !== (added ? null : oldName) ||
      stated(labels[1], "b/") !== (deleted ? null : newName)
    )
      throw fail("binary line names disagree");
  }
  if (hunks.length === 0 && headers.binary === undefined) {
    // Git omits hunks only for empty files, pure renames/copies and mode changes.
    const emptyBlob = (id: string | undefined) =>
      id !== undefined && EMPTY_BLOBS.some((blob) => blob.startsWith(id));
    const emptyFile = (added && emptyBlob(claims?.new)) || (deleted && emptyBlob(claims?.old));
    // A rename or copy below 100% similarity changed content, so its hunks were cut off.
    const metadataOnly =
      !added &&
      !deleted &&
      claims === undefined &&
      (renamed || copied ? headers.similarity === 100 : headers.oldMode !== undefined);
    if (!emptyFile && !metadataOnly) throw fail("truncated or incomplete: a change with no content");
  }

  // Each side names a path at most once. Git's type change deletes then adds one path, and a
  // copy reads its source without changing it.
  for (const [side, path] of [
    ["old", added || copied ? null : oldName],
    ["new", deleted ? null : newName],
  ] as const) {
    if (path === null) continue;
    if (touched[side].has(path)) throw fail(`path changed twice: ${JSON.stringify(path)}`);
    touched[side].add(path);
  }

  const mode = headers.index?.mode;
  const oldMode = added ? null : (headers.deletedFileMode ?? headers.oldMode ?? mode ?? null);
  const newMode = deleted ? null : (headers.newFileMode ?? headers.newMode ?? mode ?? null);
  const submodule = oldMode === "160000" || newMode === "160000";
  // A gitlink's only content is its commit pointer; anything else is not what Git prints.
  if (submodule && hunks.length > 0) {
    const hunk = hunks[0]!;
    if (
      hunks.length !== 1 ||
      hunk.oldStart !== (added ? 0 : 1) ||
      hunk.oldLines !== (added ? 0 : 1) ||
      hunk.newStart !== (deleted ? 0 : 1) ||
      hunk.newLines !== (deleted ? 0 : 1)
    )
      throw fail("gitlink hunk must describe its single commit-pointer line");
    if (hunk.lines.some((line) => !GITLINK_LINE.test(line.text)))
      throw fail("gitlink hunk is not a Subproject commit line");
  }
  return {
    change: added ? "added" : deleted ? "deleted" : renamed ? "renamed" : copied ? "copied" : "modified",
    oldPath: added ? null : oldName,
    newPath: deleted ? null : newName,
    oldMode,
    newMode,
    claimedObjects: claims
      ? { old: ZERO.test(claims.old) ? null : claims.old, new: ZERO.test(claims.new) ? null : claims.new }
      : null,
    ...(headers.similarity === undefined ? {} : { similarity: headers.similarity }),
    binary: headers.binary !== undefined,
    submodule,
    hunks,
  };
}

/**
 * Reads one explicitly named local Git patch (`git diff` output) as typed
 * review data. Empty, oversized, malformed, truncated, contradictory,
 * non-UTF-8 or unsupported input throws {@link ReviewPatchError}; a patch is
 * parsed whole or not at all.
 */
export async function readReviewPatch(input: {
  readonly path: string;
  readonly limits?: Partial<ReviewPatchLimits>;
}): Promise<ReviewPatch> {
  const limits: ReviewPatchLimits = { ...REVIEW_PATCH_LIMITS, ...input.limits };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new ReviewPatchError("invalid_path", `Limit ${key} must be a positive integer.`);
  const bytes = await readBounded(input.path, limits.maxPatchBytes);
  if (bytes.length === 0)
    throw new ReviewPatchError("empty", "The patch is empty; an empty file asserts no change to review.");
  let text: string;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    throw new ReviewPatchError("invalid_utf8", "The patch is not valid UTF-8.");
  }
  // Git treats any text with NUL as binary, so a NUL here was never a text hunk.
  if (text.includes("\0")) throw new ReviewPatchError("malformed", "The patch contains a NUL byte.");
  const files = parse(text, limits);
  return {
    source: "patch",
    patch: {
      path: input.path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    complete: true,
    fileCount: files.length,
    files,
    limits,
  };
}
