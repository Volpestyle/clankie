import { describe, it, expect } from "vitest";
import { createECDH, createHash, generateKeyPairSync, sign } from "node:crypto";
import { discordEventDigest, DiscordIngressEventSchema } from "../src/discord-ingress.ts";
import { openDiscordIngress, prepareDiscordIngress } from "../src/discord-ingress-crypto.ts";

const event = DiscordIngressEventSchema.parse({
  schemaVersion: 1,
  tenantId: `tn_${"a".repeat(20)}`,
  installationId: "a".repeat(22),
  deliveryId: "discord:1",
  eventAtMs: 1_000_000,
  expiresAtMs: 1_300_000,
  channelId: "2",
  messageId: "3",
  actorId: "4",
  owner: true,
  kind: "dm",
  content: "private marker",
});
const pair = generateKeyPairSync("ed25519"),
  key = createECDH("prime256v1");
key.generateKeys();
const kid = createHash("sha256")
  .update(pair.publicKey.export({ format: "der", type: "spki" }))
  .digest("base64url")
  .slice(0, 16);
function permit(digest: string, overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "clankie-discord", kid })).toString(
    "base64url",
  );
  const claims = Buffer.from(
    JSON.stringify({
      typ: "clankie-discord",
      aud: "clankie-body",
      iss: "clankie-fleet",
      tid: event.tenantId,
      inst: event.installationId,
      dig: digest,
      jti: "a".repeat(22),
      iat: 1000,
      exp: 1060,
      ...overrides,
    }),
  ).toString("base64url");
  return `${header}.${claims}.${sign(null, Buffer.from(`${header}.${claims}`), pair.privateKey).toString("base64url")}`;
}
const options = {
  tenantId: event.tenantId,
  installationId: event.installationId,
  key,
  verifyKeys: new Map([[kid, pair.publicKey]]),
  nowMs: 1_001_000,
};
describe("Discord ingress sealed scope", () => {
  it("seals both directions and binds authority, event and tenant", () => {
    const prepared = prepareDiscordIngress(event, key.getPublicKey().toString("base64url"));
    const sealed = prepared.seal(permit(prepared.digest));
    expect(JSON.stringify(sealed.envelope)).not.toContain("private marker");
    const opened = openDiscordIngress(sealed.envelope, options);
    expect(opened.event).toEqual(event);
    const response = opened.sealResponse({ state: "reply", text: "private answer" });
    expect(response).not.toContain("private answer");
    expect(sealed.openResponse(response)).toEqual({ state: "reply", text: "private answer" });
    opened.destroy();
    prepared.destroy();
  });
  it.each([
    { tid: `tn_${"b".repeat(20)}` },
    { inst: "b".repeat(22) },
    { dig: "b".repeat(43) },
    { aud: "clankie-gateway" },
    { typ: "clankie-pair" },
    { exp: 1000 },
    { exp: 1200 },
    { iat: 1100, exp: 1160 },
  ])("refuses wrong or expired permits %j", (overrides) => {
    const prepared = prepareDiscordIngress(event, key.getPublicKey().toString("base64url"));
    const sealed = prepared.seal(permit(prepared.digest, overrides));
    expect(() => openDiscordIngress(sealed.envelope, options)).toThrow();
    prepared.destroy();
  });
  it("refuses substituted keys, ciphertext and event content", () => {
    const other = createECDH("prime256v1");
    other.generateKeys();
    const legitimate = prepareDiscordIngress(event, key.getPublicKey().toString("base64url"));
    const prepared = prepareDiscordIngress(
      { ...event, owner: false },
      key.getPublicKey().toString("base64url"),
    );
    const sealed = prepared.seal(permit(legitimate.digest));
    legitimate.destroy();
    expect(() => openDiscordIngress(sealed.envelope, options)).toThrow();
    expect(() =>
      openDiscordIngress(
        { ...sealed.envelope, ephemeralPublicKey: other.getPublicKey().toString("base64url") },
        options,
      ),
    ).toThrow();
    expect(() =>
      openDiscordIngress({ ...sealed.envelope, sealed: sealed.envelope.sealed.slice(1) }, options),
    ).toThrow();
    prepared.destroy();
  });
  it("canonicalizes schema order, refuses arbitrary grants, expired queue windows and ambient triggers", () => {
    expect(discordEventDigest({ ...event, content: event.content })).toBe(discordEventDigest(event));
    for (const extra of [
      { grants: { terminalControl: true } },
      { kind: "ambient" },
      { expiresAtMs: event.eventAtMs + 300001 },
    ])
      expect(DiscordIngressEventSchema.safeParse({ ...event, ...extra }).success).toBe(false);
  });
});
