/** One app transaction shared by the release installer and release updater. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { releaseUrl } from "./release-source.ts";

const exec = promisify(execFile);
interface MacAppPin {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}
export interface MacAppTransaction {
  readonly path: string;
  readonly changed: boolean;
  activate(): void;
  rollback(): void;
  finish(): void;
}
function macAppPin(root: string): MacAppPin | null {
  const path = join(root, "scripts/release/mac-app.json");
  if (!existsSync(path)) return null; // Older runtime releases predate the companion.
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (value.schemaVersion !== 1) throw Error("Invalid Mac app pin");
  if (value.app === null) return null; // No signed, published artifact approved yet.
  const pin = value.app;
  if (
    !pin ||
    typeof pin.version !== "string" ||
    !/^v\d+\.\d+\.\d+([-.][A-Za-z0-9.]+)?$/u.test(pin.version) ||
    typeof pin.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(pin.sha256)
  )
    throw Error("Invalid Mac app pin");
  return { version: pin.version, sha256: pin.sha256, url: releaseUrl(pin.url) };
}

/** Download and validate before changing either the existing app or the runtime. */
export async function prepareMacApp(
  root: string,
  installRoot: string,
  options: {
    readonly target: string;
    readonly applicationsDirectory?: string | undefined;
    readonly fetchImpl?: typeof fetch | undefined;
  },
): Promise<MacAppTransaction | null> {
  if (options.target !== "darwin-arm64") return null;
  const policy = join(installRoot, "app-policy.json");
  if (existsSync(policy) && JSON.parse(readFileSync(policy, "utf8")).disabled === true) return null;
  const pin = macAppPin(root);
  if (!pin) return null;
  const directory = options.applicationsDirectory ?? "/Applications";
  await mkdir(directory, { recursive: true });
  const path = join(directory, "Clankie.app");
  const marker = join(installRoot, "app-install.json");
  const previous = existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
  const installed = previous ? JSON.parse(previous) : undefined;
  if (existsSync(path) && !lstatSync(path).isDirectory())
    throw Error("Mac app destination is not a regular bundle directory");
  if (
    existsSync(path) &&
    installed?.sha256 === pin.sha256 &&
    installed?.version === pin.version &&
    installed?.url === pin.url &&
    installed?.path === path
  )
    return { path, changed: false, activate() {}, rollback() {}, finish() {} };
  if (existsSync(path) && installed?.path !== path)
    throw Error("Refusing to replace an unmanaged Clankie.app");
  const lock = join(directory, ".clankie-app-install.lock");
  await mkdir(lock); // An uncertain/crashed transaction stays held for inspection.
  let temporary = "";
  try {
    temporary = await mkdtemp(join(directory, ".clankie-app-"));
    const response = await (options.fetchImpl ?? fetch)(pin.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) throw Error("Mac app download failed");
    const archivePath = join(temporary, "app.tar.gz");
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archivePath, { flags: "wx" }));
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
    if (hash.digest("hex") !== pin.sha256) throw Error("Mac app checksum does not match");
    const { stdout } = await exec("tar", ["-tzf", archivePath], { maxBuffer: 16 * 1024 * 1024 });
    for (const entry of stdout.split("\n").filter(Boolean))
      if (!/^Clankie\.app(\/|$)/u.test(entry) || /(^|\/)\.\.(\/|$)/u.test(entry))
        throw Error("Unsafe Mac app archive");
    await exec("tar", ["-xzf", archivePath, "-C", temporary]);
    const staged = join(temporary, "Clankie.app");
    if (!lstatSync(staged).isDirectory()) throw Error("Invalid Mac app bundle");
    const canonical = await realpath(staged);
    const inspect = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const resolved = await realpath(file);
          if (!resolved.startsWith(canonical + sep)) throw Error("Mac app link escapes bundle");
        } else if (entry.isDirectory()) await inspect(file);
        else if (!entry.isFile()) throw Error("Invalid Mac app entry");
      }
    };
    await inspect(staged);
    if (
      !lstatSync(join(staged, "Contents/Info.plist")).isFile() ||
      !lstatSync(join(staged, "Contents/MacOS")).isDirectory()
    )
      throw Error("Invalid Mac app bundle");
    const backup = join(temporary, "previous.app");
    let active = false;
    const cleanup = () => {
      rmSync(temporary, { recursive: true, force: true });
      rmSync(lock, { recursive: true });
    };
    return {
      path,
      changed: true,
      activate() {
        if (active) throw Error("Mac app already activated");
        if (existsSync(path)) renameSync(path, backup);
        try {
          renameSync(staged, path);
          active = true;
          const pending = join(temporary, "marker.json");
          writeFileSync(pending, JSON.stringify({ ...pin, path }) + "\n");
          renameSync(pending, marker);
        } catch (error) {
          if (active) rmSync(path, { recursive: true });
          if (existsSync(backup)) renameSync(backup, path);
          active = false;
          throw error;
        }
      },
      rollback() {
        if (active) {
          rmSync(path, { recursive: true });
          if (existsSync(backup)) renameSync(backup, path);
          if (previous === undefined) rmSync(marker, { force: true });
          else writeFileSync(marker, previous);
          active = false;
        }
        cleanup();
      },
      finish: cleanup,
    };
  } catch (error) {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    rmSync(lock, { recursive: true });
    throw error;
  }
}

/** Pairing capability stays in the existing private handoff, never installer output or argv. */
export async function launchMacApp(root: string, path: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await exec(join(root, "bin/clankie"), ["pair", "--local-companion", "--json"], {
      env,
      timeout: 60_000,
    });
    const receipt = JSON.parse(stdout);
    if (receipt.ok !== true || receipt.localCompanion !== true) return false;
    await exec("open", [path], { env, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
