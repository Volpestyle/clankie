import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("worker transcript support-bundle boundary", () => {
  it("excludes runner transcript projection files from the actual support archive", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const transcriptDirectory = resolve(root, "artifacts/runner/worker-transcripts");
    const sentinelPath = resolve(transcriptDirectory, "vuh-865-support-exclusion.ndjson");
    await mkdir(transcriptDirectory, { recursive: true });
    await writeFile(sentinelPath, "private-transcript-sentinel\n", { mode: 0o600 });
    let archive = "";
    try {
      const result = await execFileAsync(process.execPath, ["scripts/support-bundle.mjs"], { cwd: root });
      archive = result.stdout.trim();
      const listing = (await execFileAsync("tar", ["-tzf", archive])).stdout;
      expect(listing).not.toContain("worker-transcripts");
      expect(listing).not.toContain("vuh-865-support-exclusion");
      const readme = await readFile(resolve(archive.replace(/\.tar\.gz$/u, ""), "README.txt"), "utf8");
      expect(readme).toContain("raw provider transcripts are intentionally excluded");
    } finally {
      await rm(sentinelPath, { force: true });
      if (archive) {
        await rm(archive, { force: true });
        await rm(archive.replace(/\.tar\.gz$/u, ""), { recursive: true, force: true });
      }
    }
  });
});
