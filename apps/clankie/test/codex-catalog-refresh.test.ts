import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { isolatedCodexConfig, watchCodexCatalog } from "../src/captain/codex-catalog-refresh.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture(refresh = vi.fn(async (_revision: string): Promise<void> => {})) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "catalog-controller-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const signalPath = join(root, "signal");
  const onError = vi.fn();
  const stop = watchCodexCatalog({
    signalPath,
    configPath: join(root, "config.toml"),
    request: async () => {
      throw new Error("Legacy direct mutation must never run");
    },
    refresh,
    onError,
    intervalMs: 5,
  });
  cleanups.push(stop);
  const signal = async () => {
    await writeFile(`${signalPath}.tmp`, randomUUID());
    await rename(`${signalPath}.tmp`, signalPath);
  };
  return { root, refresh, onError, stop, signal };
}

it("delegates bridge signals to the durable coordinator, coalesces unchanged notifications and observes later revisions", async () => {
  const f = await fixture();
  await f.signal();
  await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
  expect(f.refresh).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9-]{36}$/u));
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(f.refresh).toHaveBeenCalledTimes(1);
  await f.signal();
  await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(2));
  expect(f.onError).not.toHaveBeenCalled();
});

it("bounds failed coordinator observations without retrying a native mutation itself", async () => {
  const refresh = vi.fn(async (_revision: string): Promise<void> => {
    throw new Error("disconnected");
  });
  const f = await fixture(refresh);
  await f.signal();
  await vi.waitFor(() => expect(f.onError).toHaveBeenCalledTimes(3));
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(refresh).toHaveBeenCalledTimes(3);
  refresh.mockImplementation(async () => {});
  await f.signal();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(4));
});

it("never overlaps delegated observations and stops watching when the seat closes", async () => {
  let release!: () => void;
  const refresh = vi.fn(
    (_revision: string) =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const f = await fixture(refresh);
  await f.signal();
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  await f.signal();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(refresh).toHaveBeenCalledTimes(1);
  f.stop();
  release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("accepts a private copied config and rejects an owner home or symlinked config", async () => {
  const f = await fixture();
  f.stop();
  const home = join(f.root, "worker-codex", "seat-fixture");
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(join(home, "config.toml"), "");
  expect(await isolatedCodexConfig(home)).toBe(join(home, "config.toml"));
  await expect(isolatedCodexConfig(f.root)).rejects.toThrow();
  await rm(join(home, "config.toml"));
  await writeFile(join(f.root, "owner.toml"), "");
  await symlink(join(f.root, "owner.toml"), join(home, "config.toml"));
  await expect(isolatedCodexConfig(home)).rejects.toThrow("isolated");
});
