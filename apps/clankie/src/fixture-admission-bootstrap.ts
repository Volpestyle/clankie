import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, realpath, lstat, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { nativeProcessStart, observeNativeBirth, fleetProcessHelper } from "./local-fleet-process.ts";
import { FileCredentialStore } from "@clankie/credential-broker";
import { FixtureDescriptorSchema, type FixtureDescriptor } from "./fixture-admission-contract.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function saveFixtureState(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}
async function trustedFile(path: string): Promise<Buffer> {
  if ((await realpath(path)) !== path) throw new Error("Fixture artifact alias refused");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0)
      throw new Error("Fixture artifact must be a trusted regular file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
/** Bootstrap failed and its launched child/root could not be proven gone; the root is preserved. */
export class FixtureCleanupUnresolvedError extends AggregateError {
  constructor(failure: unknown, cleanup: unknown) {
    super([failure, cleanup], "Fixture bootstrap cleanup unresolved; root preserved");
  }
}
export interface OwnedFixture {
  descriptor: FixtureDescriptor;
  capability: string;
  child: ChildProcess;
  assertCurrent(): Promise<boolean>;
  close(): Promise<void>;
}

/** Fixed host-selected build inputs, never paths or digests supplied by a requester. */
export async function createFixtureBootstrap(repoRoot: string, scratchParent: string) {
  // Pin at trusted host construction, before exposing routes, never from an admission request.
  // Updating a mutable manifest+artifact after this point cannot select new executable bytes.
  const prepared = await (async () => {
    const artifactRoot = join(repoRoot, ".local", "fixture-read");
    const manifestBytes = await trustedFile(join(artifactRoot, "manifest.json"));
    const metadata = JSON.parse(manifestBytes.toString("utf8")) as {
      artifactSha256: string;
      inputs: { path: string; sha256: string }[];
    };
    if (!Array.isArray(metadata.inputs) || metadata.inputs.length === 0)
      throw new Error("Missing trusted fixture inputs");
    for (const input of metadata.inputs) {
      if (
        input.path.startsWith("/") ||
        input.path.split("/").includes("..") ||
        digest(await trustedFile(join(repoRoot, input.path))) !== input.sha256
      )
        throw new Error("Trusted fixture input changed");
    }
    const artifact = await trustedFile(join(artifactRoot, "worker.mjs"));
    if (digest(artifact) !== metadata.artifactSha256) throw new Error("Fixture artifact digest mismatch");
    const helper = await trustedFile(fleetProcessHelper(repoRoot));
    return { artifactRoot, manifestHash: digest(manifestBytes), metadata, artifact, helper };
  })().catch(() => undefined);
  return async (callbackOrigin: string, expiresAt: number): Promise<OwnedFixture> => {
    // Absence at host construction refuses; later filesystem changes cannot bootstrap authority.
    if (!prepared) throw new Error("Trusted fixture artifact unavailable at host startup");
    const { artifactRoot, metadata, artifact, helper, manifestHash } = prepared;
    if (
      digest(await trustedFile(join(artifactRoot, "manifest.json"))) !== manifestHash ||
      digest(await trustedFile(join(artifactRoot, "worker.mjs"))) !== metadata.artifactSha256
    )
      throw new Error("Pinned fixture artifact changed after host startup");
    for (const input of metadata.inputs)
      if (digest(await trustedFile(join(repoRoot, input.path))) !== input.sha256)
        throw new Error("Pinned fixture source changed after host startup");
    // The caller controls none of the executable bytes, bootstrap secret, root or PID.
    await mkdir(scratchParent, { recursive: true, mode: 0o700 });
    const parent = await realpath(scratchParent);
    const parentStat = await lstat(parent, { bigint: true });
    if (
      !parentStat.isDirectory() ||
      parentStat.uid !== BigInt(process.getuid!()) ||
      (parentStat.mode & 0o077n) !== 0n
    )
      throw new Error("Private owned fixture parent required");
    const root = await realpath(await mkdtemp(join(parent, "native-fixture-")));
    await chmod(root, 0o700);
    const rootStat = await lstat(root, { bigint: true });
    const same = (a: typeof rootStat, b: typeof rootStat) =>
      a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
    const assertOwnedRoot = async () => {
      const [p, r] = await Promise.all([lstat(parent, { bigint: true }), lstat(root, { bigint: true })]);
      if (
        (await realpath(scratchParent)) !== parent ||
        (await realpath(root)) !== root ||
        !p.isDirectory() ||
        p.uid !== BigInt(process.getuid!()) ||
        (p.mode & 0o077n) !== 0n ||
        !r.isDirectory() ||
        !same(p, parentStat) ||
        !same(r, rootStat) ||
        r.uid !== BigInt(process.getuid!()) ||
        (r.mode & 0o077n) !== 0n
      )
        throw new Error("Owned fixture root identity changed; preserved");
    };
    const worker = join(root, "worker.mjs"),
      processHelper = join(root, "native-process-proof");
    saveFixtureState(join(root, "inputs.json"), {
      ...metadata,
      node: process.execPath,
      helperSha256: digest(helper),
    });
    const writeExclusive = async (path: string, bytes: Buffer, mode: number) => {
      const file = await open(path, "wx", mode);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    };
    await writeExclusive(worker, artifact, 0o600);
    await writeExclusive(processHelper, helper, 0o700);
    const capability = randomBytes(32).toString("base64url"),
      fixtureId = randomUUID();
    await new FileCredentialStore(join(root, "credentials.json")).set("clankie_fixture_admission_verifier", {
      type: "api",
      key: capability,
    });
    const child = spawn(process.execPath, [worker], {
      cwd: root,
      env: { HOME: root, XDG_CONFIG_HOME: root, CLANKIE_STATE: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let observedStart: string | undefined;
    let observedExit = false,
      removed = false;
    child.once("exit", () => {
      observedExit = true;
    });
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (removed) return Promise.resolve();
      return (closing ??= (async () => {
        if (!child.pid || !observedStart) throw new Error("Owned fixture lifetime unproven; root preserved");
        if (!observedExit) {
          const birth = await observeNativeBirth(child.pid);
          // A close event may have arrived during observation; never signal a reused PID.
          if (!observedExit) {
            const waitForExit = (milliseconds: number) =>
              new Promise<void>((resolve, reject) => {
                const done = () => {
                  clearTimeout(timeout);
                  resolve();
                };
                const timeout = setTimeout(() => {
                  child.off("exit", done);
                  reject(new Error("Owned fixture exit unproven; root preserved"));
                }, milliseconds);
                child.once("exit", done);
                if (observedExit) {
                  child.off("exit", done);
                  done();
                }
              });
            if (!birth || nativeProcessStart(birth) !== observedStart) {
              // Natural expiry can remove the kernel process before Node delivers exit.
              // Wait for this exact ChildProcess's exit; neither signal nor delete on absence alone.
              await waitForExit(2_000);
            } else {
              const exited = waitForExit(5_000);
              child.kill("SIGTERM");
              const timer = setTimeout(() => {
                void (async () => {
                  const current = await observeNativeBirth(child.pid!);
                  if (!observedExit && current && nativeProcessStart(current) === observedStart)
                    child.kill("SIGKILL");
                })().catch(() => {});
              }, 2_000);
              try {
                await exited;
              } finally {
                clearTimeout(timer);
              }
            }
          }
        }
        if (!observedExit || (child.exitCode === null && child.signalCode === null))
          throw new Error("Owned fixture exit unproven; root preserved");
        await assertOwnedRoot();
        // Refuse aliases/foreign entries instead of following them during recursive removal.
        const inspect = async (path: string): Promise<void> => {
          const s = await lstat(path);
          if (
            s.uid !== process.getuid!() ||
            s.isSymbolicLink() ||
            (!s.isFile() && !s.isDirectory()) ||
            (s.isFile() && s.nlink !== 1)
          )
            throw new Error("Unproven fixture contents; root preserved");
          if (s.isDirectory()) for (const entry of await readdir(path)) await inspect(join(path, entry));
        };
        await inspect(root);
        await assertOwnedRoot();
        await rm(root, { recursive: true });
        try {
          await lstat(root);
          throw new Error("Owned fixture root still present");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        removed = true;
      })().finally(() => {
        closing = undefined;
      }));
    };
    let errors = "";
    child.stderr!.on("data", (data: Buffer) => {
      errors = (errors + data.toString()).slice(-2000);
    });
    try {
      const ready = new Promise<{
        origin: string;
        relayOrigin: string;
        storeId: string;
        storeDigest: string;
      }>((resolve, reject) => {
        let body = "";
        child.stdout!.on("data", (data: Buffer) => {
          body += data.toString();
          if (body.length > 4096) return reject(new Error("Oversized fixture handshake"));
          if (body.includes("\n")) {
            try {
              resolve(JSON.parse(body.split("\n")[0]!));
            } catch {
              reject(new Error("Invalid fixture handshake"));
            }
          }
        });
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Fixture closed during bootstrap: ${errors}`)));
      });
      // Failures before the race below must not leave a later child exit as an unhandled rejection.
      ready.catch(() => {});
      if (!child.pid) throw new Error("Fixture child PID unavailable");
      const birth = await observeNativeBirth(child.pid);
      if (!birth) throw new Error("Fixture child lifetime unavailable");
      const start = nativeProcessStart(birth);
      observedStart = start;
      child.stdin!.end(
        JSON.stringify({ fixtureId, root, capability, callbackOrigin, processHelper, expiresAt }),
      );
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture bootstrap timed out")), 10_000);
        ready.finally(() => clearTimeout(timer)).catch(() => {});
      });
      const origins = await Promise.race([ready, timeout]);
      const descriptor = FixtureDescriptorSchema.parse({
        version: 1,
        fixtureId,
        root,
        ...origins,
        sourceDigest: metadata.artifactSha256,
        helperDigest: digest(helper),
        process: { pid: child.pid, start },
        expiresAt,
      });
      if (descriptor.origin === descriptor.relayOrigin)
        throw new Error("Fixture pair must have distinct origins");
      const assertCurrent = async () => {
        if (removed || observedExit) return false;
        await assertOwnedRoot();
        const current = await observeNativeBirth(child.pid!);
        return (
          child.exitCode === null &&
          child.signalCode === null &&
          !!current &&
          nativeProcessStart(current) === start &&
          digest(await trustedFile(worker)) === metadata.artifactSha256 &&
          digest(await trustedFile(processHelper)) === digest(helper)
        );
      };
      if (!(await assertCurrent())) throw new Error("Fixture bootstrap identity changed");
      saveFixtureState(join(root, "fixture.json"), descriptor);
      return { descriptor, capability, child, assertCurrent, close };
    } catch (error) {
      try {
        await close();
      } catch (cleanup) {
        throw new FixtureCleanupUnresolvedError(error, cleanup);
      }
      throw error;
    }
  };
}
