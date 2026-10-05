import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createPiSessionVerifier, holdPiCapabilityFiles } from "../src/captain/pi-native-capability.ts";

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
