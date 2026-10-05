import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";
import { createLocalAgentHost, piSessionRoots, type SeatLaunch } from "@clankie/agent-hosts";
import { findAgentSession } from "@clankie/agent-transcript";
import { z } from "zod";

const PINNED = {
  "package.json": "627631b613ba4ca29eba8df793f5280fd20b19f01d73826e9ffda14c15def5dc",
  "dist/bundle/cli.js": "e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774",
  "dist/bundle/cli-runtime.js": "9ca136a7caa977d936aa789d7448a3dfb17851677ff5ac8c0dbcf23c31a02142",
  "dist/bundle/chunks/chunk-OJP47DM6.js": "81c81a21ec81e84200205f561687408ff5e3738fbbbb3c2a6c186b348d376020",
};
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

/** Service-selected files, held across allocation and every control admission. */
export async function holdPiCapabilityFiles(
  executable: string,
  files: Readonly<Record<string, string>>,
): Promise<() => Promise<void>> {
  const node = await fingerprint(executable, false);
  const pinned = await Promise.all(
    Object.entries(files).map(async ([path, expected]) => {
      const observed = await fingerprint(path, true);
      if (observed.digest !== expected)
        throw new Error("Selected Pi bundle does not match the supported native capability");
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

export async function discoverPiNativeCapability(launch: SeatLaunch): Promise<PiNativeCapability> {
  if (process.platform !== "darwin") throw new Error("Native Pi control currently requires macOS");
  const env = { ...process.env, ...launch.env };
  const roots = piSessionRoots();
  if (JSON.stringify(piSessionRoots(env)) !== JSON.stringify(roots))
    throw new Error("Per-hire Pi profile differs from the active native transcript source");
  const cli = await executableOnPath("pi", env);
  const executable = await executableOnPath("node", env);
  const packageRoot = dirname(dirname(dirname(cli)));
  if (cli !== join(packageRoot, "dist/bundle/cli.js")) throw new Error("Unsupported Pi executable layout");
  z.object({ name: z.literal("@earendil-works/pi-coding-agent"), version: z.literal("0.87.1") }).parse(
    JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
  );
  const nodeFile = await open(executable, "r");
  try {
    const magic = Buffer.alloc(4);
    await nodeFile.read(magic, 0, 4, 0);
    if (!["cffaedfe", "cefaedfe", "cafebabe", "bebafeca"].includes(magic.toString("hex")))
      throw new Error("Native Node must be a direct Mach-O executable, not a launcher");
  } finally {
    await nodeFile.close();
  }
  const verify = await holdPiCapabilityFiles(
    executable,
    Object.fromEntries(Object.entries(PINNED).map(([part, hash]) => [join(packageRoot, part), hash])),
  );
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
