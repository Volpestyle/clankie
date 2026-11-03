import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { download, installHerdrRelease } from "../apps/clankie/src/herdr-release.ts";

const root = resolve(import.meta.dirname, "..");
export const herdrPin = JSON.parse(await readFile(join(root, "scripts/release/herdr.json"), "utf8"));
export const herdrSource = join(root, ".data/herdr", herdrPin.revision);

export async function buildHerdr(destination = join(root, ".data/herdr/bin/herdr")) {
  await mkdir(herdrSource, { recursive: true });
  const url = `${herdrPin.repository.replace("github.com", "codeload.github.com")}/tar.gz/${herdrPin.revision}`;
  // Both downloads cross the network on every CI run; retry a slow one (#628).
  const archive = await download(url, 256 * 1024 * 1024, fetch, 3);
  if (createHash("sha256").update(archive).digest("hex") !== herdrPin.sha256) {
    throw new Error("Herdr source checksum mismatch");
  }
  const archivePath = join(herdrSource, "source.tar.gz");
  await writeFile(archivePath, archive);
  // Retain the exact official source for the release license inventory.
  execFileSync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", herdrSource]);
  await rm(archivePath);
  await installHerdrRelease(destination, herdrPin.release, fetch, 3);
  process.stdout.write(`Herdr ${herdrPin.revision}: ${destination}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await buildHerdr();
}
