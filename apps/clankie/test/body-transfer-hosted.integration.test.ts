import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { BodyTransfer, createBodyTransferRoutes } from "../src/body-transfer.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { GatewayEncryptionHost } from "../src/gateway-encryption.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { HostedPairing } from "../src/hosted-pairing.ts";
import { hostedFixture } from "./fixtures/hosted-body.ts";
import { pairHostedAccount } from "../../tui/src/hosted-session.ts";
import { runTransferCommand } from "../../tui/src/command/transfer.ts";

// `clankie transfer --to hosted` through the signed hosted device, the encrypted
// envelope and the hosted-operator seam into a managed body that restarts to
// apply (ADR 0286, VUH-2582). The production gateway hop is proven in clankie-ops.
const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("moves this Mac's Clankie into a managed body with the hosted CLI transport", async () => {
  const f = hostedFixture(Math.floor(Date.now() / 1000) * 1000);
  const root = await mkdtemp(join(tmpdir(), "transfer-hosted-"));
  roots.push(root);

  // The managed body: hosted pairing, gateway encryption and devices that survive a restart.
  const bodyKey = generateKeyPairSync("ed25519");
  const encryption = new GatewayEncryptionHost(f.hostId, randomBytes(32));
  const deviceSessionKey = randomBytes(32);
  const hostedState = join(root, "hosted/state");
  await mkdir(hostedState, { recursive: true });
  const hostedSettings = new SettingsStore(join(root, "hosted/settings.json"));
  let hosted: ClankieApp | undefined;
  let restarts = 0;
  const startHosted = async () => {
    const transfer = new BodyTransfer({
      roots: {
        state: hostedState,
        memory: join(hostedState, "memory"),
        attachments: join(hostedState, "attachments"),
      },
      settings: hostedSettings,
      label: "hosted",
    });
    await transfer.boot();
    hosted = await createClankieApp({
      captain: createStubCaptain(),
      hostedPairing: new HostedPairing(new HostedBodyClient(f.bootstrap), bodyKey.privateKey),
      settings: hostedSettings,
      deviceSessionKey,
      eventLogPath: join(hostedState, "events.jsonl"),
      authenticateOperator: async () => undefined,
      pairingOfferPublisher: {
        publishPairingOffer: async () => {},
        protectPairingOffer: (offer) => ({
          version: 1,
          deepLink: `clankie://connect?v=1&offer=${offer.offerSecret}#${new URLSearchParams(encryption.pairingCredential(offer))}`,
          code: offer.code,
          expiresAt: offer.expiresAt,
        }),
      },
      bodyTransfer: {
        transfer,
        cutover: async (commit) => {
          await commit();
          // The launcher restarts the body; boot applies the committed transfer.
          setTimeout(() => {
            restarts += 1;
            hosted?.close();
            void startHosted();
          }, 0);
          return "ready";
        },
      },
    });
  };
  await startHosted();
  closers.push(() => hosted?.close());

  // This Mac: real files, a project on its own machine, and its operator credential.
  const macState = join(root, "mac/state");
  await mkdir(join(macState, "memory/captain-episodes"), { recursive: true });
  await mkdir(join(macState, "attachments/delivered"), { recursive: true });
  const note = `{"summary":"Hosted codeword ${randomBytes(4).toString("hex")}."}\n`;
  await writeFile(join(macState, "memory/captain-episodes/operator.jsonl"), note);
  const attachment = randomBytes(2 * 1024 * 1024);
  await writeFile(join(macState, "attachments/delivered/photo.bin"), attachment);
  const macSettings = new SettingsStore(join(root, "mac/settings.json"));
  const mac = new BodyTransfer({
    roots: { state: macState, memory: join(macState, "memory"), attachments: join(macState, "attachments") },
    settings: macSettings,
    label: "local:mac",
  });
  const macRoutes = createBodyTransferRoutes({
    transfer: mac,
    authorize: async (request) =>
      request.headers.get("authorization") === "Bearer mac-operator" ? true : "authentication_required",
    cutover: async (commit) => {
      await commit();
      return "ready";
    },
  });

  // One carrier: the Mac's loopback service, and the account and gateway the hosted transport dials.
  const machine = { id: "machine-1", name: "My hosted Clankie", hostId: f.hostId, state: "running" };
  const envelopes: number[] = [];
  const carrier: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "http://mac.test") return macRoutes.fetch(request);
    const body = await request.text();
    if (url.pathname === "/fleet/v1/machines") return Response.json({ machines: [machine] });
    if (url.pathname === "/fleet/v1/pairing/offer") {
      const binding = JSON.parse(body);
      const pairTicket = f.pair({
        bkh: createHash("sha256")
          .update(Buffer.from(binding.browserPublicKey, "base64url"))
          .digest("base64url"),
        non: binding.nonce,
        purpose: "operator",
      });
      const response = await hosted!.app.request("/v1/hosted/pair-offer", {
        method: "POST",
        body: JSON.stringify({
          version: 2,
          pairTicket,
          browserPublicKey: binding.browserPublicKey,
          nonce: binding.nonce,
        }),
      });
      return Response.json({
        machine,
        ticketId: "j".repeat(22),
        bodyPairingKey: bodyKey.publicKey.export({ format: "jwk" }).x,
        answer: await response.json(),
      });
    }
    envelopes.push(Buffer.byteLength(body));
    const path = url.pathname.slice(`/h/${f.hostId}`.length);
    return encryption.handle(path, body, request.signal, async (inner) => hosted!.app.fetch(inner));
  };
  const store = new FileCredentialStore(join(root, "credentials.json"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await pairHostedAccount({
    gatewayUrl: "https://api.example.test",
    credential: {
      type: "oauth",
      access: "account-only-secret",
      refresh: "refresh-only-secret",
      accountId: "account-1",
      expires: Date.now() + 3600_000,
    },
    store,
    settings,
    fetchImpl: carrier,
  });
  const env = {
    CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    CLANKIE_OPERATOR_TOKEN: "mac-operator",
  };

  const output: string[] = [];
  const transferId = "0d8a6f2e-7c3b-4e51-9a1f-5b2c8e4d7f60";
  const exit = await runTransferCommand(
    ["--to", "hosted", "--transfer-id", transferId],
    { write: (text) => output.push(text) },
    {
      env,
      host: "http://mac.test",
      fetchImpl: carrier,
      stderr: { write: () => true },
      pollSeconds: 0.02,
    },
  );
  expect(exit).toBe(0);
  const result = JSON.parse(output.join(""));
  expect(result.destination).toMatchObject({
    at: `hosted:${f.hostId}`,
    state: "active",
    epoch: 1,
    transferId,
  });
  expect(result.source).toMatchObject({ state: "released", selfId: result.destination.selfId });
  expect(restarts).toBe(1);
  // Every envelope fits the gateway's 2 MiB request body limit.
  expect(Math.max(...envelopes)).toBeLessThan(2 * 1024 * 1024);
  expect(envelopes.length).toBeGreaterThan(5);
  expect(await readFile(join(hostedState, "memory/captain-episodes/operator.jsonl"), "utf8")).toBe(note);
  expect((await readFile(join(hostedState, "attachments/delivered/photo.bin"))).equals(attachment)).toBe(
    true,
  );

  // Status through the same hosted CLI transport reads the destination.
  output.length = 0;
  await runTransferCommand(
    ["status", "--at", "hosted"],
    { write: (text) => output.push(text) },
    { env, fetchImpl: carrier },
  );
  expect(JSON.parse(output.join(""))).toMatchObject({ state: "active", selfId: result.destination.selfId });
}, 60_000);
