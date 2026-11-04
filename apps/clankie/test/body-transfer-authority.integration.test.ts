import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash, sign } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { Readable } from "node:stream";
import { gzipSync, gunzipSync } from "node:zlib";
import { BodyTransferKeys } from "../src/body-transfer-identity.ts";
import {
  BODY_TRANSFER_FORMAT,
  BODY_TRANSFER_PEER_PATH,
  BodyTransferManifestSchema,
  type BodyTransferPeerDescriptor,
} from "@clankie/protocol/body-transfer";
import { once } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { BodyTransfer, createBodyTransferRoutes } from "../src/body-transfer.ts";
import { readBodyTransferPeer } from "../src/body-transfer-peer.ts";

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(label: string) {
  const root = await mkdtemp(join(tmpdir(), `clankie-body-${label}-`));
  roots.push(root);
  const bodyRoots = {
    state: join(root, "state"),
    memory: join(root, "memory"),
    attachments: join(root, "files"),
  };
  for (const directory of Object.values(bodyRoots)) await mkdir(directory, { recursive: true });
  const settings = new SettingsStore(join(root, "settings.json"));
  let current: BodyTransfer;
  const restart = async () => {
    const transfer = new BodyTransfer({ roots: bodyRoots, settings, label });
    await transfer.boot();
    current = transfer;
    return transfer;
  };
  const transfer = await restart();
  const peerApp = new Hono();
  peerApp.post(BODY_TRANSFER_PEER_PATH, async (context) => {
    try {
      return context.json(current.peerExchange(await context.req.json()));
    } catch {
      return context.json({ error: "body_peer_refused" }, 403);
    }
  });
  const server = serve({ fetch: peerApp.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture_peer_address");
  const url = `http://127.0.0.1:${address.port}`;
  closers.push(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return {
    root,
    roots: bodyRoots,
    settings,
    transfer,
    restart,
    peer: (transferId: string): BodyTransferPeerDescriptor => ({
      url,
      ticket: current.preparePeer({ transferId }),
    }),
  };
}

const ready = async (commit: () => Promise<void>) => {
  await commit();
  return "ready" as const;
};

// #101: S froze for A; A applied but its answer was lost. B never saw the move.
it("keeps the source frozen when a body it didn't freeze for answers", async () => {
  const s = await fixture("s"),
    b = await fixture("b"),
    a = await fixture("a");
  const source = s.transfer,
    bystander = b.transfer,
    destination = a.transfer;
  const transferId = randomUUID();
  await source.freeze(
    {
      transferId,
      destination: "https://a.example",
      destinationPeer: a.peer(transferId),
    },
    ready,
  );

  const discarded = await bystander.discard({ transferId });
  expect(discarded.transfers?.[transferId]?.outcome).toBe("burned");
  await expect(
    source.abort({ transferId, destination: "https://b.example", discarded }),
  ).rejects.toMatchObject({ code: "answer_not_from_recorded_destination" });
  await expect(
    source.release({
      transferId,
      destination: "https://b.example",
      activation: { ...source.authority(), state: "active", dormant: false },
    }),
  ).rejects.toMatchObject({ code: "answer_not_from_recorded_destination" });
  expect(source.authority()).toMatchObject({ state: "frozen", transferId });

  // The recorded destination burning the id is still the way back.
  const burned = await destination.discard({ transferId });
  await expect(
    source.abort({ transferId, destination: "https://a.example", discarded: burned }),
  ).resolves.toMatchObject({ state: "active" });
});

async function bundle(source: BodyTransfer, transferId: string): Promise<Buffer> {
  const { stream } = await source.exportBundle(transferId);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function upload(
  destination: BodyTransfer,
  transferId: string,
  bytes: Buffer,
  sourcePeer: BodyTransferPeerDescriptor,
  replace = false,
) {
  for (let offset = 0; offset < bytes.length; offset += 384 * 1024)
    await destination.stageChunk({
      transferId,
      offset,
      bytesBase64: bytes.subarray(offset, offset + 384 * 1024).toString("base64"),
    });
  return destination.stage({
    transferId,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourcePeer,
    replace,
  });
}
async function frozen() {
  const s = await fixture("source"),
    a = await fixture("a"),
    b = await fixture("b");
  const transferId = randomUUID();
  await s.transfer.freeze({ transferId, destination: "A", destinationPeer: a.peer(transferId) }, ready);
  return { s, a, b, transferId, source: await s.restart(), sourcePeer: s.peer(transferId) };
}

it("rejects relabelled, edited, forged and replayed burn receipts; only the recorded body's burn unfreezes the source", async () => {
  const { source, a, b, transferId } = await frozen();
  const foreign = await b.transfer.discard({ transferId });
  const original = a.transfer.authority({ transfers: true }).bodyIdentity!;
  for (const discarded of [
    foreign,
    { ...foreign, proof: { ...foreign.proof!, identity: original } },
    { ...foreign, proof: { ...foreign.proof!, signature: Buffer.alloc(64).toString("base64") } },
    await a.transfer.discard({ transferId: randomUUID() }),
  ]) {
    await expect(source.abort({ transferId, destination: "A", discarded })).rejects.toMatchObject({
      code: "destination_proof_unverified",
    });
    expect(source.authority()).toMatchObject({ state: "frozen", transferId });
  }
  const restarted = await a.restart();
  const discarded = await restarted.discard({ transferId });
  await expect(source.abort({ transferId, destination: "A", discarded })).resolves.toMatchObject({
    state: "active",
  });
  await expect(restarted.apply({ transferId }, ready)).rejects.toMatchObject({ code: "transfer_not_staged" });
});

it("binds sealed bundles to the frozen body, rejects altered bytes and keeps signed release receipts bound to their tuple", async () => {
  const { source, a, b, transferId, sourcePeer } = await frozen();
  const bytes = await bundle(source, transferId);
  await expect(upload(b.transfer, transferId, bytes, sourcePeer, true)).rejects.toMatchObject({
    code: "bundle_for_another_body",
  });
  expect(b.transfer.authority().selfId).toBeUndefined();
  const tampered = Buffer.from(bytes);
  tampered[tampered.length - 17] = tampered[tampered.length - 17]! ^ 1;
  await expect(upload(a.transfer, transferId, tampered, sourcePeer)).rejects.toMatchObject({
    code: "bundle_sealing_invalid",
  });
  expect(a.transfer.authority().selfId).toBeUndefined();
  await upload(a.transfer, transferId, bytes, sourcePeer);
  await a.transfer.apply({ transferId }, ready);
  // A's interrupted apply cannot be burned; its next boot installs the same self.
  await expect(a.transfer.discard({ transferId })).rejects.toMatchObject({ code: "transfer_applied" });
  const active = await a.restart();
  const activation = active.authority({ transfers: true });
  expect(activation).toMatchObject({ state: "active", selfId: source.authority().selfId });
  await expect(
    source.release({
      transferId,
      destination: "A",
      activation: { ...activation, proof: { ...activation.proof!, epoch: activation.epoch + 1 } },
    }),
  ).rejects.toMatchObject({ code: "destination_proof_unverified" });
  await expect(
    source.release({ transferId, destination: "A", activation: { ...activation, proof: undefined } }),
  ).rejects.toMatchObject({ code: "destination_proof_unverified" });
  await expect(source.release({ transferId, destination: "A", activation })).resolves.toMatchObject({
    state: "released",
  });
  const sealedSource = await readFile(join(a.roots.state, "self-signing-key.json"), "utf8");
  expect(bytes.includes(Buffer.from(sealedSource))).toBe(false);
  expect(() => gunzipSync(bytes)).toThrow();
});

it("rejects a caller-created self label and a re-signed destination rewrite even inside a valid recipient envelope", async () => {
  const { source, a, b, transferId, sourcePeer } = await frozen();
  const exported = await source.exportBundle(transferId);
  const original = exported.manifest;
  // Consume the real producer even though this case only needs its manifest.
  for await (const chunk of exported.stream) void chunk;
  const attacker = new BodyTransferKeys(b.roots.state);
  const own = attacker.self();
  const forge = async (payload: unknown) => {
    const text = JSON.stringify(payload);
    const signed = Buffer.from(
      JSON.stringify({
        payload: text,
        signature: sign(null, Buffer.from(text), own.signing).toString("base64"),
      }),
    );
    const framed = Buffer.concat([Buffer.from(`${BODY_TRANSFER_FORMAT}\n${signed.length}\n`), signed]);
    const chunks: Buffer[] = [];
    for await (const chunk of attacker.seal(
      Readable.from([gzipSync(framed)]),
      a.transfer.authority({ transfers: true }).bodyIdentity!,
    ))
      chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  // A new signing key cannot claim an existing service-generated self UUID.
  await expect(
    upload(
      a.transfer,
      transferId,
      await forge({ ...original, selfKey: own.publicKey, replaces: [], files: [] }),
      sourcePeer,
    ),
  ).rejects.toMatchObject({ code: "bundle_unreadable" });
  // Copying the original public key/UUID cannot validate a forged manifest signature.
  await expect(
    upload(a.transfer, transferId, await forge({ ...original, replaces: [], files: [] }), sourcePeer),
  ).rejects.toMatchObject({ code: "bundle_unreadable" });
  expect(a.transfer.authority().selfId).toBeUndefined();
  expect(source.authority().state).toBe("frozen");
});

it("re-verifies the stored signed manifest on apply and boot, so crash replay cannot activate a retargeted bundle", async () => {
  const { source, a, transferId, sourcePeer } = await frozen();
  await upload(a.transfer, transferId, await bundle(source, transferId), sourcePeer);
  const path = join(a.roots.state, "transfer/incoming", transferId, "manifest.json");
  const original = await readFile(path, "utf8");
  const signed = JSON.parse(original) as { payload: string; signature: string };
  const manifest = BodyTransferManifestSchema.parse(JSON.parse(signed.payload));
  signed.payload = JSON.stringify({ ...manifest, epoch: manifest.epoch + 1 });
  await writeFile(path, JSON.stringify(signed));
  await expect(a.transfer.apply({ transferId }, ready)).rejects.toMatchObject({
    code: "bundle_signature_invalid",
  });
  expect(a.transfer.authority().selfId).toBeUndefined();
  await writeFile(path, original);
  await a.transfer.apply({ transferId }, ready);
  await writeFile(path, JSON.stringify(signed));
  const crashed = await a.restart();
  expect(crashed.authority()).toMatchObject({ state: "frozen", dormant: true });
  expect(crashed.bootError).toBe("bundle_signature_invalid");
  await writeFile(path, original);
  const active = await a.restart();
  expect(active.authority()).toMatchObject({
    state: "active",
    dormant: false,
    selfId: source.authority().selfId,
  });
});

it("fails closed on legacy in-flight records while allowing dormant status; a legacy self pins keys without changing UUID or losing history", async () => {
  const s = await fixture("legacy"),
    a = await fixture("destination");
  const legacyId = randomUUID(),
    transferId = randomUUID();
  const self = {
    schemaVersion: 1,
    selfId: legacyId,
    epoch: 3,
    state: "frozen",
    transferId,
    transfers: {
      [transferId]: { role: "source", outcome: "frozen", epoch: 3, peer: "A", at: new Date().toISOString() },
    },
  };
  await writeFile(join(s.roots.state, "self.json"), JSON.stringify(self));
  const legacy = await s.restart();
  await expect(legacy.prepareOutgoing()).resolves.toBeUndefined();
  expect(legacy.authority()).toMatchObject({ selfId: legacyId, state: "frozen", dormant: true });
  await expect(legacy.bundleChunk({ transferId, offset: 0 })).rejects.toMatchObject({
    code: "legacy_transfer_unbound",
  });
  await expect(
    legacy.abort({ transferId, destination: "A", discarded: await a.transfer.discard({ transferId }) }),
  ).rejects.toMatchObject({ code: "destination_proof_unverified" });
  await writeFile(
    join(s.roots.state, "self.json"),
    JSON.stringify({ schemaVersion: 1, selfId: legacyId, epoch: 3, state: "active", transfers: {} }),
  );
  await mkdir(join(s.roots.memory, "captain-episodes"));
  await writeFile(join(s.roots.memory, "captain-episodes/history.jsonl"), "legacy history\n");
  const active = await s.restart();
  const next = randomUUID();
  await active.freeze({ transferId: next, destination: "A", destinationPeer: a.peer(next) }, ready);
  expect(active.authority().selfId).toBe(legacyId);
  expect(active.authority().epoch).toBe(4);
  const source = await s.restart();
  await upload(a.transfer, next, await bundle(source, next), s.peer(next));
  await a.transfer.apply({ transferId: next }, ready);
  const destination = await a.restart();
  expect(destination.authority().selfId).toBe(source.authority().selfId);
  expect(await readFile(join(a.roots.memory, "captain-episodes/history.jsonl"), "utf8")).toBe(
    "legacy history\n",
  );
});

it("checks the signed inner destination even when the envelope was encrypted for another body", async () => {
  const { s, source, a, b, transferId, sourcePeer } = await frozen();
  const exported = await source.exportBundle(transferId);
  const manifest = exported.manifest;
  for await (const chunk of exported.stream) void chunk;
  const producer = new BodyTransferKeys(s.roots.state);
  // A real source signature still names A. A ciphertext wrapper for B cannot retarget it.
  const signed = Buffer.from(producer.signManifest({ ...manifest, replaces: [], files: [] }));
  const framed = Buffer.concat([Buffer.from(`${BODY_TRANSFER_FORMAT}\n${signed.length}\n`), signed]);
  const pieces: Buffer[] = [];
  for await (const chunk of producer.seal(
    Readable.from([gzipSync(framed)]),
    b.transfer.authority({ transfers: true }).bodyIdentity!,
  ))
    pieces.push(Buffer.from(chunk));
  await expect(upload(b.transfer, transferId, Buffer.concat(pieces), sourcePeer)).rejects.toMatchObject({
    code: "bundle_unreadable",
  });
  expect(b.transfer.authority().selfId).toBeUndefined();
  expect(manifest.destinationIdentity).toEqual(a.transfer.authority({ transfers: true }).bodyIdentity);
});

it("verifies destination identity at the actual peer rather than accepting a coordinator's key claim", async () => {
  const s = await fixture("source-verifier"),
    a = await fixture("real-destination"),
    b = await fixture("other-body");
  const transferId = randomUUID();
  const wrong = { ...a.peer(transferId), ticket: b.peer(transferId).ticket };
  await expect(
    s.transfer.freeze({ transferId, destination: "A", destinationPeer: wrong }, ready),
  ).rejects.toMatchObject({ code: "body_peer_unverified" });
  expect(s.transfer.authority()).toMatchObject({ state: "active", epoch: 0 });
  expect(s.transfer.authority().selfId).toBeUndefined();
  await expect(
    s.transfer.freeze({ transferId, destination: "A", destinationPeer: a.peer(transferId) }, ready),
  ).resolves.toMatchObject({ state: "frozen" });
});

it("expires and scopes peer capabilities, and refuses replayed replies to a fresh request", async () => {
  const a = await fixture("peer-scope"),
    id = randomUUID();
  const descriptor = a.peer(id);
  await expect(readBodyTransferPeer(descriptor, randomUUID(), fetch)).rejects.toThrow(
    "body_peer_transfer_mismatch",
  );
  const otherId = randomUUID();
  await expect(
    readBodyTransferPeer(
      { ...descriptor, ticket: { ...descriptor.ticket, transferId: otherId } },
      otherId,
      fetch,
    ),
  ).rejects.toThrow("body_peer_unavailable");
  const first = await readBodyTransferPeer(descriptor, id, fetch);
  expect(first.witness).toMatchObject({ requestId: first.requestId });
  let captured = "";
  const capture: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    captured = await response.text();
    return new Response(captured, { status: response.status });
  };
  await readBodyTransferPeer(descriptor, id, capture);
  const replay: typeof fetch = async () => new Response(captured);
  await expect(readBodyTransferPeer(descriptor, id, replay)).rejects.toThrow();
  const path = join(a.roots.state, "transfer", "peer-tickets", descriptor.ticket.ticketId + ".json");
  await writeFile(
    path,
    JSON.stringify({ ...descriptor.ticket, expiresAt: new Date(Date.now() - 1000).toISOString() }),
  );
  await expect(readBodyTransferPeer(descriptor, id, fetch)).rejects.toThrow("body_peer_unavailable");
});

it("rechecks owner authority after the peer call before freeze or stage writes", async () => {
  const s = await fixture("revoked-source"),
    a = await fixture("revoked-destination");
  const id = randomUUID();
  let authorized = 0;
  const routes = createBodyTransferRoutes({
    transfer: s.transfer,
    authorize: async () => (++authorized === 1 ? true : "forbidden"),
    cutover: ready,
  });
  const rejected = await routes.request("/v1/body-transfer/freeze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transferId: id, destination: "A", destinationPeer: a.peer(id) }),
  });
  expect(rejected.status).toBe(403);
  expect(await rejected.json()).toEqual({ error: "owner_authority_changed" });
  expect(s.transfer.authority()).toMatchObject({ state: "active", epoch: 0 });
  await s.transfer.freeze({ transferId: id, destination: "A", destinationPeer: a.peer(id) }, ready);
  const source = await s.restart(),
    bytes = await bundle(source, id);
  await a.transfer.stageChunk({ transferId: id, offset: 0, bytesBase64: bytes.toString("base64") });
  authorized = 0;
  const destinationRoutes = createBodyTransferRoutes({
    transfer: a.transfer,
    authorize: async () => (++authorized === 1 ? true : "forbidden"),
  });
  const stage = await destinationRoutes.request("/v1/body-transfer/stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transferId: id,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourcePeer: s.peer(id),
    }),
  });
  expect(stage.status).toBe(403);
  expect(await stage.json()).toEqual({ error: "owner_authority_changed" });
  expect(a.transfer.authority().selfId).toBeUndefined();
  const ownerOnly = await destinationRoutes.request("/v1/body-transfer/prepare", {
    method: "POST",
    body: JSON.stringify({ transferId: id }),
  });
  expect(ownerOnly.status).toBe(403);
});
