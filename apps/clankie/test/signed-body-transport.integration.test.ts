import { createHash, createPublicKey, generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { hostedFixture } from "./fixtures/hosted-body.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Production bootstrap files require HTTPS. This trusted constructor fixture
// uses an owned loopback server to exercise fetch and native Ed25519 signatures.
async function fixture() {
  const f = hostedFixture();
  let key: KeyObject | undefined;
  let registrations = 0;
  let signatureRejections = 1;
  let networkFailures = 0;
  let status = 200;
  const calls: { path: string; bytes: Buffer; nonce: string }[] = [];
  const faults: Error[] = [];
  const server = createServer(async (request, response) => {
    try {
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const bytes = Buffer.concat(buffers);
      const path = request.url!;
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Bearer ${f.bootstrap.hostCredential}`);
      if (path === "/fleet/v1/body/pairing-key") {
        const value = JSON.parse(bytes.toString("utf8"));
        expect(value.installationId).toBe(f.bootstrap.installationId);
        expect(value.registrationToken).toBe(f.bootstrap.pairingKeyRegistrationToken);
        key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: value.publicKey }, format: "jwk" });
        registrations++;
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      if (!key) throw new Error("Missing registered key");
      const digest = createHash("sha256").update(bytes).digest("base64url");
      const nonce = String(request.headers["x-clankie-body-nonce"]);
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      expect(request.headers["x-clankie-body-digest"]).toBe(digest);
      const transcript = [
        "clankie-body-request-v1",
        "POST",
        path,
        f.bootstrap.tenantId,
        f.bootstrap.installationId,
        request.headers["x-clankie-body-timestamp"],
        nonce,
        digest,
      ].join("\n");
      expect(
        verify(
          null,
          Buffer.from(transcript),
          key,
          Buffer.from(String(request.headers["x-clankie-body-signature"]), "base64url"),
        ),
      ).toBe(true);
      calls.push({ path, bytes, nonce });
      if (networkFailures-- > 0) {
        request.socket.destroy();
      } else if (signatureRejections-- > 0) {
        response
          .writeHead(401, { "content-type": "application/json" })
          .end('{"error":"body_signature_invalid"}');
      } else if (status !== 200) {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end('{"error":"extension_refused"}');
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
        response.end("data: done\n\n");
      }
    } catch (error) {
      faults.push(error instanceof Error ? error : new Error(String(error)));
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(faults).toEqual([]);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing fixture port");
  const client = new HostedBodyClient(
    {
      ...f.bootstrap,
      gatewayOrigin: `http://127.0.0.1:${address.port}`,
    },
    { clock: () => f.now },
  );
  await client.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
  return {
    client,
    calls,
    registrations: () => registrations,
    setStatus(value: number) {
      status = value;
    },
    networkFailure() {
      networkFailures = 1;
    },
    noSignatureRejection() {
      signatureRejections = 0;
    },
  };
}

it("the generic signed transport preserves request bytes, streaming responses and bounded retry nonces", async () => {
  const f = await fixture();
  const bytes = new Uint8Array(Buffer.from('{ "request": "☃", "stream": true }\n'));
  const response = await f.client.signedBytes("/extension/v1/requests", bytes, AbortSignal.timeout(5_000));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await response.text()).toBe("data: first\n\ndata: done\n\n");
  expect(f.calls).toHaveLength(2);
  expect(new Set(f.calls.map((call) => call.nonce)).size).toBe(2);
  for (const call of f.calls) expect(call.bytes).toEqual(Buffer.from(bytes));
  expect(f.registrations()).toBe(1);
  f.networkFailure();
  expect((await f.client.signedBytes("/extension/v1/alternate", bytes)).status).toBe(200);
  expect(f.calls).toHaveLength(4);
  expect(new Set(f.calls.map((call) => call.nonce)).size).toBe(4);
  for (const status of [400, 403, 409, 429]) {
    f.setStatus(status);
    const before = f.calls.length;
    const refused = await f.client.signedBytes("/extension/v1/requests", bytes);
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error: "extension_refused" });
    expect(f.calls).toHaveLength(before + 1);
  }
  const before = f.calls.length;
  for (const path of [
    "https://other.test/request",
    "//other.test/request",
    "/extension/../request",
    "/request?secret=1",
  ])
    await expect(f.client.signedBytes(path, bytes)).rejects.toThrow("Invalid signed body request path");
  expect(f.calls).toHaveLength(before);
});

it("one-shot signed JSON transport never replays a failed upload or an admission refusal", async () => {
  const f = await fixture();
  f.noSignatureRejection();
  const input = { requestId: "stable-request", content: "☃" };
  f.networkFailure();
  await expect(
    f.client.signedPost("/extension/v1/action", input, AbortSignal.timeout(5_000)),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]?.bytes.toString("utf8")).toBe(JSON.stringify(input));
  for (const status of [401, 403, 429]) {
    f.setStatus(status);
    const before = f.calls.length;
    const refused = await f.client.signedPost("/extension/v1/action", input);
    expect(refused.status).toBe(status);
    expect(await refused.json()).toEqual({ error: "extension_refused" });
    expect(f.calls).toHaveLength(before + 1);
  }
  expect(new Set(f.calls.map((call) => call.nonce)).size).toBe(f.calls.length);
});
