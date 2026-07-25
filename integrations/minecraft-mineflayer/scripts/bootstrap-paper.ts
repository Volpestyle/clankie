import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  paperCacheDirectory,
  PINNED_PAPER_BUILD,
  PINNED_PAPER_DOWNLOAD_URL,
  PINNED_PAPER_JAR_NAME,
  PINNED_PAPER_JAR_SIZE,
  PINNED_PAPER_SHA256,
  PINNED_PAPER_VERSION,
  pinnedPaperJarPath,
} from "../src/paper-build.ts";

const cacheDirectory = paperCacheDirectory();
const targetPath = pinnedPaperJarPath();
const temporaryPath = join(cacheDirectory, `.${PINNED_PAPER_JAR_NAME}.${randomUUID()}.tmp`);

await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
const cacheStat = await lstat(cacheDirectory);
if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
  throw new Error("Paper cache directory must be a real directory");
}

if (await verifiedExistingTarget(targetPath)) {
  emit("already_present");
  process.exit(0);
}

try {
  const response = await fetch(PINNED_PAPER_DOWNLOAD_URL, {
    headers: {
      "user-agent": "clankie-capability-proof/0.1 (https://github.com/Volpestyle/clankie)",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || response.url !== PINNED_PAPER_DOWNLOAD_URL) {
    throw new Error(`Pinned Paper download failed with HTTP ${String(response.status)}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (contentLength !== PINNED_PAPER_JAR_SIZE) {
    throw new Error("Pinned Paper download declared an unexpected size");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== PINNED_PAPER_JAR_SIZE || sha256(bytes) !== PINNED_PAPER_SHA256) {
    throw new Error("Pinned Paper download failed its published size or SHA-256 identity");
  }
  await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    await link(temporaryPath, targetPath);
  } catch (error) {
    if (!(await verifiedExistingTarget(targetPath))) throw error;
  }
  emit("downloaded");
} finally {
  await unlink(temporaryPath).catch(() => undefined);
}

async function verifiedExistingTarget(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Pinned Paper cache target must be a regular file");
    }
    if (stat.size !== PINNED_PAPER_JAR_SIZE) {
      throw new Error("Existing Paper cache target has an unexpected size");
    }
    const bytes = await readFile(path);
    if (sha256(bytes) !== PINNED_PAPER_SHA256) {
      throw new Error("Existing Paper cache target has an unexpected SHA-256");
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function emit(status: "already_present" | "downloaded"): void {
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status,
        paper: {
          version: PINNED_PAPER_VERSION,
          build: PINNED_PAPER_BUILD,
          jarPath: targetPath,
          sha256: PINNED_PAPER_SHA256,
        },
        eulaAcknowledged: false,
      },
      null,
      2,
    )}\n`,
  );
}
