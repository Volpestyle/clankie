import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import pin from "../../../scripts/release/herdr.json" with { type: "json" };

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_BINARY_BYTES = 128 * 1024 * 1024;

function releaseAsset(manifest: unknown): { version: string; url: string; sha256: string } {
  if (typeof manifest !== "object" || manifest === null) throw new Error("Invalid Herdr release manifest");
  const { version, assets, sha256 } = manifest as Record<string, unknown>;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version))
    throw new Error("Expected an official stable Herdr version");
  const os = process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : undefined;
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  if (os === undefined || arch === undefined) throw new Error("No official Herdr asset for this platform");
  const target = `${os}-${arch}`;
  const url = `https://github.com/herdrdev/herdr/releases/download/v${version}/herdr-${target}`;
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const digest = record(sha256)[target];
  if (record(assets)[target] !== url || typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest))
    throw new Error("Herdr asset must have an official release URL and SHA-256 checksum");
  return { version, url, sha256: digest };
}

/** A failure another attempt may not repeat: a timeout, a dropped connection, 429 or 5xx. */
class TransientDownloadError extends Error {}

/**
 * How long one attempt may go without receiving a byte, and how long it may
 * take in all. A slow link that keeps delivering finishes; a stalled one is
 * abandoned and retried. One 60-second cap on the whole transfer failed every
 * attempt of a 22 MB asset below ~370 KB/s (#712).
 */
export interface DownloadTiming {
  stallMs?: number;
  totalMs?: number;
}
const STALL_MS = 60_000;
const TOTAL_MS = 15 * 60_000;

async function downloadOnce(
  url: string,
  limit: number,
  fetchImpl: typeof fetch,
  deadline?: AbortSignal,
  timing: DownloadTiming = {},
): Promise<Buffer> {
  const stallMs = timing.stallMs ?? STALL_MS;
  const stalled = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () =>
        stalled.abort(
          new DOMException(
            `no data for ${stallMs >= 1_000 ? `${Math.round(stallMs / 1_000)} s` : `${stallMs} ms`}`,
            "TimeoutError",
          ),
        ),
      stallMs,
    );
  };
  const signal = AbortSignal.any([
    stalled.signal,
    AbortSignal.timeout(timing.totalMs ?? TOTAL_MS),
    ...(deadline === undefined ? [] : [deadline]),
  ]);
  arm();
  try {
    return await receive(url, limit, fetchImpl, signal, arm);
  } finally {
    clearTimeout(stallTimer);
  }
}

async function receive(
  url: string,
  limit: number,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  progressed: () => void,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal });
  } catch (error) {
    throw new TransientDownloadError(error instanceof Error ? error.message : String(error));
  }
  progressed();
  if (!response.ok || response.body === null) {
    const message = `HTTP ${response.status}`;
    throw response.status === 429 || response.status >= 500
      ? new TransientDownloadError(message)
      : new Error(message);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read().catch((error: unknown) => {
        throw new TransientDownloadError(error instanceof Error ? error.message : String(error));
      });
      if (done) break;
      progressed();
      bytes += value.length;
      if (bytes > limit) throw new Error("Herdr download exceeded its size limit");
      chunks.push(value);
    }
  } finally {
    // On a stream that failed or timed out, cancel rejects with that same failure; letting it
    // through replaced the transient error above and the download was never retried (#628).
    // allow-swallowed-rejection -- the read's own error, already thrown, says what went wrong.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch `url` whole, retrying only transient failures with backoff (#628).
 * Every failure names the URL.
 */
export async function download(
  url: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
  attempts = 1,
  backoffMs = 2_000,
  /** The caller's own deadline across every attempt; once it passes, nothing is retried. */
  deadline?: AbortSignal,
  timing?: DownloadTiming,
): Promise<Buffer> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await downloadOnce(url, limit, fetchImpl, deadline, timing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!(error instanceof TransientDownloadError) || attempt >= attempts || deadline?.aborted === true)
        throw new Error(
          `Herdr download of ${url} failed${attempts > 1 ? ` after ${attempt} of ${attempts} attempts` : ""}: ${message}`,
          { cause: error },
        );
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
}

const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

async function atomicWrite(path: string, data: Buffer | string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Used by release packaging and the service; a bad download never replaces a good executable. */
export async function installHerdrRelease(
  destination: string,
  manifest: unknown,
  fetchImpl: typeof fetch = fetch,
  /** Builds retry a slow download; the service's own update check tries once. */
  attempts = 1,
  backoffMs?: number,
  deadline?: AbortSignal,
  timing?: DownloadTiming,
): Promise<string> {
  const asset = releaseAsset(manifest);
  const current = await readFile(destination).catch(() => undefined);
  if (current !== undefined && digest(current) === asset.sha256) return asset.version;
  const data = await download(asset.url, MAX_BINARY_BYTES, fetchImpl, attempts, backoffMs, deadline, timing);
  if (digest(data) !== asset.sha256) throw new Error("Official Herdr checksum mismatch");
  await atomicWrite(destination, data, 0o700);
  return asset.version;
}

/** Stage official stable releases separately from the executable serving live workers. */
export async function refreshOfficialHerdr(
  root: string,
  fallback: string,
  fetchImpl: typeof fetch = fetch,
  /**
   * Ends the check early: the service's start waits on it, and a slow release host must
   * not hold Clankie's health past its supervisor's patience (#609). Past it, the last
   * verified or packaged release serves, and the background check stages the new one.
   */
  deadline?: AbortSignal,
): Promise<string> {
  const recordPath = join(root, "releases/current.json");
  let cached: { manifest: unknown; checkedAt: number } | undefined;
  try {
    cached = JSON.parse(await readFile(recordPath, "utf8"));
    const asset = releaseAsset(cached?.manifest);
    const path = join(root, "releases", asset.version, "herdr");
    if (digest(await readFile(path)) !== asset.sha256) cached = undefined;
    else if (
      typeof cached?.checkedAt === "number" &&
      Date.now() - cached.checkedAt >= 0 &&
      Date.now() - cached.checkedAt < UPDATE_INTERVAL_MS
    )
      return path;
  } catch {
    cached = undefined;
  }
  try {
    const manifest: unknown = JSON.parse(
      (
        await download("https://herdr.dev/latest.json", 2 * 1024 * 1024, fetchImpl, 1, undefined, deadline)
      ).toString("utf8"),
    );
    const asset = releaseAsset(manifest);
    const path = join(root, "releases", asset.version, "herdr");
    await installHerdrRelease(path, manifest, fetchImpl, 1, undefined, deadline);
    await atomicWrite(recordPath, JSON.stringify({ manifest, checkedAt: Date.now() }), 0o600);
    return path;
  } catch (error) {
    if (deadline?.aborted === true)
      process.stderr.write(
        "herdr: the release check ran past its startup deadline; starting with the last verified release\n",
      );
    if (cached !== undefined) return join(root, "releases", releaseAsset(cached.manifest).version, "herdr");
    // Offline first launch can use only the checksum-verified official packaged release.
    const asset = releaseAsset(pin.release);
    const data = await readFile(fallback).catch(() => undefined);
    if (data === undefined || digest(data) !== asset.sha256) throw error;
    const path = join(root, "releases", asset.version, "herdr");
    await atomicWrite(path, data, 0o700);
    return path;
  }
}
