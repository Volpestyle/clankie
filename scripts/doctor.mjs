import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const results = [];

function result(name, required, ok, detail, remediation) {
  results.push({ name, required, ok, detail, remediation });
}

const major = Number(process.versions.node.split(".")[0]);
result(
  "Node.js",
  true,
  major >= 24,
  process.version,
  "Install Node 24+; this repo pins 24 in .nvmrc/.node-version.",
);

for (const check of [
  ["pnpm", true, ["--version"], "Enable Corepack and install pnpm 11.", "11.0"],
  ["git", true, ["--version"], "Install Git."],
  ["cargo", true, ["--version"], "Install the Rust 1.88+ toolchain to build @clankie/vox.", "1.88"],
  ["cmake", true, ["--version"], "Install CMake to build Vox's bundled native codecs."],
  ["swift", true, ["--version"], "Install Swift to build @clankie/menu-bar."],
  ["ffmpeg", false, ["-version"], "Required for Vox URL/video playback and VP8 decode."],
  ["yt-dlp", false, ["--version"], "Required for Vox playback from indirect media URLs."],
  ["herdr", false, ["--version"], "Optional: install Herdr as an external pane host."],
]) {
  const [command, required, args, remediation, minimumVersion] = check;
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5_000 });
    const detail = `${stdout}${stderr}`.trim().split("\n")[0] ?? "available";
    const detectedVersion = detail.match(/\d+(?:\.\d+)*/u)?.[0];
    const ok =
      minimumVersion === undefined ||
      (detectedVersion !== undefined && versionAtLeast(detectedVersion, minimumVersion));
    result(command, required, ok, detail, remediation);
  } catch {
    result(command, required, false, "not available", remediation);
  }
}

function versionAtLeast(detected, minimum) {
  const detectedParts = detected.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(detectedParts.length, minimumParts.length); index += 1) {
    const detectedPart = detectedParts[index] ?? 0;
    const minimumPart = minimumParts[index] ?? 0;
    if (detectedPart !== minimumPart) return detectedPart > minimumPart;
  }
  return true;
}

// Credentials live in the credential broker (macOS Keychain or a mode-0600 file
// store), never in env files. list() returns redacted summaries only.
try {
  const storePath = resolve(root, "packages/credential-broker/src/credential-store.ts");
  const { createDefaultCredentialStore } = await import(pathToFileURL(storePath).href);
  const listed = await createDefaultCredentialStore().list();
  const ids = Object.keys(listed).sort();
  result(
    "credential broker",
    false,
    ids.length > 0,
    ids.length > 0
      ? `${ids.length} stored: ${ids.join(", ")}`
      : "no credentials stored; the offline lab needs none",
    "Run `clankie`, then /auth to add provider keys or subscriptions (Discord bot token: provider `discord_bot`).",
  );
} catch (error) {
  const detail = error instanceof Error ? error.message.split("\n")[0] : "unknown error";
  result(
    "credential broker",
    false,
    false,
    `status unavailable (${detail})`,
    "Run pnpm install, then re-run pnpm doctor.",
  );
}

const shellFallback = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"].filter((name) => process.env[name]);
if (shellFallback.length > 0) {
  result(
    "provider env fallback",
    false,
    true,
    `exported in shell: ${shellFallback.join(", ")} (broker credentials take precedence)`,
    "",
  );
}

try {
  await access(join(homedir(), ".local", "bin", "clankie"));
  result("clankie launcher", false, true, "~/.local/bin/clankie installed", "");
} catch {
  result(
    "clankie launcher",
    false,
    false,
    "not installed",
    "Run pnpm cli:install to symlink the launcher into ~/.local/bin.",
  );
}

const width = Math.max(...results.map((entry) => entry.name.length));
for (const entry of results) {
  const marker = entry.ok ? "PASS" : entry.required ? "FAIL" : "SKIP";
  console.log(`${marker.padEnd(4)}  ${entry.name.padEnd(width)}  ${entry.detail}`);
  if (!entry.ok && entry.remediation) console.log(`      ${"".padEnd(width)}  ${entry.remediation}`);
}
const failed = results.filter((entry) => entry.required && !entry.ok);
if (failed.length) {
  console.error(`\nDoctor found ${failed.length} required issue(s).`);
  process.exitCode = 1;
} else {
  console.log("\nRequired development prerequisites are satisfied.");
}
