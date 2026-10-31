import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, expect, it } from "vitest";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../bin/update-files.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "private-directory-")));
  roots.push(root);
  const target = join(root, "target");
  mkdirSync(target, { mode: 0o700 });
  const link = join(root, "state");
  symlinkSync(target, link);
  return { root, target, link };
}

it("reads and atomically writes private records through owner symlinks and link chains", () => {
  const { root, link, target } = fixture();
  const chain = join(root, "chain");
  symlinkSync("state", chain);
  mkdirSync(join(target, "updates"), { mode: 0o700 });
  const record = join(chain, "updates", "record.json");
  writePrivateJson(record, { accepted: true });
  expect(readPrivateJson(record)).toEqual({ accepted: true });
  privateDirectory(link);
  const foreignRecord = join(root, "elsewhere.json");
  writeFileSync(foreignRecord, "{}", { mode: 0o600 });
  symlinkSync(foreignRecord, join(target, "linked.json"));
  expect(() => readPrivateJson(join(link, "linked.json"))).toThrow();
});

it.each([0o755, 0o770, 0o777])("refuses a nonprivate symlink target with mode %s", (mode) => {
  const { target, link } = fixture();
  chmodSync(target, mode);
  expect(() => privateDirectory(link)).toThrow("unsafe symlink or target");
});

it("refuses links replaceable in shared directories and private targets beneath writable shared ancestors", (context) => {
  // A root-owned link in a root-owned private directory is an OS alias, whose target is not checked.
  context.skip(process.getuid?.() === 0, "as root every link is root-owned, so it reads as an OS alias");
  const { root, target, link } = fixture();
  const shared = join(root, "shared");
  mkdirSync(shared, { mode: 0o777 });
  chmodSync(shared, 0o777);
  symlinkSync(target, join(shared, "link"));
  expect(() => privateDirectory(join(shared, "link"))).toThrow("unsafe symlink or target");
  mkdirSync(join(shared, "private"), { mode: 0o700 });
  symlinkSync(join(shared, "private"), join(root, "escape"));
  expect(() => privateDirectory(join(root, "escape"))).toThrow("unsafe symlink or target");
  privateDirectory(link);
});

it.skipIf(!process.getuid || process.getuid() === 0)(
  "refuses an owner link to a foreign-owned target even when readable roots are allowed",
  () => {
    const { root } = fixture();
    const link = join(root, "foreign");
    symlinkSync(parse(root).root, link);
    expect(() => privateDirectory(link, { allowReadable: true })).toThrow("unsafe symlink or target");
  },
);
