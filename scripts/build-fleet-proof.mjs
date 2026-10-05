import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Prepare off the request path. Installed releases contain the compiled helper. */
export async function buildFleetProof(destination = join(root, ".local/fleet-proof/native-process-proof")) {
  if (process.platform !== "darwin") return;
  const source = join(root, "integrations/fleet-proof/native-process-proof.c");
  const sourceHash = digest(await readFile(source));
  const flags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-mmacosx-version-min=14.0", "-lproc"];
  const buildHash = digest(JSON.stringify([sourceHash, process.arch, flags]));
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
    execFileSync("cc", [...flags, source, "-o", temporary], {
      timeout: 60_000,
      maxBuffer: 1_000_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
