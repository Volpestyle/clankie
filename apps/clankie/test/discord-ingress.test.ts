import { it, expect, vi } from "vitest";
import { createECDH, createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordIngress, createDiscordIngressRoutes } from "../src/discord-ingress.ts";
import { DiscordIngressEventSchema } from "@clankie/protocol/discord-ingress";
import { prepareDiscordIngress } from "@clankie/protocol/discord-ingress-crypto";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "discord-ingress-")),
    pair = generateKeyPairSync("ed25519"),
    key = createECDH("prime256v1");
  key.generateKeys();
  const kid = createHash("sha256")
    .update(pair.publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url")
    .slice(0, 16);
  const event = DiscordIngressEventSchema.parse({
    schemaVersion: 1,
    tenantId: `tn_${"a".repeat(20)}`,
    installationId: "a".repeat(22),
    deliveryId: "discord:1",
    eventAtMs: 1000000,
    expiresAtMs: 1300000,
    channelId: "2",
    messageId: "3",
    actorId: "4",
    owner: true,
    kind: "dm",
    content: "PRIVATE_MARKER",
  });
  function sealed(e = event) {
    const prepared = prepareDiscordIngress(e, key.getPublicKey().toString("base64url"));
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "clankie-discord", kid })).toString(
      "base64url",
    );
    const claims = Buffer.from(
      JSON.stringify({
        typ: "clankie-discord",
        aud: "clankie-body",
        iss: "clankie-fleet",
        tid: e.tenantId,
        inst: e.installationId,
        dig: prepared.digest,
        jti: "a".repeat(22),
        iat: 1000,
        exp: 1060,
      }),
    ).toString("base64url");
    return prepared.seal(
      `${header}.${claims}.${sign(null, Buffer.from(`${header}.${claims}`), pair.privateKey).toString("base64url")}`,
    );
  }
  const options = {
    tenantId: event.tenantId,
    installationId: event.installationId,
    key,
    verifyKeys: new Map([[kid, pair.publicKey]]),
    clock: () => 1001000,
    statePath: join(dir, "state.json"),
  };
  return { dir, event, sealed, options, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
it("persists admission, deduplicates retries and seals replies without logging content", async () => {
  const f = fixture(),
    logs = vi.spyOn(console, "log"),
    execute = vi.fn(async () => ({ state: "reply" as const, text: "PRIVATE_REPLY" }));
  try {
    const ingress = new DiscordIngress({ ...f.options, execute }),
      request = f.sealed();
    const first = await ingress.accept(request.envelope).json();
    expect(request.openResponse(first.sealed)).toEqual({ state: "pending" });
    expect(readFileSync(f.options.statePath, "utf8")).toContain('"pending"');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const second = await ingress.accept(request.envelope).json();
    expect(request.openResponse(second.sealed)).toEqual({ state: "reply", text: "PRIVATE_REPLY" });
    const restarted = new DiscordIngress({ ...f.options, execute });
    restarted.accept(request.envelope);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("PRIVATE_");
    expect(JSON.stringify(second)).not.toContain("PRIVATE_REPLY");
    const altered = f.sealed({ ...f.event, content: "changed" });
    expect(ingress.accept(altered.envelope).status).toBe(409);
  } finally {
    logs.mockRestore();
    f.cleanup();
  }
});
it("never reruns an uncertain admitted machine turn after restart", async () => {
  const f = fixture();
  try {
    const execute = vi.fn(() => new Promise<never>(() => {})),
      r = f.sealed();
    new DiscordIngress({ ...f.options, execute }).accept(r.envelope);
    const next = vi.fn(),
      restarted = new DiscordIngress({ ...f.options, execute: next });
    expect(r.openResponse((await restarted.accept(r.envelope).json()).sealed)).toEqual({
      state: "failed",
      code: "interrupted",
    });
    expect(next).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
it("refuses unsealed requests, arbitrary bearer grants, wrong tenants and oversized input", async () => {
  const f = fixture(),
    execute = vi.fn();
  try {
    const app = createDiscordIngressRoutes(new DiscordIngress({ ...f.options, execute }));
    for (const body of [f.event, { ...f.event, owner: true, grants: { terminalControl: true } }]) {
      const response = await app.request("/v1/discord/ingress", {
        method: "POST",
        headers: { authorization: "Bearer operator", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(401);
    }
    const wrong = f.sealed({ ...f.event, tenantId: `tn_${"b".repeat(20)}` });
    expect(
      (await app.request("/v1/discord/ingress", { method: "POST", body: JSON.stringify(wrong.envelope) }))
        .status,
    ).toBe(401);
    expect(
      (await app.request("/v1/discord/ingress", { method: "POST", body: "x".repeat(128 * 1024 + 1) })).status,
    ).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    f.cleanup();
  }
});
