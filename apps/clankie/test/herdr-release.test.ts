import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installHerdrRelease, refreshOfficialHerdr } from "../src/herdr-release.ts";
import { prepareHerdrBinary } from "../src/herdr-binary.ts";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp("/tmp/ch-release-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const bytes = Buffer.from("official test binary");
const target = `${process.platform === "darwin" ? "macos" : "linux"}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;
const manifest = {
  version: "1.2.3",
  assets: { [target]: `https://github.com/herdrdev/herdr/releases/download/v1.2.3/herdr-${target}` },
  sha256: { [target]: createHash("sha256").update(bytes).digest("hex") },
};

it("verifies official assets, caches checks, and retains the last verified release offline", async () => {
  const root = await temporary();
  const fetchImpl = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("latest.json") ? Response.json(manifest) : new Response(bytes),
  );
  const path = await refreshOfficialHerdr(root, "/missing", fetchImpl);
  expect(await readFile(path)).toEqual(bytes);
  expect(await refreshOfficialHerdr(root, "/missing", fetchImpl)).toBe(path);
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  await writeFile(join(root, "releases/current.json"), JSON.stringify({ manifest, checkedAt: 0 }));
  fetchImpl.mockRejectedValue(new Error("offline"));
  expect(await refreshOfficialHerdr(root, "/missing", fetchImpl)).toBe(path);
  await writeFile(path, "corrupted");
  await expect(refreshOfficialHerdr(root, "/missing", fetchImpl)).rejects.toThrow("offline");
});

it("rejects untrusted URLs and bad checksums without replacing an existing executable", async () => {
  const root = await temporary();
  const path = join(root, "herdr");
  await writeFile(path, "keep this");
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("wrong bytes"));
  await expect(
    installHerdrRelease(path, { ...manifest, assets: { [target]: "https://example.com/herdr" } }, fetchImpl),
  ).rejects.toThrow("official release URL");
  expect(fetchImpl).not.toHaveBeenCalled();
  await expect(installHerdrRelease(path, manifest, fetchImpl)).rejects.toThrow("checksum mismatch");
  expect(await readFile(path, "utf8")).toBe("keep this");
});

it("never replaces the matching executable of a live fleet", async () => {
  const root = await temporary();
  const answers = vi.fn(async (path: string) => path === join(root, "bin/herdr"));
  expect(await prepareHerdrBinary({ root, fallback: "/missing", listening: true, answers })).toBe(
    join(root, "bin/herdr"),
  );
  expect(answers).toHaveBeenCalledTimes(1);
});
