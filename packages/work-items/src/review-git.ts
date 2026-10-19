import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Read-only local Git change for a guided review (VUH-1906 Requirements E).
 * Each ref resolves once to a full commit ID; the diff then reads only those
 * commit objects, never the index, working tree or a remote. Paths and diff
 * text are untrusted content for the reader, never instructions.
 */

export interface ReviewDiffLimits {
  /** Changed files allowed before the result refuses to list hunks. */
  readonly maxFiles: number;
  /** Bytes of patch text allowed before the result refuses to list hunks. */
  readonly maxPatchBytes: number;
  /** Milliseconds the whole read may take, across every Git process. */
  readonly timeoutMs: number;
}

export const REVIEW_DIFF_LIMITS: ReviewDiffLimits = {
  maxFiles: 200,
  maxPatchBytes: 1024 * 1024,
  timeoutMs: 10_000,
};

export interface ReviewDiffLine {
  readonly kind: "context" | "add" | "delete";
  readonly text: string;
  /** Line number in the base file; absent for an added line. */
  readonly oldLine?: number;
  /** Line number in the head file; absent for a deleted line. */
  readonly newLine?: number;
  /** Git's "\ No newline at end of file" marker followed this line. */
  readonly noNewlineAtEnd?: true;
}

export interface ReviewDiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  /** Git's function-context heading after the second @@, possibly empty. */
  readonly heading: string;
  readonly lines: readonly ReviewDiffLine[];
}

export interface ReviewDiffFile {
  readonly change: "added" | "deleted" | "modified" | "renamed" | "copied" | "type_changed";
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly oldObject: string | null;
  readonly newObject: string | null;
  /** Rename/copy similarity percentage. */
  readonly similarity?: number;
  readonly binary: boolean;
  /** A gitlink: its hunk is Git's "Subproject commit" pointer line; the submodule itself is not read. */
  readonly submodule: boolean;
  /** Null when the result is incomplete; empty for binary, pure rename or mode-only changes. */
  readonly hunks: readonly ReviewDiffHunk[] | null;
}

export interface ReviewDiff {
  /** Canonical path of the Git directory the commits were read from. */
  readonly gitDirectory: string;
  /** Canonical working-tree root, or null for a bare repository. */
  readonly worktree: string | null;
  readonly base: { readonly ref: string; readonly commit: string };
  readonly head: { readonly ref: string; readonly commit: string };
  /** False whenever files or hunks were withheld; never present a partial result as a complete review. */
  readonly complete: boolean;
  readonly incomplete?: {
    readonly reason: "too_many_files" | "patch_too_large" | "repository_attributes";
    readonly detail: string;
  };
  /** Null when the changed-file list itself was too large to count. */
  readonly fileCount: number | null;
  readonly files: readonly ReviewDiffFile[];
  readonly limits: ReviewDiffLimits;
}

export type ReviewDiffErrorCode =
  | "invalid_repository"
  | "invalid_ref"
  | "ambiguous_ref"
  | "unknown_ref"
  | "timeout"
  | "unsupported"
  | "git_failed";

export class ReviewDiffError extends Error {
  readonly code: ReviewDiffErrorCode;
  constructor(code: ReviewDiffErrorCode, message: string) {
    super(message);
    this.name = "ReviewDiffError";
    this.code = code;
  }
}

// Option-like, whitespace, control characters and range syntax never reach Git.
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/@{}^~+-]{0,254}$/u;

// Overrides that keep every read local and free of configured commands.
const GIT_OVERRIDES = [
  "--no-pager",
  "--no-replace-objects",
  "--literal-pathspecs",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "diff.external=",
  "-c",
  "protocol.allow=never",
  "-c",
  "submodule.recurse=false",
  "-c",
  "core.warnAmbiguousRefs=true",
  "-c",
  "core.attributesFile=/dev/null",
];

// Attributes come from the empty tree, so checkout or committed .gitattributes cannot hide text as binary.
const EMPTY_TREE: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

function gitEnvironment(): NodeJS.ProcessEnv {
  // A fresh environment: inherited GIT_DIR, GIT_INDEX_FILE and friends must not redirect the read.
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_PAGER: "cat",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** One deadline for the whole read; each Git process gets what is left of it. */
interface Budget {
  readonly deadline: number;
  readonly timeoutMs: number;
}

function git(
  cwd: string,
  args: readonly string[],
  budget: Budget,
  maxBuffer = 1024 * 1024,
): Promise<GitResult> {
  const timeout = budget.deadline - Date.now();
  if (timeout <= 0)
    return Promise.reject(new ReviewDiffError("timeout", `The read exceeded ${budget.timeoutMs} ms`));
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      [...GIT_OVERRIDES, ...args],
      // Buffers, so maxBuffer counts bytes rather than decoded characters.
      { cwd, env: gitEnvironment(), timeout, maxBuffer, encoding: "buffer", shell: false },
      (error, stdoutBytes, stderrBytes) => {
        const stderr = stderrBytes.toString("utf8");
        if (!error) {
          // Paths and text are reported exactly or not at all; lossy U+FFFD replacement would misquote them.
          try {
            return resolvePromise({ stdout: STRICT_UTF8.decode(stdoutBytes), stderr });
          } catch {
            return reject(
              new ReviewDiffError("unsupported", "Git output (a path or file text) is not valid UTF-8."),
            );
          }
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new OutputLimit(maxBuffer));
        if (failure.killed || failure.signal === "SIGTERM")
          return reject(new ReviewDiffError("timeout", `The read exceeded ${budget.timeoutMs} ms`));
        reject(
          Object.assign(new ReviewDiffError("git_failed", stderr.trim() || failure.message), { stderr }),
        );
      },
    );
  });
}

class OutputLimit extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`output exceeded ${bytes} bytes`);
    this.bytes = bytes;
  }
}

async function openRepository(
  repository: string,
  budget: Budget,
): Promise<{ gitDirectory: string; commonDirectory: string; worktree: string | null }> {
  if (!isAbsolute(repository))
    throw new ReviewDiffError("invalid_repository", "The repository must be an absolute path.");
  let canonical: string;
  try {
    canonical = await realpath(repository);
  } catch {
    throw new ReviewDiffError("invalid_repository", `No such directory: ${repository}`);
  }
  let output: string;
  try {
    output = (await git(canonical, [...LOCATE, "--show-toplevel"], budget)).stdout;
  } catch (error) {
    // A bare repository has no top level; ask again without it.
    try {
      output = (await git(canonical, LOCATE, budget)).stdout;
    } catch {
      throw new ReviewDiffError(
        "invalid_repository",
        `Not a readable Git repository: ${repository} (${(error as Error).message})`,
      );
    }
  }
  const [gitDir = "", bare = "", common = "", toplevel] = output.split("\n");
  const gitDirectory = await realpath(gitDir);
  // A linked worktree shares its main repository's info/attributes.
  const commonDirectory = await realpath(common);
  if (bare === "true") {
    if (gitDirectory !== canonical)
      throw new ReviewDiffError("invalid_repository", "Name the bare repository's own directory.");
    return { gitDirectory, commonDirectory, worktree: null };
  }
  const worktree = toplevel ? await realpath(toplevel) : "";
  // Discovery walks upward; the caller authorized this exact repository, not a parent of it.
  if (worktree !== canonical)
    throw new ReviewDiffError(
      "invalid_repository",
      `Name the repository root (${worktree || "unknown"}), not a directory inside it.`,
    );
  return { gitDirectory, commonDirectory, worktree };
}

const LOCATE = [
  "rev-parse",
  "--absolute-git-dir",
  "--is-bare-repository",
  "--path-format=absolute",
  "--git-common-dir",
];

/** Whether Git may apply info/attributes here: any non-empty file, or one it cannot rule out. */
async function hasLocalAttributes(directories: readonly string[]): Promise<boolean> {
  for (const directory of new Set(directories)) {
    try {
      if ((await stat(join(directory, "info", "attributes"))).size > 0) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

async function resolveCommit(cwd: string, ref: string, budget: Budget): Promise<string> {
  if (!REF_PATTERN.test(ref) || ref.includes(".."))
    throw new ReviewDiffError("invalid_ref", `Refused ref ${JSON.stringify(ref)}: not a plain commit-ish.`);
  let result: GitResult;
  try {
    result = await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], budget);
  } catch (error) {
    if (error instanceof ReviewDiffError && error.code === "timeout") throw error;
    const stderr = (error as { stderr?: string }).stderr ?? "";
    if (/ambiguous/iu.test(stderr))
      throw new ReviewDiffError("ambiguous_ref", `Ref ${JSON.stringify(ref)} is ambiguous.`);
    throw new ReviewDiffError("unknown_ref", `Ref ${JSON.stringify(ref)} does not name a commit here.`);
  }
  // rev-parse picks one meaning of a name shared by a branch and a tag, and only warns.
  if (/ambiguous/iu.test(result.stderr))
    throw new ReviewDiffError("ambiguous_ref", `Ref ${JSON.stringify(ref)} is ambiguous.`);
  const commit = result.stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit))
    throw new ReviewDiffError("unknown_ref", `Ref ${JSON.stringify(ref)} did not resolve to a commit ID.`);
  return commit;
}

const STATUS: Record<string, ReviewDiffFile["change"]> = {
  A: "added",
  D: "deleted",
  M: "modified",
  R: "renamed",
  C: "copied",
  T: "type_changed",
};

interface RawEntry {
  readonly change: ReviewDiffFile["change"];
  readonly oldMode: string | null;
  readonly newMode: string | null;
  readonly oldObject: string | null;
  readonly newObject: string | null;
  readonly similarity?: number;
  readonly oldPath: string | null;
  readonly newPath: string | null;
}

const ZERO_OBJECT = /^0+$/u;

function parseRaw(output: string): RawEntry[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const entries: RawEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const meta = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMRTUX])(\d*)$/u.exec(fields[index] ?? "");
    if (!meta) throw new ReviewDiffError("unsupported", "Unrecognized git diff-tree output.");
    const [, oldMode, newMode, oldObject, newObject, letter, score] = meta;
    const change = STATUS[letter!];
    if (!change) throw new ReviewDiffError("unsupported", `Unsupported change status ${letter}.`);
    const paired = letter === "R" || letter === "C";
    const first = fields[index + 1];
    const second = paired ? fields[index + 2] : first;
    if (first === undefined || second === undefined)
      throw new ReviewDiffError("unsupported", "Truncated git diff-tree output.");
    index += paired ? 3 : 2;
    entries.push({
      change,
      oldMode: change === "added" ? null : oldMode!,
      newMode: change === "deleted" ? null : newMode!,
      oldObject: ZERO_OBJECT.test(oldObject!) ? null : oldObject!,
      newObject: ZERO_OBJECT.test(newObject!) ? null : newObject!,
      ...(paired ? { similarity: Number(score) } : {}),
      oldPath: change === "added" ? null : first,
      newPath: change === "deleted" ? null : second,
    });
  }
  return entries;
}

interface PatchSection {
  binary: boolean;
  /** Object IDs from the section's `index OLD..NEW` line, when Git printed one. */
  objects?: readonly [string | null, string | null];
  readonly hunks: ReviewDiffHunk[];
}

function parsePatch(output: string): PatchSection[] {
  const sections: PatchSection[] = [];
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let section: PatchSection | undefined;
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.startsWith("diff --git ")) {
      section = { binary: false, hunks: [] };
      sections.push(section);
      index += 1;
      continue;
    }
    if (!section) throw new ReviewDiffError("unsupported", "Patch text before the first file header.");
    if (line.startsWith("Binary files ")) {
      section.binary = true;
      index += 1;
      continue;
    }
    const objects = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: \d{6})?$/u.exec(line);
    if (objects && section.hunks.length === 0) {
      const id = (value: string) => (ZERO_OBJECT.test(value) ? null : value);
      section.objects = [id(objects[1]!), id(objects[2]!)];
      index += 1;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u.exec(line);
    if (!header) {
      index += 1; // extended header: modes, index, similarity, rename, ---/+++
      continue;
    }
    const oldStart = Number(header[1]);
    const oldLines = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newLines = header[4] === undefined ? 1 : Number(header[4]);
    const body: ReviewDiffLine[] = [];
    let oldLine = oldStart;
    let newLine = newStart;
    let oldLeft = oldLines;
    let newLeft = newLines;
    index += 1;
    // Count lines from the hunk header so diff content can never be read as a file header.
    while (oldLeft > 0 || newLeft > 0 || lines[index]?.startsWith("\\")) {
      const text = lines[index];
      if (text === undefined) throw new ReviewDiffError("unsupported", "Truncated hunk in patch output.");
      index += 1;
      const marker = text[0];
      if (marker === "\\") {
        const previous = body.at(-1);
        if (previous) body[body.length - 1] = { ...previous, noNewlineAtEnd: true };
        continue;
      }
      if (marker === " ") {
        body.push({ kind: "context", text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
        oldLeft -= 1;
        newLeft -= 1;
      } else if (marker === "-") {
        body.push({ kind: "delete", text: text.slice(1), oldLine: oldLine++ });
        oldLeft -= 1;
      } else if (marker === "+") {
        body.push({ kind: "add", text: text.slice(1), newLine: newLine++ });
        newLeft -= 1;
      } else throw new ReviewDiffError("unsupported", "Unrecognized line inside a hunk.");
      if (oldLeft < 0 || newLeft < 0)
        throw new ReviewDiffError("unsupported", "Hunk longer than its header.");
    }
    section.hunks.push({ oldStart, oldLines, newStart, newLines, heading: header[5] ?? "", lines: body });
  }
  return sections;
}

/**
 * Reads the change between two commits of one explicitly named local
 * repository. Invalid, option-like, unknown or ambiguous refs throw
 * {@link ReviewDiffError}; a change beyond the limits returns
 * `complete: false` with what was withheld, never a silently shortened diff.
 */
export async function readReviewDiff(input: {
  readonly repository: string;
  readonly base: string;
  readonly head: string;
  readonly limits?: Partial<ReviewDiffLimits>;
}): Promise<ReviewDiff> {
  const limits: ReviewDiffLimits = { ...REVIEW_DIFF_LIMITS, ...input.limits };
  const budget: Budget = { deadline: Date.now() + limits.timeoutMs, timeoutMs: limits.timeoutMs };
  const { gitDirectory, commonDirectory, worktree } = await openRepository(input.repository, budget);
  const cwd = worktree ?? gitDirectory;
  const base = await resolveCommit(cwd, input.base, budget);
  const head = await resolveCommit(cwd, input.head, budget);
  const result = (
    files: readonly ReviewDiffFile[],
    fileCount: number | null,
    incomplete?: ReviewDiff["incomplete"],
  ): ReviewDiff => ({
    gitDirectory,
    worktree,
    base: { ref: input.base, commit: base },
    head: { ref: input.head, commit: head },
    complete: incomplete === undefined,
    ...(incomplete === undefined ? {} : { incomplete }),
    fileCount,
    files,
    limits,
  });
  const emptyTree = EMPTY_TREE[base.length === 64 ? "sha256" : "sha1"]!;
  // Plumbing diff-tree ignores porcelain diff config; the flags restate every off switch.
  const common = [
    `--attr-source=${emptyTree}`,
    "diff-tree",
    "-r",
    "-M",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
  ];
  // Raw entries are small, so a generous fixed buffer only bounds pathological path lengths.
  let raw: string;
  try {
    raw = (
      await git(
        cwd,
        [...common, "-z", "--raw", "--no-abbrev", base, head, "--"],
        budget,
        Math.max(limits.maxFiles, 1) * 8192,
      )
    ).stdout;
  } catch (error) {
    if (error instanceof OutputLimit)
      return result([], null, {
        reason: "too_many_files",
        detail: `The changed-file list exceeded ${error.bytes} bytes.`,
      });
    throw error;
  }
  const entries = parseRaw(raw);
  if (entries.length > limits.maxFiles)
    return result([], entries.length, {
      reason: "too_many_files",
      detail: `${entries.length} files changed; the limit is ${limits.maxFiles}.`,
    });
  const withoutHunks = entries.map((entry) => ({
    ...entry,
    binary: false,
    submodule: entry.oldMode === "160000" || entry.newMode === "160000",
    hunks: null,
  }));
  let patch: string;
  try {
    patch = (
      await git(
        cwd,
        [...common, "-p", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", base, head, "--"],
        budget,
        limits.maxPatchBytes,
      )
    ).stdout;
  } catch (error) {
    if (error instanceof OutputLimit)
      return result(withoutHunks, entries.length, {
        reason: "patch_too_large",
        detail: `The patch exceeded ${limits.maxPatchBytes} bytes; files are listed without hunks.`,
      });
    throw error;
  }
  const sections = parsePatch(patch);
  const files: ReviewDiffFile[] = [];
  let next = 0;
  for (const file of withoutHunks) {
    // Git prints a type change (file to symlink, say) as a deletion followed by an addition.
    const parts = sections.slice(next, next + (file.change === "type_changed" ? 2 : 1));
    next += parts.length;
    const first = parts[0]?.objects;
    const last = parts.at(-1)?.objects;
    if (
      parts.length === 0 ||
      (first !== undefined && first[0] !== file.oldObject) ||
      (last !== undefined && last[1] !== file.newObject)
    )
      throw new ReviewDiffError("unsupported", "Patch sections do not match the changed files.");
    files.push({
      ...file,
      binary: parts.some((part) => part.binary),
      hunks: parts.flatMap((part) => part.hunks),
    });
  }
  if (next !== sections.length)
    throw new ReviewDiffError("unsupported", "Patch sections do not match the changed files.");
  // Only the repository's own info/attributes still applies; say so rather than trust its binary verdicts.
  if (files.some((file) => file.binary) && (await hasLocalAttributes([gitDirectory, commonDirectory])))
    return result(files, files.length, {
      reason: "repository_attributes",
      detail: "This repository's info/attributes can mark text binary, so a binary file here may hide text.",
    });
  return result(files, files.length);
}
