import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverGrok } from "../src/captain/grok-seat-adapter.ts";
import { discoverPrimeAgent } from "../src/captain/prime-daemon.ts";
import { findExecutable } from "../src/find-executable.ts";

// #334: one PATH lookup for the harness discoveries, installer probes and Herdr
// Browser check. Real directories, symlinks and file modes on a real PATH; the
// harness CLIs are small scripts that only print their version.
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const scratch = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "find-executable-")));
  roots.push(root);
  return root;
};
const script = async (path: string, body: string, mode = 0o755) => {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, mode);
};

it("takes the first absolute PATH entry whose name resolves to an executable", async () => {
  const root = await scratch();
  const plain = join(root, "plain");
  const broken = join(root, "broken");
  const linked = join(root, "linked");
  const real = join(root, "real");
  const later = join(root, "later");
  for (const directory of [plain, broken, linked, real, later]) await mkdir(directory);
  await script(join(plain, "tool"), "exit 0", 0o644); // present but not executable
  await symlink(join(root, "missing"), join(broken, "tool")); // dangling symlink
  await script(join(real, "tool-1.2"), "exit 0");
  await symlink(join(real, "tool-1.2"), join(linked, "tool")); // versioned install behind a link
  await script(join(later, "tool"), "exit 0");
  // A relative entry would resolve against the service's own directory: skipped.
  const relative = join(root, "relative");
  await mkdir(relative);
  await script(join(relative, "tool"), "exit 0");
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const PATH = ["relative", plain, broken, linked, later].join(delimiter);
    expect(await findExecutable("tool", { PATH })).toEqual({
      path: join(linked, "tool"),
      resolved: join(real, "tool-1.2"),
    });
    expect(await findExecutable("tool", { PATH: ["relative", plain].join(delimiter) })).toBeUndefined();
    expect(await findExecutable("absent", { PATH })).toBeUndefined();
    expect(await findExecutable("tool", {})).toBeUndefined();
  } finally {
    process.chdir(cwd);
  }
});

it.skipIf(process.platform !== "darwin")(
  "Grok discovery keeps its PATH entry for Herdr and admits the version from the resolved file",
  async () => {
    const root = await scratch();
    const bin = join(root, "bin");
    const versions = join(root, "versions");
    await mkdir(bin);
    await mkdir(versions);
    await script(join(versions, "grok-1.0.50"), 'echo "grok 1.0.50 (fixture)"');
    await symlink(join(versions, "grok-1.0.50"), join(bin, "grok"));
    expect(await discoverGrok({ PATH: bin })).toEqual({ executable: join(bin, "grok"), version: "1.0.50" });
    await script(join(versions, "grok-1.0.50"), 'echo "grok 1.0.40 (fixture)"');
    await expect(discoverGrok({ PATH: bin })).rejects.toThrow(/1\.0\.40/u);
    await expect(discoverGrok({ PATH: join(root, "empty") })).rejects.toThrow(/Grok Build is unavailable/u);
  },
);

it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "Prime discovery follows the curl installer's shell launcher to the binary beside it",
  async () => {
    const root = await scratch();
    const bin = join(root, "bin");
    const share = join(root, "share", "prime-agent");
    await mkdir(bin);
    await mkdir(share, { recursive: true });
    await script(join(share, "prime-agent"), 'echo "0.10.3"');
    await script(join(bin, "prime-agent"), `exec "${join(share, "prime-agent")}" "$@"`);
    const env = { PATH: bin, HOME: root, TMPDIR: root };
    expect(await discoverPrimeAgent(env)).toMatchObject({
      launcher: join(bin, "prime-agent"),
      executable: join(share, "prime-agent"),
      version: "0.10.3",
    });
    await expect(discoverPrimeAgent({ ...env, PATH: join(root, "empty") })).rejects.toThrow(
      /Prime Agent is unavailable/u,
    );
  },
);
