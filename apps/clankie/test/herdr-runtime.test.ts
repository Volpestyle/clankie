import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bundledHerdrBinary, startHerdrRuntime } from "../src/herdr-runtime.ts";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp("/tmp/ch-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("selects the built checkout or installed native binary and honors external mode", async () => {
  const root = await temporary();
  const settings = { runtime: "auto", session: "default" } as const;
  await mkdir(join(root, ".data/herdr/bin"), { recursive: true });
  await writeFile(join(root, ".data/herdr/bin/herdr"), "");
  expect(bundledHerdrBinary(root, settings)).toBe(join(root, ".data/herdr/bin/herdr"));
  expect(bundledHerdrBinary(root, { ...settings, runtime: "bundled" })).toBe(
    join(root, ".data/herdr/bin/herdr"),
  );
  await writeFile(join(root, "release.json"), "{}");
  expect(bundledHerdrBinary(root, settings)).toBe(join(root, "libexec/herdr"));
  expect(bundledHerdrBinary(root, { ...settings, runtime: "external" })).toBeUndefined();
  await expect(
    startHerdrRuntime({ binary: join(root, "missing"), repoRoot: root, stateRoot: root, env: {} }),
  ).rejects.toThrow("missing");
});

it("refuses to take over an occupied runtime socket", async () => {
  const root = await temporary();
  await mkdir(join(root, "herdr"));
  const server = createServer((socket) => socket.end());
  await new Promise<void>((done) => server.listen(join(root, "herdr/herdr.sock"), done));
  try {
    await expect(
      startHerdrRuntime({ binary: process.execPath, repoRoot: root, stateRoot: root, env: {} }),
    ).rejects.toThrow("already has an owner");
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
