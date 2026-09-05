import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
export const herdrPin = JSON.parse(await readFile(join(root, "scripts/release/herdr.json"), "utf8"));
export const herdrSource = join(root, ".data/herdr", herdrPin.revision);

export async function buildHerdr(destination = join(root, ".data/herdr/bin/herdr")) {
  const zig = execFileSync("zig", ["version"], { encoding: "utf8" }).trim();
  if (zig !== herdrPin.zigVersion) throw new Error(`Herdr requires Zig ${herdrPin.zigVersion}; found ${zig}`);
  await mkdir(herdrSource, { recursive: true });
  const url = `${herdrPin.repository.replace("github.com", "codeload.github.com")}/tar.gz/${herdrPin.revision}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Herdr source download failed: ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== herdrPin.sha256) {
    throw new Error("Herdr source checksum mismatch");
  }
  const archivePath = join(herdrSource, "source.tar.gz");
  await writeFile(archivePath, archive);
  // Always restore tracked source from the verified archive; Cargo keeps its build cache.
  execFileSync("tar", ["-xzf", archivePath, "--strip-components=1", "-C", herdrSource]);
  await rm(archivePath);
  execFileSync("cargo", ["build", "--locked", "--release", "--bin", "herdr", "-j", "6"], {
    cwd: herdrSource,
    stdio: "inherit",
    env: { ...process.env, HERDR_BUILD_COMMIT: herdrPin.revision },
  });
  await mkdir(resolve(destination, ".."), { recursive: true });
  await copyFile(join(herdrSource, "target/release/herdr"), destination);
  await chmod(destination, 0o755);
  process.stdout.write(`Herdr ${herdrPin.revision}: ${destination}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await buildHerdr();
}
