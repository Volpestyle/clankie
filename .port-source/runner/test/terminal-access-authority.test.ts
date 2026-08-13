import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TerminalAccessAuthority } from "../src/terminal-access-authority.ts";

const SECRET = Buffer.alloc(32, 7);

function forge(secret: Buffer, payload: unknown): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

describe("TerminalAccessAuthority", () => {
  it("mints observe-only tokens bound to principal and device", () => {
    const authority = new TerminalAccessAuthority({ secret: SECRET });
    const token = authority.mintObserveToken({ principalId: "principal-1", deviceId: "device-1" });
    const result = authority.verify(token);
    expect(result).toEqual({
      ok: true,
      grant: { principalId: "principal-1", deviceId: "device-1", scopes: ["observe"] },
    });
  });

  it("has no public path to mint a control scope", () => {
    const authority = new TerminalAccessAuthority({ secret: SECRET });
    const token = authority.mintObserveToken({ principalId: "principal-1", deviceId: "device-1" });
    const result = authority.verify(token);
    expect(result.ok && result.grant.scopes).toEqual(["observe"]);
    expect((authority as unknown as { mint?: unknown }).mint).toBeUndefined();
  });

  it("classifies missing and malformed tokens", () => {
    const authority = new TerminalAccessAuthority({ secret: SECRET });
    expect(authority.verify(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(authority.verify("")).toEqual({ ok: false, reason: "missing" });
    expect(authority.verify("no-separator")).toEqual({ ok: false, reason: "malformed" });
    expect(authority.verify(".onlysig")).toEqual({ ok: false, reason: "malformed" });
    expect(authority.verify("onlypayload.")).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a tampered payload or signature as invalid", () => {
    const authority = new TerminalAccessAuthority({ secret: SECRET });
    const token = authority.mintObserveToken({ principalId: "principal-1", deviceId: "device-1" });
    const [payload, signature] = token.split(".");
    expect(authority.verify(`${payload}x.${signature}`)).toEqual({ ok: false, reason: "invalid" });
    expect(authority.verify(`${payload}.${signature}x`)).toEqual({ ok: false, reason: "invalid" });
    expect(authority.verify(`${payload}.deadbeef`)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token signed by a different secret", () => {
    const minter = new TerminalAccessAuthority({ secret: SECRET });
    const other = new TerminalAccessAuthority({ secret: Buffer.alloc(32, 9) });
    const token = minter.mintObserveToken({ principalId: "principal-1", deviceId: "device-1" });
    expect(other.verify(token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("expires tokens once the injected clock passes their lifetime", () => {
    let now = 1_000_000;
    const authority = new TerminalAccessAuthority({ secret: SECRET, now: () => now });
    const token = authority.mintObserveToken({
      principalId: "principal-1",
      deviceId: "device-1",
      ttlMs: 5_000,
    });
    expect(authority.verify(token).ok).toBe(true);
    now += 4_999;
    expect(authority.verify(token).ok).toBe(true);
    now += 1;
    expect(authority.verify(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("enforces ttl and id bounds on mint", () => {
    const authority = new TerminalAccessAuthority({ secret: SECRET });
    expect(() => authority.mintObserveToken({ principalId: "p", deviceId: "d", ttlMs: 999 })).toThrow(/ttl/);
    expect(() => authority.mintObserveToken({ principalId: "p", deviceId: "d", ttlMs: 300_001 })).toThrow(
      /ttl/,
    );
    expect(() => authority.mintObserveToken({ principalId: "bad id", deviceId: "d" })).toThrow(/principalId/);
    expect(() => authority.mintObserveToken({ principalId: "p", deviceId: "" })).toThrow(/deviceId/);
  });

  it("fails closed on validly signed but malformed claims", () => {
    const authority = new TerminalAccessAuthority({ secret: SECRET });
    const base = { p: "principal-1", d: "device-1", exp: Date.now() + 60_000, n: "abc" };
    expect(authority.verify(forge(SECRET, { ...base, s: [] })).ok).toBe(false);
    expect(authority.verify(forge(SECRET, { ...base, s: ["superuser"] })).ok).toBe(false);
    expect(authority.verify(forge(SECRET, { ...base, s: ["observe", "observe"] })).ok).toBe(false);
    expect(authority.verify(forge(SECRET, { ...base, s: ["observe"], p: "bad id" })).ok).toBe(false);
    expect(authority.verify(forge(SECRET, { ...base, s: ["observe"], exp: "soon" })).ok).toBe(false);
    expect(authority.verify(forge(SECRET, "not-an-object")).ok).toBe(false);
  });
});
