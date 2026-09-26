import { copyFile, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { HostedDeviceSecurity } from "../src/hosted-device-security.ts";
import { HostedBodyResourceError, type HostedSecurityState } from "../src/hosted-body.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hosted-security-"));
  roots.push(root);
  const path = join(root, "identity.json");
  let state: HostedSecurityState = { gen: 0, rev: [], ak: null, pk: null };
  const source = {
    readSecurityState: vi.fn(async () => structuredClone(state)),
    declareAuthKey: vi.fn(async (keyId: string, previousKeyId?: string) => {
      if (state.ak && previousKeyId !== state.ak.kid) throw new HostedBodyResourceError("stale_auth_key");
      state = { ...state, gen: state.gen + 1, ak: { kid: keyId, gen: state.gen + 1 } };
    }),
    revokeDevice: vi.fn(async (dev: string) => {
      if (state.rev.some((r) => r.dev === dev)) return;
      state = {
        ...state,
        gen: state.gen + 1,
        rev: [...state.rev, { dev, at: Date.now(), gen: state.gen + 1 }],
      };
    }),
  };
  return {
    root,
    path,
    source,
    boot: () => new HostedDeviceSecurity(source, path),
    advanceKey() {
      state = {
        ...state,
        gen: state.gen + 1,
        ak: { kid: randomBytes(16).toString("base64url"), gen: state.gen + 1 },
      };
    },
  };
}
it("enrolls legacy key once, preserves valid sessions on restore and rotates a rolled-back auth key", async () => {
  const f = await fixture(),
    legacy = randomBytes(32);
  const first = await f.boot().prepare(legacy, []);
  expect(Buffer.from(first.key)).toEqual(legacy);
  expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  await copyFile(f.path, join(f.root, "snapshot"));
  const repeated = await f.boot().prepare(legacy, []);
  expect(repeated.key).toEqual(first.key);
  expect(f.source.declareAuthKey).toHaveBeenCalledTimes(1);
  f.advanceKey();
  await copyFile(join(f.root, "snapshot"), f.path);
  const restored = await f.boot().prepare(legacy, []);
  expect(restored.key).not.toEqual(first.key);
  expect(f.source.declareAuthKey).toHaveBeenCalledTimes(2);
});
it("never attaches a fresh id to an old key when the disk's id is missing after enrollment", async () => {
  const f = await fixture(),
    legacy = randomBytes(32);
  await f.boot().prepare(legacy, []);
  await rm(f.path);
  expect((await f.boot().prepare(legacy, [])).key).not.toEqual(legacy);
});
it("persists key and id before declaration and recovers a lost successful response without rotating twice", async () => {
  const f = await fixture();
  const real = f.source.declareAuthKey.getMockImplementation()!;
  f.source.declareAuthKey.mockImplementationOnce(async (id, previous) => {
    await real(id, previous);
    throw new Error("lost response");
  });
  await expect(f.boot().prepare(randomBytes(32), [])).rejects.toThrow("lost response");
  const saved = JSON.parse(await readFile(f.path, "utf8"));
  const restored = await f.boot().prepare(randomBytes(32), []);
  expect(Buffer.from(restored.key).toString("base64url")).toBe(saved.key);
  expect(f.source.declareAuthKey).toHaveBeenCalledTimes(1);
});
it("exports local tombstones before returning admission state, and refuses an unreachable authority", async () => {
  const f = await fixture();
  const ready = await f.boot().prepare(randomBytes(32), ["device-local"]);
  expect(ready.revocations.map((r) => r.dev)).toContain("device-local");
  expect(f.source.revokeDevice).toHaveBeenCalledWith("device-local");
  f.source.readSecurityState.mockRejectedValue(new Error("offline"));
  await expect(f.boot().prepare(randomBytes(32), [])).rejects.toThrow("offline");
});
it("refuses a symlinked identity without overwriting it", async () => {
  const f = await fixture();
  await f.boot().prepare(randomBytes(32), []);
  const saved = await readFile(f.path, "utf8");
  const link = join(f.root, "link");
  await symlink(f.path, link);
  await expect(new HostedDeviceSecurity(f.source, link).prepare(randomBytes(32), [])).rejects.toThrow(
    "unavailable",
  );
  expect(await readFile(f.path, "utf8")).toBe(saved);
});
