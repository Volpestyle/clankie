import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { integrationEnvironment, ownerPath } from "../src/integrate-environment.ts";
import { discoverPiNativeCapability } from "../src/captain/pi-native-capability.ts";

/**
 * The integrate queue's sandbox PATH (VUH-2057). The service runs under pnpm,
 * which prepends the pinned checkout's `node_modules/.bin` (with the bundled Pi
 * SDK's `pi` shim) once per relaunch; a batch inherited that and resolved `pi`
 * to the shim, so pi-worker-fleet failed with "Unsupported Pi executable
 * layout" in every batch that selected it. The sandbox must resolve the
 * owner's own tools.
 */
const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root() {
  const directory = await mkdtemp(join(tmpdir(), "clankie-integrate-env-"));
  roots.push(directory);
  return directory;
}

/** PATH as `ps` showed the live service's on 2026-10-10: pnpm's entries, repeated, before the owner's own. */
function servicePath(pinned: string, owner: string): string {
  const injected = [
    join(pinned, "apps/clankie/node_modules/.bin"),
    join(pinned, "pnpm/dist/node-gyp-bin"),
    join(pinned, "node_modules/.bin"),
  ];
  return [...injected, ...injected, ...injected, owner, ...(originalPath ?? "").split(delimiter)].join(
    delimiter,
  );
}

const resolve = (env: NodeJS.ProcessEnv, command: string) =>
  execFileSync("/bin/sh", ["-c", `command -v ${command}`], { env, encoding: "utf8" }).trim();

it.skipIf(process.platform === "win32")(
  "resolves the owner's tools, not the service's injected node_modules/.bin, and keeps the owner's order",
  async () => {
    const base = await root();
    const pinned = join(base, "pinned"),
      owner = join(base, "owner-bin");
    for (const directory of [join(pinned, "apps/clankie/node_modules/.bin"), owner]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "pi"), "#!/bin/sh\nexit 0\n");
      await chmod(join(directory, "pi"), 0o755);
    }
    process.env.PATH = servicePath(pinned, owner);
    // What the queue did before: the pinned SDK's shim first.
    expect(resolve({ PATH: process.env.PATH }, "pi")).toBe(join(pinned, "apps/clankie/node_modules/.bin/pi"));
    const env = await integrationEnvironment(join(base, "batch"));
    expect(resolve(env, "pi")).toBe(join(owner, "pi"));
    const entries = env.PATH!.split(delimiter);
    expect(entries.some((entry) => entry.includes(pinned))).toBe(false);
    expect(new Set(entries).size).toBe(entries.length);
    expect(entries.indexOf(owner)).toBeLessThan(entries.indexOf("/usr/bin"));
    expect(ownerPath(undefined)).toBeUndefined();
  },
);

const ownerPi = (originalPath ?? "")
  .split(delimiter)
  .filter((entry) => ownerPath(entry) === entry)
  .some((entry) => {
    try {
      execFileSync("/bin/test", ["-x", join(entry, "pi")]);
      return true;
    } catch {
      return false;
    }
  });

// The real thing: the installed Pi passes native capability discovery from the
// sandbox, even when the service's PATH leads with a bundled Pi SDK shim.
it.skipIf(!ownerPi || !["darwin", "linux"].includes(process.platform))(
  "a batch sandbox discovers the owner's supported native Pi through the service's PATH",
  async () => {
    const base = await root();
    const pinned = join(base, "pinned");
    await mkdir(join(pinned, "apps/clankie/node_modules/.bin"), { recursive: true });
    await writeFile(join(pinned, "apps/clankie/node_modules/.bin/pi"), "#!/bin/sh\nexit 0\n");
    await chmod(join(pinned, "apps/clankie/node_modules/.bin/pi"), 0o755);
    process.env.PATH = servicePath(pinned, "/nonexistent");
    await expect(
      discoverPiNativeCapability({ harness: "pi", cwd: base, brief: "", env: {} }),
    ).rejects.toThrow("Unsupported Pi executable layout");
    const env = await integrationEnvironment(join(base, "batch"));
    const capability = await discoverPiNativeCapability({
      harness: "pi",
      cwd: base,
      brief: "",
      env: { PATH: env.PATH! },
    });
    expect(capability.cli).toMatch(/[\\/]dist[\\/]bundle[\\/]cli\.js$/u);
  },
);
