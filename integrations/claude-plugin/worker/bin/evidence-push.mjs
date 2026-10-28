import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

// `clankie evidence push` (ADR 0258), shared by Clankie's CLI and the worker
// plugin on a linked machine, which has only Node (VUH-2923). The caller brings
// the client: the operator credential on Clankie's own machine, or the pane's
// fleet link, which carries the bytes to the service. Either way the bytes are
// hashed here and the store refuses any blob whose sha256 differs.

/** Repository-relative evidence roots (ADR 0258). Only files under these ever move. */
const DEFAULT_EVIDENCE_ROOTS = ["docs/testing"];
const EVIDENCE_CONFIG = join(".clankie", "evidence.json");
export const MANIFEST = "evidence.json";
export const MIRROR = join(".local", "evidence");
/** Non-media files below this stay readable in git. */
const RAW_MIN_BYTES = 16 * 1024;
const MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};
const RAW_TYPES = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".log": "text/plain",
  ".txt": "text/plain",
};
const SHA256 = /^[0-9a-f]{64}$/u;

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

export async function repoRootOf(cwd) {
  try {
    return await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`${cwd} is not inside a git repository`);
  }
}

export async function evidenceRoots(repo) {
  try {
    const parsed = JSON.parse(await readFile(join(repo, EVIDENCE_CONFIG), "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.roots) ||
      !parsed.roots.length ||
      parsed.roots.some(
        (root) =>
          typeof root !== "string" ||
          root.length === 0 ||
          isAbsolute(root) ||
          root.split(/[\\/]/u).includes(".."),
      )
    )
      throw new Error(`must contain a non-empty relative roots array`);
    return parsed.roots.map((root) => root.replaceAll("\\", "/").replace(/\/+$/u, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return DEFAULT_EVIDENCE_ROOTS;
    throw new Error(`Invalid ${EVIDENCE_CONFIG}: ${String(error)}`);
  }
}

export const posix = (path) => path.split(sep).join("/");

export async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function inside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function refusal(repoRelative, roots) {
  return new Error(
    `${repoRelative || "."} is outside the evidence roots (${roots.join(", ")}); ` +
      "push a folder inside one. Product assets stay in git.",
  );
}

/** The manifest contract (`EvidenceManifestSchema`): strict, so an unknown field is refused rather than dropped. */
function manifestOf(value) {
  const exact = (object, keys) =>
    object !== null &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).every((key) => keys.includes(key));
  if (!exact(value, ["version", "objects"]) || value.version !== 1 || !Array.isArray(value.objects))
    throw new Error("evidence.json is not a version 1 manifest");
  for (const object of value.objects)
    if (
      !exact(object, ["path", "size", "sha256", "url"]) ||
      typeof object.path !== "string" ||
      !object.path ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      typeof object.sha256 !== "string" ||
      !SHA256.test(object.sha256) ||
      typeof object.url !== "string"
    )
      throw new Error("evidence.json lists a malformed object");
  return value;
}

async function readManifest(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  return manifestOf(JSON.parse(text));
}

function serializeManifest(objects) {
  const sorted = [...objects].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return `${JSON.stringify({ version: 1, objects: sorted }, null, 2)}\n`;
}

/** Media of any size, or any other non-Markdown file of 16 KiB or more (ADR 0258). */
function evidenceKind(name, size) {
  const extension = extname(name).toLowerCase();
  if (name === MANIFEST || extension === ".md") return undefined;
  const media = MEDIA_TYPES[extension];
  if (media !== undefined) return media;
  return size >= RAW_MIN_BYTES ? (RAW_TYPES[extension] ?? "application/octet-stream") : undefined;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** The folder whose manifest lists `start`: the nearest with evidence.json, else with README.md, else `start`. */
async function manifestFolder(root, start) {
  for (const marker of [MANIFEST, "README.md"]) {
    for (let folder = start; inside(root, folder); folder = dirname(folder))
      if (await exists(join(folder, marker))) return folder;
  }
  return start;
}

/** A receipt as the store answers it; anything else is a failed call, never a record. */
function evidenceReceiptOf(value, sha256) {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof value.receiptId !== "string" ||
    !["applied", "pending", "refused"].includes(value.state) ||
    value.sha256 !== sha256 ||
    !Number.isSafeInteger(value.size) ||
    typeof value.url !== "string" ||
    !value.url.endsWith(`/${sha256}`) ||
    (value.state === "pending" && typeof value.uploadUrl !== "string")
  )
    throw new Error("The evidence store answered a malformed receipt");
  return value;
}

/**
 * Push a folder's evidence: upload only missing blobs, write its sorted
 * evidence.json of `clankie://evidence` links, and move the raw files into
 * .local/evidence/. `issueKeys` infers a missing key (branch, worktree
 * directory, then folder README); without it the caller must name the issue.
 */
export async function pushEvidence(input, { cwd = process.cwd(), client, issueKeys }) {
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
  // allow-swallowed-rejection -- A repository with no commit yet records none.
  const commit = await git(repo, ["rev-parse", "HEAD"]).catch(() => undefined);
  let issueKey = input.issueKey;
  let issueSource = issueKey === undefined ? undefined : "--issue";
  if (issueKey === undefined && issueKeys === undefined)
    throw new Error("Name the issue this evidence belongs to with --issue KEY.");
  if (issueKey === undefined) {
    const teams = await issueKeys.teams(repo);
    for (const [source, keys] of [
      // allow-swallowed-rejection -- A detached or unborn branch names no key; the next source is tried.
      ["branch", issueKeys.fromText(await git(repo, ["branch", "--show-current"]).catch(() => ""), teams)],
      ["worktree directory", issueKeys.fromText(repo.split(sep).at(-1) ?? "", teams)],
      [
        "folder README",
        // allow-swallowed-rejection -- A folder without a README names no key.
        issueKeys.fromReadme(await readFile(join(folder, "README.md"), "utf8").catch(() => ""), teams),
      ],
    ]) {
      if (keys.length) {
        issueKey = keys.join(" ");
        issueSource = source;
        break;
      }
    }
  }
  const issueSummary =
    issueKey === undefined ? "No issue key found." : `Issue ${issueKey} from ${issueSource}.`;

  const candidates = [];
  for (const file of isFile ? [target] : await walk(target)) {
    if (!inside(folder, file)) continue;
    const size = (await stat(file)).size;
    const contentType = evidenceKind(file.slice(file.lastIndexOf(sep) + 1), size);
    if (contentType !== undefined) candidates.push({ file, size, contentType });
  }

  const existing = await readManifest(manifestPath);
  const entries = new Map((existing?.objects ?? []).map((object) => [object.path, object]));
  const added = [];
  const changed = [];
  const failures = [];
  const receipts = [];
  const pushed = [];
  let uploaded = 0;
  const repoName =
    input.repo ??
    // allow-swallowed-rejection -- A checkout without an origin is named by its directory.
    (await git(repo, ["remote", "get-url", "origin"]).catch(() => repo.split(sep).at(-1)));
  const connected = candidates.length === 0 ? undefined : await client();
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
              issueKey ?? null,
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
        ...(issueKey === undefined ? {} : { issueKey }),
        ...(commit === undefined ? {} : { commit }),
        ...(input.caption === undefined ? {} : { caption: input.caption }),
      };
      let receipt;
      try {
        receipt = await connected.upload(request);
      } catch (error) {
        // An unanswered upload is reconciled by its receipt, never resent blind.
        const known = await connected.receipt(request.idempotencyKey);
        if (known === undefined) throw error;
        receipt = known;
      }
      for (let attempt = 0; receipt.state === "pending" && attempt < 2; attempt += 1) {
        try {
          receipt = await connected.putBlob(receipt.uploadUrl, candidate.file, candidate.size);
          uploaded += 1;
        } catch (error) {
          const known = await connected.receipt(request.idempotencyKey);
          if (known === undefined || attempt === 1) throw error;
          receipt = known;
        }
      }
      receipts.push({ path, receiptId: receipt.receiptId, state: receipt.state });
      if (receipt.state !== "applied") {
        failures.push({ path, reason: receipt.refusal ?? `upload ${receipt.state}` });
        continue;
      }
      // The store's own link for the bytes hashed here; a receipt for other bytes never lands.
      const url = evidenceReceiptOf(receipt, sha256).url;
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

  const moved = [];
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
          if (error?.code !== "EXDEV") throw error;
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
    ...(issueKey === undefined ? {} : { issueKey }),
    ...(issueSource === undefined ? {} : { issueSource }),
    summary: `${issueSummary}\n${summary}`,
  };
}

/** The evidence routes as a fleet pane reaches them (VUH-2923). */
const EVIDENCE_SEAT_ROUTE = "evidence-uploads";

/** The worker bridge's projection, for a harness whose pane has no `clankie` on PATH. */
export const EVIDENCE_PUSH_TOOL = {
  name: "evidence_push",
  description:
    "Push a folder's evidence (media, and other non-Markdown files of 16 KiB or more) under an evidence root such as docs/testing to Clankie's evidence store, over this pane's fleet link. " +
    "Uploads only missing blobs, writes the folder's sorted evidence.json manifest of clankie://evidence links, and moves the raw files into .local/evidence/. " +
    "Commit only the README and evidence.json. Refuses outside the evidence roots. The same as `clankie evidence push PATH --issue KEY`.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 4096,
        description: "Absolute path of the folder or file inside a checkout's evidence root.",
      },
      issue: { type: "string", minLength: 1, maxLength: 64, description: "Issue key, e.g. VUH-2923." },
      caption: {
        type: "string",
        maxLength: 4000,
        description: "Caption kept in the private record, not in git.",
      },
    },
    required: ["path", "issue"],
    additionalProperties: false,
  },
};

/** One evidence_push call; a refusal or partial push is an error result naming each failure. */
export async function callEvidencePush(args, client) {
  const text = (value, isError = false) => ({
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  });
  try {
    if (typeof args?.path !== "string" || !isAbsolute(args.path))
      return text("evidence_push needs the absolute path of an evidence folder or file.", true);
    if (typeof args.issue !== "string" || !args.issue.trim())
      return text("evidence_push needs the issue key the evidence belongs to.", true);
    const result = await pushEvidence(
      {
        path: args.path,
        issueKey: args.issue.trim(),
        ...(typeof args.caption === "string" && args.caption.trim() ? { caption: args.caption } : {}),
      },
      { cwd: dirname(args.path), client },
    );
    return text(result, !result.ok);
  } catch (error) {
    return text(error instanceof Error ? error.message : String(error), true);
  }
}
/** The service's own signed blob path; any other upload URL is refused before a byte leaves. */
const SIGNED_BLOB_PATH = /^\/v1\/evidence\/uploads\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]{16,128}\/blob$/u;

/**
 * An evidence client over one pane's fleet link. `request` is the pane's
 * proven seat route; the blob goes to the store's signed upload path on the
 * same link, which the signature, not the pane, authorizes. `headers` name the
 * pane to the link listener, which admits only its own fleet's panes.
 */
export function linkEvidenceClient({ origin, request, headers = {}, fetchImpl = fetch }) {
  const answer = async (what, response) => {
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const code = typeof body?.error === "string" ? body.error : `HTTP ${String(response.status)}`;
      throw new Error(`${what} failed: ${code}`);
    }
    return body;
  };
  return {
    async upload(body) {
      return evidenceReceiptOf(
        await answer(
          "Upload",
          await request(EVIDENCE_SEAT_ROUTE, "", { method: "POST", body: JSON.stringify(body) }),
        ),
        body.sha256,
      );
    },
    async receipt(receiptId) {
      const response = await request(EVIDENCE_SEAT_ROUTE, `/${encodeURIComponent(receiptId)}`);
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      const body = await answer("Receipt lookup", response);
      return evidenceReceiptOf(body, body?.sha256);
    },
    async putBlob(uploadUrl, file, size) {
      const target = new URL(uploadUrl, origin);
      if (target.origin !== new URL(origin).origin || !SIGNED_BLOB_PATH.test(target.pathname))
        throw new Error("The evidence store named an upload URL outside this fleet link");
      const response = await fetchImpl(target, {
        method: "PUT",
        redirect: "error",
        headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(size) },
        body: Readable.toWeb(createReadStream(file)),
        duplex: "half",
        signal: AbortSignal.timeout(30 * 60_000),
      });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (response.status !== 200 && response.status !== 422)
        throw new Error(
          `Blob upload failed: ${typeof body?.error === "string" ? body.error : `HTTP ${response.status}`}`,
        );
      return evidenceReceiptOf(body, body?.sha256);
    },
  };
}
