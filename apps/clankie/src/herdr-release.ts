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

async function download(url: string, limit: number, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || response.body === null)
    throw new Error(`Herdr download failed: HTTP ${response.status}`);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new Error("Herdr download exceeded its size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
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
): Promise<string> {
  const asset = releaseAsset(manifest);
  const current = await readFile(destination).catch(() => undefined);
  if (current !== undefined && digest(current) === asset.sha256) return asset.version;
  const data = await download(asset.url, MAX_BINARY_BYTES, fetchImpl);
  if (digest(data) !== asset.sha256) throw new Error("Official Herdr checksum mismatch");
  await atomicWrite(destination, data, 0o700);
  return asset.version;
}

/** Stage official stable releases separately from the executable serving live workers. */
export async function refreshOfficialHerdr(
  root: string,
  fallback: string,
  fetchImpl: typeof fetch = fetch,
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
      (await download("https://herdr.dev/latest.json", 2 * 1024 * 1024, fetchImpl)).toString("utf8"),
    );
    const asset = releaseAsset(manifest);
    const path = join(root, "releases", asset.version, "herdr");
    await installHerdrRelease(path, manifest, fetchImpl);
    await atomicWrite(recordPath, JSON.stringify({ manifest, checkedAt: Date.now() }), 0o600);
    return path;
  } catch (error) {
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
