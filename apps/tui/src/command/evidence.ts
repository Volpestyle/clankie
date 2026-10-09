import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  EVIDENCE_RECENT_PATH,
  EvidenceRecentResponseSchema,
  EVIDENCE_FETCH_PATH,
  EVIDENCE_RECEIPTS_PATH,
  EVIDENCE_RECORDS_PATH,
  EVIDENCE_UPLOADS_PATH,
  EvidenceFetchResponseSchema,
  EvidenceManifestSchema,
  EvidenceReceiptSchema,
  EvidenceRecordListSchema,
  evidenceLink,
  type EvidenceManifest,
  type EvidenceManifestObject,
  type EvidenceReceipt,
  type EvidenceRecord,
} from "@clankie/protocol/evidence";
import { commandHost } from "./io.ts";

/**
 * `clankie evidence push|fetch|list|receipt` (ADR 0258). Paths resolve from the
 * working directory; nothing is configured per repository. The same functions
 * back the operator seat's `evidence_*` MCP tools.
 */
const EVIDENCE_USAGE = [
  "Usage: clankie evidence push [PATH] [--issue KEY] [--caption TEXT]",
  "       clankie evidence fetch [PATH]",
  "       clankie evidence list --issue KEY | --commit SHA",
  "       clankie evidence list --recent [--project NAME] [--repo REPO] [--issue KEY] [--actor-kind KIND] [--actor-name NAME] [--media-type TYPE] [--since ISO] [--until ISO] [--cursor CURSOR] [--limit N]",
  "       clankie evidence receipt RECEIPT_ID",
].join("\n");

/** Repository-relative evidence roots (ADR 0258). Only files under these ever move. */
const DEFAULT_EVIDENCE_ROOTS = ["docs/testing"] as const;
const EVIDENCE_CONFIG = join(".clankie", "evidence.json");
const MANIFEST = "evidence.json";
const MIRROR = join(".local", "evidence");
/** Non-media files below this stay readable in git. */
const RAW_MIN_BYTES = 16 * 1024;
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
const RAW_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".log": "text/plain",
  ".txt": "text/plain",
};

const execFileAsync = promisify(execFile);

export interface EvidenceOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}

interface Failure {
  readonly path: string;
  readonly reason: string;
}

class EvidenceClient {
  private readonly host: string;
  private readonly bearer: string;
  private readonly fetcher: typeof fetch;

  private constructor(host: string, bearer: string, fetcher: typeof fetch) {
    this.host = host;
    this.bearer = bearer;
    this.fetcher = fetcher;
  }

  static async connect(options: EvidenceOptions) {
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (!credential) throw new Error("Evidence needs the operator credential. Run clankie doctor.");
    return new EvidenceClient(commandHost({ ...options, env }), credential.token, options.fetchImpl ?? fetch);
  }

  private async json(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const response = await this.fetcher(`${this.host}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.bearer}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, body };
  }

  private static failed(what: string, result: { status: number; body: unknown }): Error {
    const code =
      typeof result.body === "object" && result.body !== null && "error" in result.body
        ? String((result.body as { error: unknown }).error)
        : `HTTP ${result.status}`;
    return new Error(`${what} failed: ${code}`);
  }

  async upload(request: Record<string, unknown>): Promise<EvidenceReceipt> {
    const result = await this.json(EVIDENCE_UPLOADS_PATH, { method: "POST", body: JSON.stringify(request) });
    if (result.status !== 200) throw EvidenceClient.failed("Upload", result);
    return EvidenceReceiptSchema.parse(result.body);
  }

  async receipt(receiptId: string): Promise<EvidenceReceipt | undefined> {
    const result = await this.json(`${EVIDENCE_RECEIPTS_PATH}/${encodeURIComponent(receiptId)}`);
    if (result.status === 404) return undefined;
    if (result.status !== 200) throw EvidenceClient.failed("Receipt lookup", result);
    return EvidenceReceiptSchema.parse(result.body);
  }

  async putBlob(uploadUrl: string, file: string, size: number): Promise<EvidenceReceipt> {
    const response = await this.fetcher(new URL(uploadUrl, this.host), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
      body: Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>,
      duplex: "half",
      signal: AbortSignal.timeout(30 * 60_000),
    } as RequestInit);
    const body = (await response.json()) as unknown;
    if (response.status !== 200 && response.status !== 422)
      throw EvidenceClient.failed("Blob upload", { status: response.status, body });
    return EvidenceReceiptSchema.parse(body);
  }

  async signedFetch(sha256: string) {
    const result = await this.json(EVIDENCE_FETCH_PATH, { method: "POST", body: JSON.stringify({ sha256 }) });
    if (result.status !== 200) throw EvidenceClient.failed("Fetch", result);
    return EvidenceFetchResponseSchema.parse(result.body);
  }

  async download(url: string, destination: string) {
    const response = await this.fetcher(new URL(url, this.host), {
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok || response.body === null) throw new Error(`download failed: HTTP ${response.status}`);
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      createWriteStream(destination, { mode: 0o600 }),
    );
  }

  async recent(values: URLSearchParams) {
    const result = await this.json(`${EVIDENCE_RECENT_PATH}?${values}`);
    if (result.status !== 200) throw EvidenceClient.failed("Recent list", result);
    return EvidenceRecentResponseSchema.parse(result.body);
  }

  async list(filter: { issueKey: string } | { commit: string }): Promise<EvidenceRecord[]> {
    const query =
      "issueKey" in filter ? `issue=${encodeURIComponent(filter.issueKey)}` : `commit=${filter.commit}`;
    const result = await this.json(`${EVIDENCE_RECORDS_PATH}?${query}`);
    if (result.status !== 200) throw EvidenceClient.failed("List", result);
    return EvidenceRecordListSchema.parse(result.body).records;
  }
}

async function git(cwd: string, args: readonly string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

async function repoRootOf(cwd: string) {
  try {
    return await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`${cwd} is not inside a git repository`);
  }
}

async function evidenceRoots(repo: string): Promise<readonly string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(repo, EVIDENCE_CONFIG), "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { roots?: unknown }).roots) ||
      !(parsed as { roots: unknown[] }).roots.length ||
      (parsed as { roots: unknown[] }).roots.some(
        (root) =>
          typeof root !== "string" ||
          root.length === 0 ||
          isAbsolute(root) ||
          root.split(/[\\/]/u).includes(".."),
      )
    )
      throw new Error(`must contain a non-empty relative roots array`);
    return (parsed as { roots: string[] }).roots.map((root) =>
      root.replaceAll("\\", "/").replace(/\/+$/u, ""),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_EVIDENCE_ROOTS;
    throw new Error(`Invalid ${EVIDENCE_CONFIG}: ${String(error)}`);
  }
}

const posix = (path: string) => path.split(sep).join("/");

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(path: string): Promise<EvidenceManifest | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return EvidenceManifestSchema.parse(JSON.parse(text));
}

function serializeManifest(objects: readonly EvidenceManifestObject[]): string {
  const sorted = [...objects].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `${JSON.stringify({ version: 1, objects: sorted }, null, 2)}\n`;
}

/** Media of any size, or any other non-Markdown file of 16 KiB or more (ADR 0258). */
function evidenceKind(name: string, size: number): string | undefined {
  const extension = extname(name).toLowerCase();
  if (name === MANIFEST || extension === ".md") return undefined;
  const media = MEDIA_TYPES[extension];
  if (media !== undefined) return media;
  return size >= RAW_MIN_BYTES ? (RAW_TYPES[extension] ?? "application/octet-stream") : undefined;
}

async function walk(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function inside(parent: string, child: string) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** The folder whose manifest lists `start`: the nearest with evidence.json, else with README.md, else `start`. */
async function manifestFolder(root: string, start: string): Promise<string> {
  for (const marker of [MANIFEST, "README.md"]) {
    for (let folder = start; inside(root, folder); folder = dirname(folder))
      if (await exists(join(folder, marker))) return folder;
  }
  return start;
}

function refusal(repoRelative: string, roots: readonly string[]) {
  return new Error(
    `${repoRelative || "."} is outside the evidence roots (${roots.join(", ")}); ` +
      "push a folder inside one. Product assets stay in git.",
  );
}

interface EvidencePushResult {
  readonly ok: boolean;
  readonly manifest?: string;
  readonly manifestChanged: boolean;
  readonly uploaded: number;
  readonly added: readonly { path: string; url: string }[];
  readonly changed: readonly { path: string; url: string }[];
  readonly moved: readonly { from: string; to: string }[];
  readonly receipts: readonly { path: string; receiptId: string; state: string }[];
  readonly failures: readonly Failure[];
  readonly summary: string;
}

async function evidencePush(
  input: {
    path?: string;
    issueKey?: string;
    caption?: string;
    project?: string;
    repo?: string;
    model?: string;
    outcome?: string;
  },
  options: EvidenceOptions = {},
): Promise<EvidencePushResult> {
  const cwd = options.cwd ?? process.cwd();
  const repo = await repoRootOf(cwd);
  const roots = await evidenceRoots(repo);
  const requested = resolve(cwd, input.path ?? ".");
  if (!(await exists(requested))) throw new Error(`${input.path ?? "."} does not exist`);
  const target = await realpath(requested);
  const targetRelative = posix(relative(repo, target));
  const root = roots.map((entry) => join(repo, entry)).find((entry) => inside(entry, target));
  if (root === undefined) throw refusal(targetRelative, roots);
  const isFile = (await stat(target)).isFile();
  const folder = await manifestFolder(root, isFile ? dirname(target) : target);
  const folderRelative = posix(relative(repo, folder));
  const manifestPath = join(folder, MANIFEST);
  const commit = await git(repo, ["rev-parse", "HEAD"]).catch(() => undefined);

  const candidates: { file: string; size: number; contentType: string }[] = [];
  for (const file of isFile ? [target] : await walk(target)) {
    if (!inside(folder, file)) continue;
    const size = (await stat(file)).size;
    const contentType = evidenceKind(file.slice(file.lastIndexOf(sep) + 1), size);
    if (contentType !== undefined) candidates.push({ file, size, contentType });
  }

  const existing = await readManifest(manifestPath);
  const entries = new Map((existing?.objects ?? []).map((object) => [object.path, object]));
  const added: { path: string; url: string }[] = [];
  const changed: { path: string; url: string }[] = [];
  const failures: Failure[] = [];
  const receipts: { path: string; receiptId: string; state: string }[] = [];
  const pushed: { file: string; path: string; sha256: string }[] = [];
  let uploaded = 0;
  const repoName =
    input.repo ?? (await git(repo, ["remote", "get-url", "origin"]).catch(() => repo.split(sep).at(-1)));
  const client = candidates.length === 0 ? undefined : await EvidenceClient.connect(options);
  for (const candidate of candidates) {
    const path = posix(relative(folder, candidate.file));
    const repoPath = posix(relative(repo, candidate.file));
    try {
      const sha256 = await sha256File(candidate.file);
      const request = {
        // Deterministic: a retried push asks for the same receipt instead of a second record.
        idempotencyKey: createHash("sha256")
          .update(
            JSON.stringify([
              repoPath,
              sha256,
              commit ?? null,
              input.issueKey ?? null,
              input.caption ?? null,
              repoName ?? null,
              input.project ?? null,
              input.model ?? null,
              input.outcome ?? null,
            ]),
          )
          .digest("hex"),
        sha256,
        size: candidate.size,
        contentType: candidate.contentType,
        fileName: repoPath,
        repo: repoName,
        ...(input.project === undefined ? {} : { project: input.project }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(input.issueKey === undefined ? {} : { issueKey: input.issueKey }),
        ...(commit === undefined ? {} : { commit }),
        ...(input.caption === undefined ? {} : { caption: input.caption }),
      };
      let receipt: EvidenceReceipt;
      try {
        receipt = await client!.upload(request);
      } catch (error) {
        // An unanswered upload is reconciled by its receipt, never resent blind.
        const known = await client!.receipt(request.idempotencyKey);
        if (known === undefined) throw error;
        receipt = known;
      }
      for (let attempt = 0; receipt.state === "pending" && attempt < 2; attempt += 1) {
        try {
          receipt = await client!.putBlob(receipt.uploadUrl!, candidate.file, candidate.size);
          uploaded += 1;
        } catch (error) {
          const known = await client!.receipt(request.idempotencyKey);
          if (known === undefined || attempt === 1) throw error;
          receipt = known;
        }
      }
      receipts.push({ path, receiptId: receipt.receiptId, state: receipt.state });
      if (receipt.state !== "applied") {
        failures.push({ path, reason: receipt.refusal ?? `upload ${receipt.state}` });
        continue;
      }
      const url = evidenceLink(sha256);
      const previous = entries.get(path);
      if (previous === undefined) added.push({ path, url });
      else if (previous.sha256 !== sha256) changed.push({ path, url });
      entries.set(path, { path, size: candidate.size, sha256, url });
      pushed.push({ file: candidate.file, path, sha256 });
    } catch (error) {
      failures.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  let manifestChanged = false;
  if (entries.size > 0) {
    const next = serializeManifest([...entries.values()]);
    const before = existing === undefined ? undefined : await readFile(manifestPath, "utf8");
    if (before !== next) {
      await writeFile(manifestPath, next);
      manifestChanged = true;
    }
  }

  const moved: { from: string; to: string }[] = [];
  for (const object of pushed) {
    const destination = join(repo, MIRROR, folderRelative, object.path);
    try {
      await mkdir(dirname(destination), { recursive: true });
      if (await exists(destination)) {
        if ((await sha256File(destination)) !== object.sha256) {
          failures.push({
            path: object.path,
            reason: `${posix(relative(repo, destination))} holds different bytes; the pushed file stays in place`,
          });
          continue;
        }
        await unlink(object.file);
      } else {
        try {
          await rename(object.file, destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          await copyFile(object.file, destination);
          await unlink(object.file);
        }
      }
      moved.push({ from: posix(relative(repo, object.file)), to: posix(relative(repo, destination)) });
    } catch (error) {
      failures.push({
        path: object.path,
        reason: `move failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const manifest = entries.size > 0 ? posix(relative(repo, manifestPath)) : undefined;
  const summary =
    uploaded === 0 && !manifestChanged && added.length === 0 && changed.length === 0 && failures.length === 0
      ? `Nothing uploaded; ${manifest ?? "no manifest"} ${manifest === undefined ? "written" : "unchanged"}.`
      : [
          `Uploaded ${uploaded} blob${uploaded === 1 ? "" : "s"}; ${manifest ?? "no manifest"} ${manifestChanged ? "updated" : "unchanged"}.`,
          ...added.map((entry) => `added ${entry.path} ${entry.url}`),
          ...changed.map((entry) => `changed ${entry.path} ${entry.url}`),
          ...(moved.length
            ? [
                `moved ${moved.length} raw file${moved.length === 1 ? "" : "s"} to ${posix(join(MIRROR, folderRelative))}/`,
              ]
            : []),
          ...failures.map((failure) => `failed ${failure.path}: ${failure.reason}`),
        ].join("\n");
  return {
    ok: failures.length === 0,
    ...(manifest === undefined ? {} : { manifest }),
    manifestChanged,
    uploaded,
    added,
    changed,
    moved,
    receipts,
    failures,
    summary,
  };
}

interface EvidenceFetchResult {
  readonly ok: boolean;
  readonly fetched: readonly string[];
  readonly present: readonly string[];
  readonly failures: readonly Failure[];
  readonly summary: string;
}

async function manifestsFor(repo: string, target: string): Promise<string[]> {
  for (let folder = target; folder === repo || inside(repo, folder); folder = dirname(folder)) {
    if (await exists(join(folder, MANIFEST))) return [folder];
    if (folder === repo) break;
  }
  const found: string[] = [];
  const visit = async (directory: string) => {
    if (await exists(join(directory, MANIFEST))) {
      found.push(directory);
      return;
    }
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory() && ![".git", ".local", "node_modules"].includes(entry.name))
        await visit(join(directory, entry.name));
  };
  await visit(target);
  return found.sort();
}

async function evidenceFetch(
  input: { path?: string },
  options: EvidenceOptions = {},
): Promise<EvidenceFetchResult> {
  const cwd = options.cwd ?? process.cwd();
  const repo = await repoRootOf(cwd);
  const roots = await evidenceRoots(repo);
  const requested = resolve(cwd, input.path ?? ".");
  if (!(await exists(requested))) throw new Error(`${input.path ?? "."} does not exist`);
  const target = await realpath(requested);
  if (target !== repo && !roots.some((entry) => inside(join(repo, entry), target)))
    throw refusal(posix(relative(repo, target)), roots);
  const fetched: string[] = [];
  const present: string[] = [];
  const failures: Failure[] = [];
  let client: EvidenceClient | undefined;
  const manifestFolders =
    target === repo
      ? await Promise.all(roots.map((entry) => manifestsFor(repo, join(repo, entry)))).then((groups) =>
          groups.flat(),
        )
      : await manifestsFor(repo, target);
  for (const folder of [...new Set(manifestFolders)]) {
    const folderRelative = posix(relative(repo, folder));
    let manifest: EvidenceManifest;
    try {
      manifest = (await readManifest(join(folder, MANIFEST)))!;
    } catch (error) {
      failures.push({
        path: posix(join(folderRelative, MANIFEST)),
        reason: `unreadable manifest: ${String(error)}`,
      });
      continue;
    }
    for (const object of manifest.objects) {
      const named = posix(join(folderRelative, object.path));
      const source = join(folder, object.path);
      if (inside(folder, target) && source !== target && !inside(target, source)) continue;
      if (isAbsolute(object.path) || object.path.split("/").includes("..")) {
        failures.push({ path: named, reason: "path escapes its folder" });
        continue;
      }
      if (object.url !== evidenceLink(object.sha256)) {
        failures.push({ path: named, reason: "link does not name its sha256" });
        continue;
      }
      const destination = join(repo, MIRROR, folderRelative, object.path);
      try {
        if (await exists(destination)) {
          if ((await sha256File(destination)) === object.sha256) present.push(named);
          else failures.push({ path: named, reason: "local file differs from the manifest; left untouched" });
          continue;
        }
        client ??= await EvidenceClient.connect(options);
        const signed = await client.signedFetch(object.sha256);
        await mkdir(dirname(destination), { recursive: true });
        const partial = `${destination}.${process.pid}.part`;
        try {
          await client.download(signed.url, partial);
          const size = (await stat(partial)).size;
          if (size !== object.size) throw new Error(`size ${size} does not match ${object.size}`);
          if ((await sha256File(partial)) !== object.sha256) throw new Error("sha256 does not match");
          await rename(partial, destination);
          fetched.push(named);
        } finally {
          await rm(partial, { force: true });
        }
      } catch (error) {
        failures.push({ path: named, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const summary = [
    `Fetched ${fetched.length}, already present ${present.length}, failed ${failures.length}${fetched.length + present.length ? ` (into ${posix(MIRROR)}/)` : ""}.`,
    ...failures.map((failure) => `failed ${failure.path}: ${failure.reason}`),
  ].join("\n");
  return { ok: failures.length === 0, fetched, present, failures, summary };
}

async function evidenceList(
  filter: { issueKey: string } | { commit: string },
  options: EvidenceOptions = {},
): Promise<EvidenceRecord[]> {
  return (await EvidenceClient.connect(options)).list(filter);
}

async function evidenceReceipt(receiptId: string, options: EvidenceOptions = {}) {
  return (await EvidenceClient.connect(options)).receipt(receiptId);
}

function flags(args: readonly string[], allowed: readonly string[]) {
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg.startsWith("--")) {
      const value = args[index + 1];
      if (!allowed.includes(arg) || value === undefined || values.has(arg)) throw new Error(EVIDENCE_USAGE);
      values.set(arg, value);
      index += 1;
    } else positional.push(arg);
  }
  return { positional, values };
}

/** Headless dispatch: one JSON document on stdout, the human summary on stderr. */
export async function runEvidenceCommand(
  args: readonly string[],
  options: EvidenceOptions & { readonly stderr?: { write(chunk: string): unknown } },
): Promise<{ readonly ok: boolean; readonly body: unknown }> {
  const [verb, ...rest] = args;
  const stderr = options.stderr ?? process.stderr;
  if (verb === "push") {
    const { positional, values } = flags(rest, [
      "--issue",
      "--caption",
      "--project",
      "--repo",
      "--model",
      "--outcome",
    ]);
    if (positional.length > 1) throw new Error(EVIDENCE_USAGE);
    const issueKey = values.get("--issue");
    const caption = values.get("--caption");
    const result = await evidencePush(
      {
        ...Object.fromEntries(
          ["project", "repo", "model", "outcome"].flatMap((key) =>
            values.has(`--${key}`) ? [[key, values.get(`--${key}`)]] : [],
          ),
        ),
        ...(positional[0] === undefined ? {} : { path: positional[0] }),
        ...(issueKey === undefined ? {} : { issueKey }),
        ...(caption === undefined ? {} : { caption }),
      },
      options,
    );
    stderr.write(`${result.summary}\n`);
    return { ok: result.ok, body: result };
  }
  if (verb === "fetch") {
    const { positional } = flags(rest, []);
    if (positional.length > 1) throw new Error(EVIDENCE_USAGE);
    const result = await evidenceFetch(positional[0] === undefined ? {} : { path: positional[0] }, options);
    stderr.write(`${result.summary}\n`);
    return { ok: result.ok, body: result };
  }
  if (verb === "list" && rest.includes("--recent")) {
    const { positional, values } = flags(
      rest.filter((flag) => flag !== "--recent"),
      [
        "--project",
        "--repo",
        "--issue",
        "--actor-kind",
        "--actor-name",
        "--media-type",
        "--since",
        "--until",
        "--cursor",
        "--limit",
      ],
    );
    if (positional.length || rest.filter((flag) => flag === "--recent").length !== 1)
      throw new Error(EVIDENCE_USAGE);
    const query = new URLSearchParams();
    for (const [key, value] of values)
      query.set(
        key.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
        value,
      );
    return { ok: true, body: await (await EvidenceClient.connect(options)).recent(query) };
  }
  if (verb === "list") {
    const { positional, values } = flags(rest, ["--issue", "--commit"]);
    const issueKey = values.get("--issue");
    const commit = values.get("--commit");
    if (positional.length || (issueKey === undefined) === (commit === undefined))
      throw new Error(EVIDENCE_USAGE);
    const records = await evidenceList(issueKey === undefined ? { commit: commit! } : { issueKey }, options);
    return { ok: true, body: { records } };
  }
  if (verb === "receipt" && rest.length === 1) {
    const receipt = await evidenceReceipt(rest[0]!, options);
    return receipt === undefined
      ? { ok: false, body: { receiptId: rest[0], error: "unknown_receipt" } }
      : { ok: true, body: receipt };
  }
  throw new Error(EVIDENCE_USAGE);
}

/** MCP projection of the same commands, served locally by `clankie mcp` so paths resolve where the harness runs. */
export const EVIDENCE_TOOLS = [
  {
    name: "evidence_push",
    description:
      "Push a folder's evidence (media, and other non-Markdown files of 16 KiB or more) under an evidence root such as docs/testing to Clankie's evidence store. " +
      "Uploads only missing blobs, writes the folder's sorted evidence.json manifest of clankie://evidence links, and moves the raw files into .local/evidence/. " +
      "Commit only the README and evidence.json. Refuses outside the evidence roots.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Folder or file, relative to the working directory (default .).",
        },
        issue: { type: "string", description: "Issue key the evidence belongs to, e.g. VUH-1903." },
        caption: { type: "string", description: "Caption kept in the private record, not in git." },
      },
    },
  },
  {
    name: "evidence_fetch",
    description:
      "Download the objects listed by evidence.json manifests at or under a path into .local/evidence/<folder>/, verifying each sha256. Names every failure.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Folder relative to the working directory (default .)." },
      },
    },
  },
  {
    name: "evidence_list",
    description: "List evidence records by issue key or by commit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        issue: { type: "string", description: "Issue key." },
        commit: { type: "string", description: "Full commit SHA the evidence was produced against." },
      },
    },
  },
];

export function isEvidenceTool(name: string): boolean {
  return EVIDENCE_TOOLS.some((tool) => tool.name === name);
}

export async function callEvidenceTool(
  name: string,
  args: Record<string, unknown>,
  options: EvidenceOptions,
): Promise<{ isError?: boolean; content: { type: "text"; text: string }[] }> {
  const text = (value: unknown, isError = false) => ({
    ...(isError ? { isError: true } : {}),
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  });
  const string = (key: string) =>
    typeof args[key] === "string" && args[key] ? (args[key] as string) : undefined;
  try {
    if (name === "evidence_push") {
      const issueKey = string("issue");
      const caption = string("caption");
      const path = string("path");
      const result = await evidencePush(
        {
          ...(path === undefined ? {} : { path }),
          ...(issueKey === undefined ? {} : { issueKey }),
          ...(caption === undefined ? {} : { caption }),
        },
        options,
      );
      return text(result, !result.ok);
    }
    if (name === "evidence_fetch") {
      const path = string("path");
      const result = await evidenceFetch(path === undefined ? {} : { path }, options);
      return text(result, !result.ok);
    }
    const issueKey = string("issue");
    const commit = string("commit");
    if ((issueKey === undefined) === (commit === undefined))
      return text("evidence_list needs exactly one of issue or commit", true);
    return text({
      records: await evidenceList(issueKey === undefined ? { commit: commit! } : { issueKey }, options),
    });
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}
