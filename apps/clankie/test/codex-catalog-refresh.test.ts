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
async function fixture(
  request = vi.fn(async (_method: string, _params: Record<string, unknown>): Promise<unknown> => ({})),
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "catalog-controller-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const signalPath = join(root, "signal");
  const onError = vi.fn();
  const stop = watchCodexCatalog({
    signalPath,
    configPath: join(root, "config.toml"),
    request,
    onError,
    intervalMs: 5,
  });
  cleanups.push(stop);
  const signal = async () => {
    await writeFile(`${signalPath}.tmp`, randomUUID());
    await rename(`${signalPath}.tmp`, signalPath);
  };
  return { root, request, onError, stop, signal };
}

it("refreshes only the connection revision, coalesces unchanged notifications, and follows later removal", async () => {
  const f = await fixture();
  await f.signal();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
  expect(f.request.mock.calls).toEqual([
    [
      "config/value/write",
      {
        keyPath: "mcp_servers.clankie.env.CLANKIE_CATALOG_REVISION",
        value: expect.any(String),
        mergeStrategy: "upsert",
        filePath: join(f.root, "config.toml"),
      },
    ],
    ["config/mcpServer/reload", {}],
  ]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(f.request).toHaveBeenCalledTimes(2);
  await f.signal();
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(4));
  expect(f.onError).not.toHaveBeenCalled();
});

it("bounds failed refreshes, permits a later revision, and never issues a tool call or turn", async () => {
  const request = vi.fn(async (_method: string, _params: Record<string, unknown>): Promise<unknown> => {
    throw new Error("disconnected");
  });
  const f = await fixture(request);
  await f.signal();
  await vi.waitFor(() => expect(f.onError).toHaveBeenCalledTimes(3));
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(request).toHaveBeenCalledTimes(3);
  request.mockImplementation(async () => ({}));
  await f.signal();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "config/value/write",
    "config/value/write",
    "config/value/write",
    "config/value/write",
    "config/mcpServer/reload",
  ]);
});

it("stops between RPCs when the seat closes and never overlaps refreshes", async () => {
  let release!: () => void;
  const request = vi.fn(
    (_method: string, _params: Record<string, unknown>) =>
      new Promise<unknown>((resolve) => {
        release = () => resolve({});
      }),
  );
  const f = await fixture(request);
  await f.signal();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  await f.signal();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(request).toHaveBeenCalledTimes(1);
  f.stop();
  release();
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(request).toHaveBeenCalledTimes(1);
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
