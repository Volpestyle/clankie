import { runEvidenceStorageCommand } from "./evidence-storage.ts";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
  evidenceIssueKeys,
  evidenceReadmeIssueKeys,
  type EvidenceManifest,
  type EvidenceReceipt,
  type EvidenceRecord,
} from "@clankie/protocol/evidence";
import { WorkConventionSchema } from "@clankie/protocol/work-items";
import {
  MANIFEST,
  MIRROR,
  evidenceRoots,
  exists,
  inside,
  posix,
  pushEvidence,
  refusal,
  repoRootOf,
  sha256File,
  type EvidencePushInput,
} from "../../../../integrations/claude-plugin/worker/bin/evidence-push.mjs";
import { commandHost } from "./io.ts";

export { evidenceRoots };

/**
 * `clankie evidence push|fetch|list|receipt` (ADR 0258). Paths resolve from the
 * working directory; nothing is configured per repository. The same functions
 * back the operator seat's `evidence_*` MCP tools.
 */
const EVIDENCE_USAGE = [
  "Usage: clankie evidence storage [status|local|s3 --bucket BUCKET --region REGION [--prefix PREFIX]]",
  "       clankie evidence push [PATH] [--issue KEY] [--caption TEXT]",
  "       clankie evidence fetch [PATH | clankie://evidence/sha256/HASH]",
  "       clankie evidence backfill --database SQLITE [--repo PATH] [--apply]",
  "       clankie evidence list --issue KEY | --commit SHA",
  "       clankie evidence list --recent [--project NAME] [--repo REPO] [--issue KEY] [--actor-kind KIND] [--actor-name NAME] [--media-type TYPE] [--since ISO] [--until ISO] [--cursor CURSOR] [--limit N]",
  "       clankie evidence receipt RECEIPT_ID",
].join("\n");

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

/**
 * The tracker team keys an inferred evidence key may carry: the convention's
 * Linear team, beside the built-in tracker's own `LOCAL-…` keys that every repo
 * accepts. No convention, or one without a team, infers only built-in keys (VUH-1997).
 */
export async function evidenceKeyTeams(repo: string): Promise<string[]> {
  const text = await readFile(join(repo, ".clankie", "tracking.json"), "utf8").catch(() => undefined);
  if (text === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  const parsed = WorkConventionSchema.safeParse(value);
  const team = parsed.success && parsed.data.backend === "linear" ? parsed.data.linear?.team : undefined;
  return team ? [team.replace(/[^A-Za-z0-9]/gu, "").toUpperCase()] : [];
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

/** Push through the operator credential; the shared walk infers keys with the protocol's rules. */
function evidencePush(input: EvidencePushInput, options: EvidenceOptions = {}) {
  return pushEvidence(input, {
    cwd: options.cwd ?? process.cwd(),
    client: () => EvidenceClient.connect(options),
    issueKeys: {
      teams: evidenceKeyTeams,
      fromText: evidenceIssueKeys,
      fromReadme: evidenceReadmeIssueKeys,
    },
  });
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
  for (const folder of new Set(manifestFolders)) {
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

const EVIDENCE_LINK = /^clankie:\/\/evidence\/sha256\/([0-9a-f]{64})$/u;

/** The extension an object's leading bytes name, so a harness opens it as what it is. */
function sniffExtension(head: Buffer): string {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return ".png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return ".jpg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return ".gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP")
    return ".webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    if (["heic", "heix", "mif1", "msf1"].includes(brand)) return ".heic";
    return brand === "qt  " ? ".mov" : ".mp4";
  }
  return "";
}

/**
 * One `clankie://evidence/sha256/HASH` object, as an issue file or a drop links it,
 * downloaded into the repo's `.local/evidence/sha256/` (ignored) and verified.
 */
async function evidenceFetchLink(link: string, options: EvidenceOptions = {}): Promise<EvidenceFetchResult> {
  const sha = EVIDENCE_LINK.exec(link)![1]!;
  const cwd = options.cwd ?? process.cwd();
  const repo = await repoRootOf(cwd);
  const folder = join(repo, MIRROR, "sha256");
  const named = posix(relative(repo, join(folder, sha)));
  const already = (await readdir(folder).catch(() => [] as string[])).find(
    (name) => name === sha || name.startsWith(`${sha}.`),
  );
  const done = (fetched: string[], present: string[], failures: Failure[]): EvidenceFetchResult => ({
    ok: failures.length === 0,
    fetched,
    present,
    failures,
    summary: [
      ...[...fetched, ...present].map(
        (path) => `${fetched.includes(path) ? "Fetched" : "Already present"}: ${join(repo, path)}`,
      ),
      ...failures.map((failure) => `failed ${failure.path}: ${failure.reason}`),
    ].join("\n"),
  });
  if (already !== undefined && (await sha256File(join(folder, already))) === sha)
    return done([], [posix(relative(repo, join(folder, already)))], []);
  await mkdir(folder, { recursive: true });
  const partial = join(folder, `${sha}.${process.pid}.part`);
  try {
    const client = await EvidenceClient.connect({ ...options, cwd });
    const signed = await client.signedFetch(sha);
    await client.download(signed.url, partial);
    if ((await stat(partial)).size !== signed.size) throw new Error("size does not match the store");
    if ((await sha256File(partial)) !== sha) throw new Error("sha256 does not match");
    const head = Buffer.alloc(16);
    const handle = await open(partial, "r");
    try {
      await handle.read(head, 0, 16, 0);
    } finally {
      await handle.close();
    }
    const destination = join(folder, `${sha}${sniffExtension(head)}`);
    await rename(partial, destination);
    return done([posix(relative(repo, destination))], [], []);
  } catch (error) {
    return done([], [], [{ path: named, reason: error instanceof Error ? error.message : String(error) }]);
  } finally {
    await rm(partial, { force: true });
  }
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
  if (verb === "storage") return { ok: true, body: await runEvidenceStorageCommand(rest, options) };
  if (verb === "backfill") {
    const apply = rest.includes("--apply");
    if (rest.filter((arg) => arg === "--apply").length > 1) throw new Error(EVIDENCE_USAGE);
    const { positional, values } = flags(
      rest.filter((arg) => arg !== "--apply"),
      ["--database", "--repo"],
    );
    if (positional.length || !values.get("--database")) throw new Error(EVIDENCE_USAGE);
    const { evidenceBackfill } = await import("./evidence-backfill.ts");
    const result = await evidenceBackfill({
      database: values.get("--database")!,
      repo: values.get("--repo") ?? options.cwd ?? process.cwd(),
      apply,
    });
    stderr.write(`${result.summary}\n`);
    return { ok: true, body: result };
  }
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
    const result =
      positional[0] !== undefined && EVIDENCE_LINK.test(positional[0])
        ? await evidenceFetchLink(positional[0], options)
        : await evidenceFetch(positional[0] === undefined ? {} : { path: positional[0] }, options);
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
      "Commit only the README and evidence.json. Refuses outside the evidence roots. When issue is omitted, infer from branch, worktree directory, then folder README; reports the source.",
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
      "Download the objects listed by evidence.json manifests at or under a path into .local/evidence/<folder>/, verifying each sha256. Names every failure. " +
      "Given one clankie://evidence/sha256/HASH link instead (as an issue file's Evidence line or a drop carries), downloads that object into .local/evidence/sha256/ and names the file, so it can be opened.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description:
            "Folder relative to the working directory (default .), or one clankie://evidence/sha256/HASH link.",
        },
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
      const result =
        path !== undefined && EVIDENCE_LINK.test(path)
          ? await evidenceFetchLink(path, options)
          : await evidenceFetch(path === undefined ? {} : { path }, options);
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
