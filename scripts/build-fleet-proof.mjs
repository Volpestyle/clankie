import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");

function toolchainFailure(phase, error, timeoutMs) {
  const timedOut = error?.code === "ETIMEDOUT";
  return new Error(
    `Native fleet proof ${phase} failed${timedOut ? `: did not finish within ${timeoutMs / 1000}s` : ""}. ` +
      "Check the selected Xcode/Command Line Tools with xcode-select -p and xcrun --no-cache --find clang; " +
      "resolve any toolchain installation or license problem on this runner before retrying.",
    { cause: error },
  );
}

function selectedDarwinToolchain() {
  try {
    const discover = (...args) =>
      execFileSync("/usr/bin/xcrun", ["--no-cache", ...args], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 1_000_000,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const compiler = discover("--find", "clang");
    const sdk = discover("--show-sdk-path");
    if (!isAbsolute(compiler) || !isAbsolute(sdk)) throw new Error("Developer tool paths must be absolute");
    return { compiler, sdk };
  } catch (error) {
    throw toolchainFailure("toolchain discovery", error, 10_000);
  }
}

/** Prepare off the request path. Installed releases contain the compiled helper. */
export async function buildFleetProof(destination = join(root, ".local/fleet-proof/native-process-proof")) {
  if (!["darwin", "linux"].includes(process.platform)) return;
  const linux = process.platform === "linux";
  const source = join(
    root,
    "integrations/fleet-proof",
    linux ? "linux-process-proof.py" : "native-process-proof.c",
  );
  const sourceHash = digest(await readFile(source));
  const flags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0", "-lproc"];
  const buildHash = digest(
    JSON.stringify([
      sourceHash,
      process.platform,
      process.arch,
      linux ? [] : [...flags, "direct-selected-toolchain-v1"],
    ]),
  );
  const metadataPath = `${destination}.json`;
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata.buildHash === buildHash && metadata.binaryHash === digest(await readFile(destination)))
      return destination;
  } catch {
    // Missing/stale/incomplete preparation: compile a new owned artifact.
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const metadataTemporary = `${metadataPath}.${randomUUID()}.tmp`;
  try {
    if (linux) await writeFile(temporary, await readFile(source), { flag: "wx" });
    else {
      // /usr/bin/cc is a developer-tool shim. Resolve without xcrun's shared
      // lookup cache, then invoke the real compiler with its selected SDK.
      const { compiler, sdk } = selectedDarwinToolchain();
      try {
        execFileSync(compiler, [...flags, "-isysroot", sdk, source, "-o", temporary], {
          timeout: 60_000,
          maxBuffer: 1_000_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        throw toolchainFailure("compilation", error, 60_000);
      }
    }
    await chmod(temporary, 0o755);
    const binaryHash = digest(await readFile(temporary));
    await writeFile(metadataTemporary, `${JSON.stringify({ buildHash, binaryHash })}\n`, { flag: "wx" });
    await rename(temporary, destination);
    await rename(metadataTemporary, metadataPath);
    return destination;
  } finally {
    await rm(temporary, { force: true });
    await rm(metadataTemporary, { force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const destination = await buildFleetProof();
  if (destination !== undefined) process.stdout.write(`Native fleet proof ready: ${destination}\n`);
}
