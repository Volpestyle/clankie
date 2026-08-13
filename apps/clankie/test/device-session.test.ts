import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeviceSessionError,
  DeviceSessionSigner,
  loadOrCreateDeviceSessionKey,
  mintDeviceSessionClaims,
  type DeviceSessionClaims,
} from "../src/device-session.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const NOW_SECONDS = 1_800_000_000;

function claims(overrides: Partial<DeviceSessionClaims> = {}): DeviceSessionClaims {
  return {
    version: 1,
    deviceId: "device-abc123",
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 3600,
    nonce: "nonce-value-1",
    ...overrides,
  };
}

describe("DeviceSessionSigner", () => {
  const signer = new DeviceSessionSigner(randomBytes(32));

  it("issues and verifies a roundtrip token", () => {
    const token = signer.issue(claims());
    expect(signer.verify(token, NOW_SECONDS + 10)).toEqual(claims());
  });

  it("rejects a token signed by a different key", () => {
    const token = signer.issue(claims());
    const other = new DeviceSessionSigner(randomBytes(32));
    expect(() => other.verify(token, NOW_SECONDS)).toThrow(DeviceSessionError);
    try {
      other.verify(token, NOW_SECONDS);
    } catch (error) {
      expect((error as DeviceSessionError).code).toBe("invalid_signature");
    }
  });

  it("rejects a tampered payload", () => {
    const [, signature] = signer.issue(claims()).split(".");
    const forged = Buffer.from(JSON.stringify(claims({ deviceId: "device-evil" })), "utf8").toString(
      "base64url",
    );
    expect(() => signer.verify(`${forged}.${signature ?? ""}`, NOW_SECONDS)).toThrow(DeviceSessionError);
  });

  it("rejects a noncanonical encoding", () => {
    const token = signer.issue(claims());
    const [payload, signature] = token.split(".");
    // Append padding to make the signature segment noncanonical base64url.
    expect(() => signer.verify(`${payload ?? ""}.${signature ?? ""}=`, NOW_SECONDS)).toThrow(
      DeviceSessionError,
    );
  });

  it("rejects an extra segment", () => {
    const token = signer.issue(claims());
    let code: string | undefined;
    try {
      signer.verify(`${token}.extra`, NOW_SECONDS);
    } catch (error) {
      code = (error as DeviceSessionError).code;
    }
    expect(code).toBe("malformed");
  });

  it("rejects an expired token", () => {
    const token = signer.issue(claims());
    let code: string | undefined;
    try {
      signer.verify(token, NOW_SECONDS + 3600);
    } catch (error) {
      code = (error as DeviceSessionError).code;
    }
    expect(code).toBe("expired");
  });

  it("rejects a not-yet-valid token", () => {
    const token = signer.issue(claims());
    let code: string | undefined;
    try {
      signer.verify(token, NOW_SECONDS - 10);
    } catch (error) {
      code = (error as DeviceSessionError).code;
    }
    expect(code).toBe("not_yet_valid");
  });

  it("mints claims with a week-long default TTL and a random nonce", () => {
    const a = mintDeviceSessionClaims({ deviceId: "device-1", nowEpochSeconds: NOW_SECONDS });
    const b = mintDeviceSessionClaims({ deviceId: "device-1", nowEpochSeconds: NOW_SECONDS });
    expect(a.expiresAt - a.issuedAt).toBe(7 * 24 * 60 * 60);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it("requires a key of at least 32 bytes", () => {
    expect(() => new DeviceSessionSigner(randomBytes(16))).toThrow();
  });
});

describe("loadOrCreateDeviceSessionKey", () => {
  it("mints a fresh mode-0600 key and reads it back stably", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-devkey-"));
    tempDirs.push(root);
    const path = join(root, "device-session.key");
    const first = await loadOrCreateDeviceSessionKey(path);
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first?.byteLength).toBe(32);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(/^[0-9a-f]{64}$/u.test((await readFile(path, "utf8")).trim())).toBe(true);
    const second = await loadOrCreateDeviceSessionKey(path);
    expect(Buffer.from(second ?? new Uint8Array()).equals(Buffer.from(first ?? new Uint8Array()))).toBe(true);
  });

  it("rejects a wrong-mode key file", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-devkey-"));
    tempDirs.push(root);
    const path = join(root, "device-session.key");
    await writeFile(path, randomBytes(32).toString("hex"), "utf8");
    await chmod(path, 0o644);
    expect(await loadOrCreateDeviceSessionKey(path)).toBeUndefined();
  });

  it("refuses to follow a symlink at the key path", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-devkey-"));
    tempDirs.push(root);
    const real = join(root, "real.key");
    await writeFile(real, randomBytes(32).toString("hex"), "utf8");
    await chmod(real, 0o600);
    const path = join(root, "device-session.key");
    await symlink(real, path);
    expect(await loadOrCreateDeviceSessionKey(path)).toBeUndefined();
  });

  it("rejects a garbled key file", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-devkey-"));
    tempDirs.push(root);
    const path = join(root, "device-session.key");
    await writeFile(path, "not-hex", "utf8");
    await chmod(path, 0o600);
    expect(await loadOrCreateDeviceSessionKey(path)).toBeUndefined();
  });

  it("resolves a concurrent create race to one shared key", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-devkey-"));
    tempDirs.push(root);
    const path = join(root, "device-session.key");
    const [a, b] = await Promise.all([
      loadOrCreateDeviceSessionKey(path),
      loadOrCreateDeviceSessionKey(path),
    ]);
    expect(a).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(a ?? new Uint8Array()).equals(Buffer.from(b ?? new Uint8Array()))).toBe(true);
  });
});
