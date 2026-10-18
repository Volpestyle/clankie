import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createLocalAgentHost, piSessionRoots, type SeatLaunch } from "@clankie/agent-hosts";
import { findAgentSession } from "@clankie/agent-transcript";
import { z } from "zod";

/**
 * Oldest Pi release a live native hire has proved. The probe drives the
 * package's SDK build offline and cannot open the CLI bundle's interactive TUI
 * that a hire runs, so older releases are refused rather than inferred.
 */
const VALIDATED_FLOOR = "0.87.1";
const PROBE_RETRY_MS = 60_000;
// The checkout keeps this module in src/captain and the release bundles it into
// src; both keep integrations at the repository root.
const probeScript = [1, 2, 3, 4]
  .map((up) => join(import.meta.dirname, ...Array<string>(up).fill(".."), "integrations/pi-plugin/probe.mjs"))
  .find((path) => existsSync(path));
const probes = new Map<string, { readonly at: number; readonly result: Promise<void> }>();

/** A refusal the owner can act on: it names the installed release and why, never a credential. */
export class PiNativeRefusal extends Error {}
export interface PiNativeCapability {
  readonly executable: string;
  readonly cli: string;
  readonly sessionRoots: readonly string[];
  readonly saved?: { readonly sessionId: string; readonly path: string };
  verify(): Promise<void>;
  verifySession(sessionId: string, file: string, cwd: string): Promise<void>;
}

const Header = z.object({
  type: z.literal("session"),
  version: z.literal(3),
  id: z.string().uuid(),
  cwd: z.string(),
});
const fingerprint = async (path: string, hash: boolean) => {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || (hash && before.size > 16 * 1024 * 1024))
      throw new Error("Native Pi capability file unavailable");
    const digest = hash
      ? createHash("sha256")
          .update(await file.readFile())
          .digest("hex")
      : undefined;
    const after = await file.stat();
    const key = (info: typeof before) => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
    if (JSON.stringify(key(before)) !== JSON.stringify(key(after)))
      throw new Error("Native Pi capability changed during read");
    return { facts: key(after), digest };
  } finally {
    await file.close();
  }
};

/** Service-selected files and the digests they had when probed, held across allocation and every control admission. */
export async function holdPiCapabilityFiles(
  executable: string,
  files: Readonly<Record<string, string>>,
): Promise<() => Promise<void>> {
  const node = await fingerprint(executable, false);
  const pinned = await Promise.all(
    Object.entries(files).map(async ([path, expected]) => {
      const observed = await fingerprint(path, true);
      if (observed.digest !== expected)
        throw new Error("Selected Pi bundle changed after its supported capability probe");
      return { path, observed };
    }),
  );
  return async () => {
    if (JSON.stringify(await fingerprint(executable, false)) !== JSON.stringify(node))
      throw new Error("Selected native Node executable changed");
    for (const { path, observed } of pinned)
      if (JSON.stringify(await fingerprint(path, true)) !== JSON.stringify(observed))
        throw new Error("Selected native Pi bundle changed");
  };
}

async function executableOnPath(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const path = await realpath(join(directory, name));
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* Continue executable lookup, without invoking candidate scripts. */
    }
  }
  throw new Error(`Native ${name} executable unavailable`);
}

const releaseParts = (version: string) =>
  /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/u.exec(version)?.slice(1, 4).map(Number);
function atLeastFloor(version: string): boolean {
  const found = releaseParts(version);
  const floor = releaseParts(VALIDATED_FLOOR)!;
  if (!found) return false;
  for (let index = 0; index < 3; index += 1)
    if (found[index] !== floor[index]) return found[index]! > floor[index]!;
  return true;
}

/** The CLI wrapper, its runtime and every chunk the runtime loads at startup. */
async function piBundleFiles(packageRoot: string, version: string): Promise<string[]> {
  const bundle = join(packageRoot, "dist/bundle");
  const read = (file: string) => readFile(join(bundle, file), "utf8").catch(() => "");
  const chunks = [...(await read("cli-runtime.js")).matchAll(/(?:from|import)\s*"\.\/(chunks\/[\w.-]+\.js)"/gu)];
  if (!(await read("cli.js")).includes('"./cli-runtime.js"') || !chunks.length)
    throw new PiNativeRefusal(`Native Pi ${version} has an unrecognized CLI bundle layout`);
  return [
    join(packageRoot, "package.json"),
    join(bundle, "cli.js"),
    join(bundle, "cli-runtime.js"),
    ...new Set(chunks.map((match) => join(bundle, match[1]!))),
  ];
}

/** Runs integrations/pi-plugin/probe.mjs once per installed release and Node, reusing a pass. */
function probeInstalledPi(executable: string, packageRoot: string, version: string, key: string) {
  const cached = probes.get(key);
  if (cached && Date.now() - cached.at < PROBE_RETRY_MS) return cached.result;
  const result = new Promise<void>((resolve, reject) => {
    const refuse = (reason: string) =>
      reject(new PiNativeRefusal(`Native Pi ${version} failed Clankie's capability probe: ${reason}`));
    if (!probeScript) return refuse("integrations/pi-plugin/probe.mjs is missing");
    // A clean environment: the probe needs no owner profile, key or proxy.
    execFile(
      executable,
      [probeScript, packageRoot],
      { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeout: 30_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        let outcome: { ok: boolean; reason?: string | undefined } | undefined;
        try {
          outcome = z
            .object({ ok: z.boolean(), reason: z.string().max(500).optional() })
            .parse(JSON.parse(stdout.trim().split("\n").at(-1)!));
        } catch {
          return refuse(error?.killed ? "timed out" : "no result");
        }
        if (outcome.ok) {
          // A pass holds until the installed files or Node change, which changes the key.
          probes.set(key, { at: Number.POSITIVE_INFINITY, result });
          return resolve();
        }
        refuse(outcome.reason ?? "unnamed failure");
      },
    );
  });
  probes.set(key, { at: Date.now(), result });
  return result;
}

/**
 * The Pi CLI this PATH selects and the native Node that runs it, refused with a
 * named reason unless native control supports that release: the expected layout,
 * at least the validated floor, and a passing capability probe of the surfaces a
 * hire uses. Discovery applies exactly this check; tests that need the installed
 * Pi skip on its refusal (VUH-2414). The returned digests were computed before the
 * probe ran, so a hire holds the same files the probe admitted.
 */
export async function supportedPiOnPath(env: Readonly<Record<string, string | undefined>>): Promise<{
  cli: string;
  packageRoot: string;
  executable: string;
  version: string;
  files: Readonly<Record<string, string>>;
}> {
  const cli = await executableOnPath("pi", env);
  const packageRoot = dirname(dirname(dirname(cli)));
  if (cli !== join(packageRoot, "dist/bundle/cli.js")) throw new Error("Unsupported Pi executable layout");
  const { version } = z
    .object({ name: z.literal("@earendil-works/pi-coding-agent"), version: z.string().max(100) })
    .parse(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")));
  if (!atLeastFloor(version))
    throw new PiNativeRefusal(
      `Native Pi ${version} is older than ${VALIDATED_FLOOR}, the oldest release proven with a live hire; update Pi`,
    );
  const executable = await executableOnPath("node", env);
  const nodeFile = await open(executable, "r");
  try {
    const magic = Buffer.alloc(4);
    await nodeFile.read(magic, 0, 4, 0);
    const nativeMagic =
      process.platform === "linux" ? ["7f454c46"] : ["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"];
    if (!nativeMagic.includes(magic.toString("hex")))
      throw new Error("Native Node must be a direct platform executable, not a launcher");
  } finally {
    await nodeFile.close();
  }
  const files = Object.fromEntries(
    await Promise.all(
      (await piBundleFiles(packageRoot, version)).map(
        async (path) => [path, (await fingerprint(path, true)).digest!] as const,
      ),
    ),
  );
  const node = await fingerprint(executable, false);
  await probeInstalledPi(executable, packageRoot, version, JSON.stringify([executable, node, files]));
  return { cli, packageRoot, executable, version, files };
}

export async function discoverPiNativeCapability(launch: SeatLaunch): Promise<PiNativeCapability> {
  if (!["darwin", "linux"].includes(process.platform))
    throw new Error("Native Pi control requires macOS or Linux");
  const env = { ...process.env, ...launch.env };
  const roots = piSessionRoots();
  if (JSON.stringify(piSessionRoots(env)) !== JSON.stringify(roots))
    throw new Error("Per-hire Pi profile differs from the active native transcript source");
  const { cli, executable, files } = await supportedPiOnPath(env);
  const verify = await holdPiCapabilityFiles(executable, files);
  const verifySession = createPiSessionVerifier(roots, launch.resumeSessionId !== undefined);
  let saved: PiNativeCapability["saved"];
  if (launch.resumeSessionId !== undefined) {
    if (!z.string().uuid().safeParse(launch.resumeSessionId).success)
      throw new Error("Exact Pi UUID required");
    const source = createLocalAgentHost({ piSessionRoots: roots, codexHomes: [] });
    const file = await findAgentSession(source, launch.resumeSessionId);
    if (file.harness !== "pi") throw new Error("Resume source is not a native Pi session");
    const path = await realpath(file.path);
    if (!(await stat(path)).isFile()) throw new Error("Saved native Pi file unavailable");
    await verifySession(launch.resumeSessionId, path, await realpath(launch.cwd));
    saved = { sessionId: launch.resumeSessionId, path };
  }
  await verify();
  return { executable, cli, sessionRoots: roots, ...(saved ? { saved } : {}), verify, verifySession };
}

/** Exact native file/header binding; absent fresh files remain live metadata only. */
export function createPiSessionVerifier(
  roots: readonly string[],
  requireSaved: boolean,
): PiNativeCapability["verifySession"] {
  let nativeFileIdentity: string | undefined;
  return async (id: string, file: string, cwd: string) => {
    if (!z.string().uuid().safeParse(id).success || !file.endsWith(`_${id}.jsonl`) || !isAbsolute(file))
      throw new Error("Native Pi session path does not match its UUID");
    // A fresh native file is buffered. Verify its actual directory first, and
    // validate a persisted header whenever present without creating a file.
    const parent = await realpath(dirname(file));
    const canonical = join(parent, file.slice(file.lastIndexOf(sep) + 1));
    if (canonical !== file) throw new Error("Native Pi session path must be canonical");
    let confined = false;
    for (const root of roots) {
      const resolved = await realpath(root);
      const rel = relative(resolved, file);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) confined = true;
    }
    if (!confined) throw new Error("Native Pi session escaped its effective profile");
    const source = createLocalAgentHost({ piSessionRoots: roots, codexHomes: [] });
    try {
      if ((await realpath(file)) !== file) throw new Error("Native Pi file was redirected");
      const before = await stat(file);
      const identity = JSON.stringify([before.dev, before.ino]);
      if (nativeFileIdentity !== undefined && nativeFileIdentity !== identity)
        throw new Error("Original native Pi file was replaced");
      const { bytes } = await source.readBytes(file, 0, 16 * 1024);
      const header = Header.parse(JSON.parse(bytes.toString("utf8").split("\n")[0]!));
      if (header.id !== id || (await realpath(header.cwd)) !== cwd)
        throw new Error("Native Pi persisted header disagrees");
      const after = await stat(file);
      if (identity !== JSON.stringify([after.dev, after.ino]))
        throw new Error("Native Pi file changed during read");
      nativeFileIdentity = identity;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Only absent fresh files may use the held extension's live header facts.
      if (requireSaved || nativeFileIdentity !== undefined)
        throw new Error("Saved native Pi file disappeared");
    }
  };
}
