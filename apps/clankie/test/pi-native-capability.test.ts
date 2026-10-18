import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  createPiSessionVerifier,
  holdPiCapabilityFiles,
  PiNativeRefusal,
  supportedPiOnPath,
} from "../src/captain/pi-native-capability.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-file-fence-")));
  directories.push(dir);
  const executable = join(dir, "native-node");
  const cli = join(dir, "cli.js");
  await writeFile(executable, "test executable fixture");
  await writeFile(cli, "native fixture");
  const digest = createHash("sha256").update("native fixture").digest("hex");
  const verify = await holdPiCapabilityFiles(executable, { [cli]: digest });
  return { dir, executable, cli, digest, verify };
}
test("unchanged selected files retain control; changed runtime script revokes it", async () => {
  const f = await fixture();
  await f.verify();
  await writeFile(f.cli, "altered fixture");
  await expect(f.verify()).rejects.toThrow("changed");
});
test("same-content replacement inode is not the original selected CLI", async () => {
  const f = await fixture();
  const replacement = join(f.dir, "replacement");
  await writeFile(replacement, "native fixture");
  await rename(replacement, f.cli);
  await expect(f.verify()).rejects.toThrow("changed");
});
test("selected Node lifetime file replacement revokes control", async () => {
  const f = await fixture();
  await writeFile(f.executable, "changed executable fixture");
  await expect(f.verify()).rejects.toThrow("changed");
});
test("wrong native bundle hash and replaced symlink fail closed", async () => {
  const f = await fixture();
  await expect(holdPiCapabilityFiles(f.executable, { [f.cli]: "wrong" })).rejects.toThrow("supported");
  await rm(f.cli);
  await symlink(f.executable, f.cli);
  await expect(f.verify()).rejects.toThrow();
});
test("fresh native metadata does not create a session file; saved resume requires real header", async () => {
  const f = await fixture();
  const id = randomUUID();
  const file = join(f.dir, `timestamp_${id}.jsonl`);
  await createPiSessionVerifier([f.dir], false)(id, file, f.dir);
  await expect(createPiSessionVerifier([f.dir], true)(id, file, f.dir)).rejects.toThrow("disappeared");
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: f.dir })}\n`);
  const saved = createPiSessionVerifier([f.dir], true);
  await saved(id, file, f.dir);
  await writeFile(file, `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), cwd: f.dir })}\n`);
  await expect(saved(id, file, f.dir)).rejects.toThrow("disagrees");
});
test("saved native path cannot change inode or escape the effective root", async () => {
  const f = await fixture();
  const id = randomUUID();
  const file = join(f.dir, `timestamp_${id}.jsonl`);
  const header = `${JSON.stringify({ type: "session", version: 3, id, cwd: f.dir })}\n`;
  await writeFile(file, header);
  const verify = createPiSessionVerifier([f.dir], true);
  await verify(id, file, f.dir);
  const replacement = join(f.dir, "replacement.jsonl");
  await writeFile(replacement, header);
  await rename(replacement, file);
  await expect(verify(id, file, f.dir)).rejects.toThrow("replaced");
  await expect(createPiSessionVerifier([join(f.dir, "missing")], false)(id, file, f.dir)).rejects.toThrow();
});

// VUH-2417: no exact pin. An installed release is admitted only at or above the
// validated floor with a recognized bundle and a passing probe, and otherwise
// refused with a reason that names the version found.
test("refuses an older, unrecognized or probe-failing Pi release by version", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "pi-release-")));
  directories.push(dir);
  const install = async (version: string, chunk = true) => {
    const root = join(dir, version, "pi-coding-agent");
    const bundle = join(root, "dist/bundle");
    await mkdir(join(bundle, "chunks"), { recursive: true });
    await mkdir(join(dir, version, "bin"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }),
    );
    await writeFile(join(bundle, "cli.js"), 'createRequire(import.meta.url)("./cli-runtime.js");\n');
    await chmod(join(bundle, "cli.js"), 0o755);
    await writeFile(join(bundle, "cli-runtime.js"), chunk ? 'import{main}from"./chunks/core.js";\n' : "");
    await writeFile(join(bundle, "chunks/core.js"), "export const main = () => {};\n");
    // An SDK without the surfaces the worker runtime drives.
    await writeFile(join(root, "dist/index.js"), "export {};\n");
    await symlink(join(bundle, "cli.js"), join(dir, version, "bin/pi"));
    return { PATH: [join(dir, version, "bin"), dirname(process.execPath)].join(delimiter) };
  };
  const refusal = async (version: string, chunk?: boolean) => {
    const error = await supportedPiOnPath(await install(version, chunk)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PiNativeRefusal);
    return (error as Error).message;
  };
  expect(await refusal("0.86.2")).toBe(
    "Native Pi 0.86.2 is older than 0.87.1, the oldest release proven with a live hire; update Pi",
  );
  expect(await refusal("9.0.0", false)).toBe("Native Pi 9.0.0 has an unrecognized CLI bundle layout");
  expect(await refusal("9.1.0")).toMatch(
    /^Native Pi 9\.1\.0 failed Clankie's capability probe: load the worker extension: /u,
  );
});
