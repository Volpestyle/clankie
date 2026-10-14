import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { EvidenceReceiptSchema, type EvidenceReceipt } from "@clankie/protocol/evidence";
import { serve } from "@hono/node-server";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { EvidenceStore, createEvidenceRoutes } from "../src/evidence-store.ts";
import { S3EvidenceBlobs } from "../src/evidence-s3.ts";
import { prepareLegacyEvidence } from "../src/evidence-storage.ts";
import { runEvidenceCommand } from "../../tui/src/command/evidence.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (name: string) => Buffer.from(`${name}: private disposable evidence\n`.repeat(600));
const configPath = process.env.EVIDENCE_STORAGE_MINIO_CONFIG;
const exec = promisify(execFile);

async function httpFixture(
  root: string,
  initial: EvidenceStore,
  operatorId = "disposable-evidence-operator",
) {
  const broker = new FileCredentialStore(join(root, "broker.json"));
  const credential = await ensureOperatorCredential({ env: {}, store: broker });
  const authenticator = createCredentialBackedOperatorAuthenticator({
    env: {},
    store: broker,
    identity: { operatorId },
  });
  const authenticate = async (request: Request) => {
    const operator = await authenticator(request);
    return operator ? { kind: "operator" as const, id: operator.operatorId, onBehalfOf: [] } : undefined;
  };
  let app = createEvidenceRoutes(initial, authenticate);
  const server = serve({ fetch: (request) => app.fetch(request), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method = "GET", body?: unknown, token = credential.token) =>
    fetch(origin + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const claim = async (bytes: Buffer, idempotencyKey = randomUUID(), issueKey = "LOCAL-VUH-1913") => {
    const request = {
      idempotencyKey,
      sha256: digest(bytes),
      size: bytes.length,
      fileName: "capture.txt",
      contentType: "text/plain",
      issueKey,
    };
    const response = await call("/v1/evidence/uploads", "POST", request);
    expect(response.status).toBe(200);
    return { request, receipt: EvidenceReceiptSchema.parse(await response.json()) };
  };
  const put = async (receipt: EvidenceReceipt, bytes: Buffer) => {
    const response = await fetch(new URL(receipt.uploadUrl!, origin), {
      method: "PUT",
      body: Uint8Array.from(bytes),
    });
    expect(response.status).toBe(200);
    return EvidenceReceiptSchema.parse(await response.json());
  };
  const upload = async (bytes: Buffer, issueKey?: string) => {
    const pending = await claim(bytes, randomUUID(), issueKey);
    return pending.receipt.state === "applied" ? pending.receipt : put(pending.receipt, bytes);
  };
  const download = async (bytes: Buffer) => {
    const response = await call("/v1/evidence/fetch", "POST", { sha256: digest(bytes) });
    expect(response.status).toBe(200);
    const link = (await response.json()) as { url: string; expiresAt: string; size: number };
    expect(link.size).toBe(bytes.length);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
    const fetched = await fetch(new URL(link.url, origin));
    expect(fetched.status).toBe(200);
    expect(digest(Buffer.from(await fetched.arrayBuffer())) === digest(bytes)).toBe(true);
  };
  return {
    origin,
    broker,
    call,
    claim,
    put,
    upload,
    download,
    use(store: EvidenceStore) {
      app = createEvidenceRoutes(store, authenticate);
    },
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

it("preserves verified legacy local reads without tagging from current settings and refuses unknown auth/records", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-storage-local-"));
  const state = join(root, "state");
  let store = EvidenceStore.local(state);
  const http = await httpFixture(root, store);
  try {
    const bytes = bytesOf("unchanged-local");
    const receipt = await http.upload(bytes);
    store.close();
    const legacy = new DatabaseSync(join(state, "evidence.sqlite"));
    legacy.exec("ALTER TABLE records DROP COLUMN destination; ALTER TABLE uploads DROP COLUMN destination");
    legacy.close();
    store = EvidenceStore.local(state);
    http.use(store);
    await http.download(bytes);
    expect(
      (await store.metadata.legacyItem({ recordId: receipt.recordId! }))?.destination === undefined,
    ).toBe(true);
    expect((await http.call("/v1/evidence/fetch", "POST", { sha256: digest(bytes) }, "invalid")).status).toBe(
      401,
    );
    expect((await http.call("/v1/evidence/fetch", "POST", { sha256: "0".repeat(64) })).status).toBe(404);
    expect((await http.call("/v1/evidence/receipts/unknown")).status).toBe(404);
    expect(await store.record("unknown")).toBeUndefined();
    const other = await httpFixture(join(root, "other-operator"), store, "other-disposable-operator");
    try {
      expect((await other.call("/v1/evidence/receipts/" + receipt.receiptId)).status).toBe(404);
    } finally {
      await other.close();
    }
    const mismatchedSize = await http.call("/v1/evidence/uploads", "POST", {
      idempotencyKey: randomUUID(),
      sha256: digest(bytes),
      size: bytes.length + 1,
      fileName: "capture.txt",
      contentType: "text/plain",
    });
    expect(EvidenceReceiptSchema.parse(await mismatchedSize.json())).toMatchObject({
      state: "refused",
      refusal: "size_mismatch",
    });
    const prepared = await prepareLegacyEvidence(store.metadata, store.storage, { backend: "local" }, [
      { recordId: receipt.recordId! },
      { recordId: "unknown" },
    ]);
    expect(prepared.complete).toBe(false);
    expect(prepared.results.map((row) => row.outcome)).toEqual(["prepared", "unknown_item"]);
    await http.download(bytes);
    expect(
      digest(await readFile(join(state, "blobs/sha256", digest(bytes).slice(0, 2), digest(bytes)))) ===
        digest(bytes),
    ).toBe(true);
  } finally {
    await http.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("continues only explicitly admitted exact legacy local uploads with full incoming verification and a real transactional CAS", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-local-continuation-")),
    state = join(root, "state");
  let store = EvidenceStore.local(state);
  const http = await httpFixture(root, store);
  const actorKey = "operator:disposable-evidence-operator";
  let summary: Record<string, unknown> | undefined;
  const waitFor = async (condition: () => Promise<boolean>) => {
    const until = Date.now() + 5_000;
    while (!(await condition())) {
      if (Date.now() >= until) throw new Error("owned HTTP staging did not reach expected boundary");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const incoming = () => readdir(join(state, "blobs/incoming"));
  const send = (receipt: EvidenceReceipt, bytes: Buffer) =>
    fetch(new URL(receipt.uploadUrl!, http.origin), { method: "PUT", body: Uint8Array.from(bytes) });
  const pendingIsUnknown = async (receipt: EvidenceReceipt) => {
    const row = await store.metadata.findUpload(actorKey, receipt.receiptId);
    expect(row?.state).toBe("pending");
    expect(row?.destination === undefined).toBe(true);
  };
  const streamed = (receipt: EvidenceReceipt, bytes: Buffer, signal?: AbortSignal) => {
    let source: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
        controller.enqueue(Uint8Array.from(bytes.subarray(0, 17)));
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "PUT",
      body,
      duplex: "half",
      ...(signal ? { signal } : {}),
    };
    const response = fetch(new URL(receipt.uploadUrl!, http.origin), init);
    return {
      response,
      finish() {
        source.enqueue(Uint8Array.from(bytes.subarray(17)));
        source.close();
      },
    };
  };
  try {
    const originalBytes = bytesOf("existing-original"),
      successfulBytes = bytesOf("new-local-continuation"),
      shortBytes = bytesOf("short-local-continuation"),
      cancelledBytes = bytesOf("cancelled-local-continuation"),
      racedBytes = bytesOf("CAS-local-continuation");
    // These are genuine production claims; the original bytes appear under a different real upload afterward.
    const sameSha = await http.claim(originalBytes),
      taggedBeforePut = await http.claim(originalBytes);
    const successful = await http.claim(successfulBytes),
      short = await http.claim(shortBytes),
      cancelled = await http.claim(cancelledBytes),
      raced = await http.claim(racedBytes);
    const original = await http.upload(originalBytes);
    store.close();
    const oldSchema = new DatabaseSync(join(state, "evidence.sqlite"));
    oldSchema.exec(
      "ALTER TABLE records DROP COLUMN destination; ALTER TABLE uploads DROP COLUMN destination",
    );
    oldSchema.close();
    store = EvidenceStore.local(state);
    http.use(store);
    expect((await http.call("/v1/evidence/receipts/" + successful.receipt.receiptId)).status).toBe(503);
    await pendingIsUnknown(successful.receipt);
    await expect(
      store.admitLegacyLocalUpload(
        "operator:other-disposable-operator",
        successful.receipt.receiptId,
        successful.request,
      ),
    ).rejects.toMatchObject({ code: "unknown_receipt" });
    await expect(
      store.admitLegacyLocalUpload(actorKey, successful.receipt.receiptId, {
        ...successful.request,
        caption: "different immutable caption",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const admitted = await store.admitLegacyLocalUpload(
      actorKey,
      successful.receipt.receiptId,
      successful.request,
    );
    await pendingIsUnknown(admitted);
    const wrongActor = new URL(admitted.uploadUrl!, http.origin);
    wrongActor.pathname = EvidenceStore.uploadPath("operator:other-disposable-operator", admitted.receiptId);
    expect((await fetch(wrongActor, { method: "PUT", body: Uint8Array.from(successfulBytes) })).status).toBe(
      403,
    );
    const applied = await http.put(admitted, successfulBytes);
    expect(applied.state).toBe("applied");
    const successRow = await store.metadata.findUpload(actorKey, admitted.receiptId);
    expect(successRow?.destination?.backend).toBe("local");
    expect((await http.call("/v1/evidence/receipts/" + admitted.receiptId)).status).toBe(200);
    expect((await send(admitted, successfulBytes)).status).toBe(409);
    await expect(
      store.admitLegacyLocalUpload(actorKey, admitted.receiptId, successful.request),
    ).rejects.toMatchObject({ code: "legacy_continuation_conflict" });
    const originalPath = join(
      state,
      "blobs/sha256",
      digest(originalBytes).slice(0, 2),
      digest(originalBytes),
    );
    const inode = (await stat(originalPath)).ino;
    const sameShaAdmission = await store.admitLegacyLocalUpload(
      actorKey,
      sameSha.receipt.receiptId,
      sameSha.request,
    );
    const wrongIncoming = Buffer.from(originalBytes);
    wrongIncoming[0] = wrongIncoming[0]! ^ 1;
    const wrong = await send(sameShaAdmission, wrongIncoming);
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toEqual({ error: "sha256_mismatch" });
    await pendingIsUnknown(sameShaAdmission);
    expect(digest(await readFile(originalPath))).toBe(digest(originalBytes));
    expect((await stat(originalPath)).ino).toBe(inode);
    expect((await http.call("/v1/evidence/receipts/" + sameShaAdmission.receiptId)).status).toBe(200);
    expect((await http.put(sameShaAdmission, originalBytes)).state).toBe("applied");
    expect((await stat(originalPath)).ino).toBe(inode); // even a successful continuation never replaces an original.
    const shortAdmission = await store.admitLegacyLocalUpload(
      actorKey,
      short.receipt.receiptId,
      short.request,
    );
    const shortResponse = await send(shortAdmission, shortBytes.subarray(0, 31));
    expect(shortResponse.status).toBe(422);
    expect(await shortResponse.json()).toEqual({ error: "size_mismatch" });
    await pendingIsUnknown(shortAdmission);
    const cancelledAdmission = await store.admitLegacyLocalUpload(
      actorKey,
      cancelled.receipt.receiptId,
      cancelled.request,
    );
    const abort = new AbortController();
    const partial = streamed(cancelledAdmission, cancelledBytes, abort.signal);
    const aborted = partial.response.catch(() => undefined);
    await waitFor(async () => (await incoming()).length === 1);
    abort.abort();
    await aborted;
    await waitFor(async () => (await incoming()).length === 0);
    await pendingIsUnknown(cancelledAdmission);
    const racedAdmission = await store.admitLegacyLocalUpload(
      actorKey,
      raced.receipt.receiptId,
      raced.request,
    );
    const first = streamed(racedAdmission, racedBytes);
    await waitFor(async () => (await incoming()).length === 1);
    const winner = await http.put(racedAdmission, racedBytes);
    first.finish();
    const loser = await first.response;
    expect(loser.status).toBe(409);
    expect(await loser.json()).toEqual({ error: "legacy_continuation_conflict" });
    const raceRow = await store.metadata.findUpload(actorKey, racedAdmission.receiptId);
    expect(raceRow?.recordId).toBe(winner.recordId);
    expect(raceRow?.destination?.backend).toBe("local");
    expect(
      (await store.list({ issueKey: "LOCAL-VUH-1913" })).filter(
        (record) => record.sha256 === digest(racedBytes),
      ),
    ).toHaveLength(1);
    await http.download(racedBytes);
    await waitFor(async () => (await incoming()).length === 0);
    const staleAdmission = await store.admitLegacyLocalUpload(
      actorKey,
      taggedBeforePut.receipt.receiptId,
      taggedBeforePut.request,
    );
    expect(
      (
        await prepareLegacyEvidence(store.metadata, store.storage, { backend: "local" }, [
          { actorKey, idempotencyKey: staleAdmission.receiptId },
        ])
      ).complete,
    ).toBe(true);
    const taggedConflict = await send(staleAdmission, originalBytes);
    expect(taggedConflict.status).toBe(409);
    const taggedRow = await store.metadata.findUpload(actorKey, staleAdmission.receiptId);
    expect(taggedRow?.state).toBe("pending");
    expect(taggedRow?.destination?.backend).toBe("local");
    expect((await stat(originalPath)).ino).toBe(inode);
    expect((await store.record(original.recordId!))?.sha256).toBe(digest(originalBytes));
    summary = {
      outcome: "passed",
      proof: "production-local-continuation-real-broker-auth-SQLite-files-actual-HTTP",
      checkedAt: new Date().toISOString(),
      recordIds: [original.recordId, applied.recordId, winner.recordId],
      checks: [
        "unadmitted-NULL-refusal",
        "exact-actor-receipt-full-request-admission",
        "HMAC-actor-binding",
        "no-tag-at-admission-lookup",
        "full-incoming-existing-SHA-mismatch-preserves-original-inode",
        "successful-verified-local-transactional-settlement",
        "short-body-NULL-pending-preserved",
        "actual-HTTP-cancellation-staging-removed-NULL-pending",
        "real-concurrent-CAS-loser-409-no-duplicate-record",
        "tag-before-PUT-refusal-no-ordinary-fallback",
        "settled-tombstone-rejects-old-PUT",
      ],
      hostedAcceptance: false,
      fullServiceStartup: false,
      ownerStoreSwitched: false,
    };
  } finally {
    await http.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
  if (summary && process.env.EVIDENCE_STORAGE_CONTINUATION_PROOF_OUTPUT)
    await writeFile(
      process.env.EVIDENCE_STORAGE_CONTINUATION_PROOF_OUTPUT,
      JSON.stringify(
        { ...summary, httpServerStopped: true, sqliteClosed: true, fixtureRootRemoved: true },
        null,
        2,
      ) + "\n",
    );
});

/** Manual trust-boundary proof with real SDK/MinIO, broker authentication, SQLite/files, and HTTP.
 * The service routes are the production routes; no captain, authentication or backend is mocked.
 * Fixture configuration changes do not activate or switch an owner service.
 */
it.runIf(Boolean(configPath))(
  "retains claimed/recorded destinations across local, bucket, prefix and restart boundaries",
  async () => {
    const config = JSON.parse(await readFile(configPath!, "utf8")) as {
      endpoint: string;
      accessKeyId: string;
      secretAccessKey: string;
    };
    const endpoint = new URL(config.endpoint);
    expect(
      endpoint.protocol === "http:" &&
        endpoint.hostname === "127.0.0.1" &&
        endpoint.username === "" &&
        endpoint.password === "",
    ).toBe(true);
    const client = new S3Client({
      region: "us-east-1",
      endpoint: endpoint.origin,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    const root = await mkdtemp(join(tmpdir(), "evidence-storage-minio-"));
    const state = join(root, "state");
    const buckets = ["evidence-a-" + randomUUID(), "evidence-b-" + randomUUID()];
    for (const bucket of buckets) await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const first = new S3EvidenceBlobs(
      { backend: "s3", bucket: buckets[0]!, region: "us-east-1", prefix: "first" },
      client,
    );
    const prefix = new S3EvidenceBlobs(
      { backend: "s3", bucket: buckets[0]!, region: "us-east-1", prefix: "second" },
      client,
    );
    const bucket = new S3EvidenceBlobs(
      { backend: "s3", bucket: buckets[1]!, region: "us-east-1", prefix: "third" },
      client,
    );
    let store = EvidenceStore.local(state, { s3Client: client });
    const http = await httpFixture(root, store);
    const change = (blobs?: S3EvidenceBlobs) => {
      store.close();
      store = blobs
        ? EvidenceStore.withLocalMetadata(state, blobs, { s3Client: client })
        : EvidenceStore.local(state, { s3Client: client });
      http.use(store);
    };
    let summary: Record<string, unknown> | undefined;
    try {
      const localBytes = bytesOf("local-original"),
        s3Bytes = bytesOf("s3-original"),
        prefixBytes = bytesOf("prefix-original"),
        bucketBytes = bytesOf("bucket-original");
      const localReceipt = await http.upload(localBytes, "LOCAL-LOCAL");
      const localPending = await http.claim(bytesOf("pending-local"));
      change(first);
      await http.download(localBytes);
      const capturedLocal = await http.call("/v1/evidence/uploads", "POST", localPending.request);
      const capturedLocalReceipt = EvidenceReceiptSchema.parse(await capturedLocal.json());
      expect(capturedLocalReceipt.state).toBe("pending");
      const localApplied = await http.put(capturedLocalReceipt, bytesOf("pending-local"));
      expect(await first.has(digest(bytesOf("pending-local")))).toBe(false);
      await http.download(bytesOf("pending-local"));
      const s3Receipt = await http.upload(s3Bytes, "LOCAL-S3");
      const sameShaS3 = await http.upload(localBytes, "LOCAL-DUPLICATE");
      const pendingS3 = await http.claim(bytesOf("pending-s3"));
      const storedPending = await store.metadata.findUpload(
        "operator:disposable-evidence-operator",
        pendingS3.receipt.receiptId,
      );
      expect(JSON.stringify(storedPending?.destination) === JSON.stringify(first.destination)).toBe(true);
      change(prefix);
      await http.download(s3Bytes);
      const repeated = await http.call("/v1/evidence/uploads", "POST", pendingS3.request);
      const freshPending = EvidenceReceiptSchema.parse(await repeated.json());
      expect(freshPending.state).toBe("pending");
      const pendingS3Applied = await http.put(freshPending, bytesOf("pending-s3"));
      expect(await first.has(digest(bytesOf("pending-s3")))).toBe(true);
      expect(await prefix.has(digest(bytesOf("pending-s3")))).toBe(false);
      const prefixReceipt = await http.upload(prefixBytes, "LOCAL-PREFIX");
      change(bucket);
      await http.download(localBytes);
      await http.download(s3Bytes);
      await http.download(prefixBytes);
      const bucketReceipt = await http.upload(bucketBytes, "LOCAL-BUCKET");
      const sameShaBucket = await http.upload(localBytes, "LOCAL-DUPLICATE-BUCKET");
      change(bucket); // reopen durable SQLite with a new process signing key/resolver.
      for (const bytes of [
        localBytes,
        s3Bytes,
        prefixBytes,
        bucketBytes,
        bytesOf("pending-local"),
        bytesOf("pending-s3"),
      ])
        await http.download(bytes);
      const repeatedSettled = await http.call("/v1/evidence/uploads", "POST", pendingS3.request);
      const settled = EvidenceReceiptSchema.parse(await repeatedSettled.json());
      const settledPending = await store.metadata.findUpload(
        "operator:disposable-evidence-operator",
        pendingS3.receipt.receiptId,
      );
      expect(JSON.stringify(settledPending?.destination) === JSON.stringify(first.destination)).toBe(true);
      expect(settled.recordId).toBe(pendingS3Applied.recordId);
      const binding = await store.metadata.findBlobBinding(digest(localBytes));
      expect(binding?.record.id).toBe(localReceipt.recordId);
      expect(binding?.destination?.backend).toBe("local");
      for (const receipt of [localReceipt, sameShaS3, sameShaBucket])
        expect((await store.record(receipt.recordId!))?.sha256).toBe(digest(localBytes));
      for (const bytes of [localBytes, s3Bytes, prefixBytes, bucketBytes]) {
        const device = await store.deviceFetch({ sha256: digest(bytes), offset: 7, length: 113 });
        expect(digest(Buffer.from(device.data, "base64")) === digest(bytes.subarray(7, 120))).toBe(true);
        const projection = JSON.stringify(device);
        expect(
          [
            "destination",
            "bucket",
            "region",
            "prefix",
            "http",
            config.accessKeyId,
            config.secretAccessKey,
          ].some((value) => projection.includes(value)),
        ).toBe(false);
      }
      const listed = await http.call("/v1/evidence/records?issue=LOCAL-S3");
      const publicJson = JSON.stringify({
        receipt: s3Receipt,
        record: await store.record(s3Receipt.recordId!),
        list: await listed.json(),
        recent: await store.metadata.recent({ limit: 10 }),
      });
      expect(
        ["destination", ...buckets, config.accessKeyId, config.secretAccessKey].some((value) =>
          publicJson.includes(value),
        ),
      ).toBe(false);
      // Existing binding and signed authority, even after the active destination changes.
      const originalLocalLink = await store.fetch({ sha256: digest(localBytes) });
      expect(new URL(originalLocalLink.url, http.origin).origin === http.origin).toBe(true);
      expect((await fetch(new URL(originalLocalLink.url, http.origin))).status).toBe(200);
      expect(
        (await http.call("/v1/evidence/fetch", "POST", { sha256: digest(s3Bytes) }, "bad-token")).status,
      ).toBe(401);
      const unrecorded = bytesOf("unrecorded-sdk-object");
      await bucket.write(
        digest(unrecorded),
        unrecorded.length,
        (async function* () {
          yield unrecorded;
        })(),
      );
      expect((await http.call("/v1/evidence/fetch", "POST", { sha256: digest(unrecorded) })).status).toBe(
        404,
      );
      expect((await store.list({ issueKey: "LOCAL-DUPLICATE" })).map((record) => record.id)).toEqual([
        sameShaS3.recordId,
      ]);
      const legacyPending = await http.claim(bytesOf("legacy-pending"));
      const s3TagRace = await http.claim(s3Bytes);
      store.close();
      const legacy = new DatabaseSync(join(state, "evidence.sqlite"));
      // Actual production uploads become an old-schema fixture; no record or receipt is fabricated.
      legacy.exec("ALTER TABLE records DROP COLUMN destination; ALTER TABLE uploads DROP COLUMN destination");
      legacy.close();
      expect(() => EvidenceStore.withLocalMetadata(state, bucket, { s3Client: client })).toThrow(
        "evidence_legacy_preparation_required",
      );
      store = EvidenceStore.local(state, { s3Client: client });
      http.use(store);
      await http.download(localBytes);
      const unknownS3 = await http.call("/v1/evidence/fetch", "POST", { sha256: digest(s3Bytes) });
      expect(unknownS3.status).toBe(503);
      const partial = await prepareLegacyEvidence(store.metadata, store.storage, { backend: "local" }, [
        { recordId: localReceipt.recordId! },
        { recordId: s3Receipt.recordId! },
        { recordId: "unknown" },
      ]);
      expect(partial.complete).toBe(false);
      expect(partial.results.map((row) => row.outcome)).toEqual([
        "prepared",
        "source_missing",
        "unknown_item",
      ]);
      expect(
        (await store.metadata.legacyItem({ recordId: s3Receipt.recordId! }))?.destination === undefined,
      ).toBe(true);
      expect(await first.has(digest(s3Bytes))).toBe(true);
      expect(
        digest(
          await readFile(join(state, "blobs/sha256", digest(localBytes).slice(0, 2), digest(localBytes))),
        ) === digest(localBytes),
      ).toBe(true);
      for (const [source, receipts] of [
        [{ backend: "local" } as const, [localReceipt, localApplied]],
        [first.destination, [s3Receipt, sameShaS3, pendingS3Applied]],
        [prefix.destination, [prefixReceipt]],
        [bucket.destination, [bucketReceipt, sameShaBucket]],
      ] as const) {
        const prepared = await prepareLegacyEvidence(
          store.metadata,
          store.storage,
          source,
          receipts.map((receipt) => ({ recordId: receipt.recordId! })),
        );
        expect(prepared.complete).toBe(true);
      }
      let continuationClock = Date.now();
      const localBase = store;
      store = new EvidenceStore(localBase.blobs, localBase.metadata, {
        storage: localBase.storage,
        clock: () => continuationClock,
      });
      http.use(store);
      const s3RaceItem = {
        actorKey: "operator:disposable-evidence-operator",
        idempotencyKey: s3TagRace.receipt.receiptId,
      };
      const s3RaceAdmission = await store.admitLegacyLocalUpload(
        s3RaceItem.actorKey,
        s3RaceItem.idempotencyKey,
        s3TagRace.request,
      );
      continuationClock += 899_999;
      const refreshedResponse = await http.call("/v1/evidence/receipts/" + s3RaceAdmission.receiptId);
      expect(refreshedResponse.status).toBe(200);
      const refreshedAdmission = EvidenceReceiptSchema.parse(await refreshedResponse.json());
      continuationClock += 2; // admission expired; refreshed signed PUT is still valid under the production clock contract.
      expect((await http.call("/v1/evidence/receipts/" + s3RaceAdmission.receiptId)).status).toBe(503);
      expect(
        (await prepareLegacyEvidence(store.metadata, store.storage, first.destination, [s3RaceItem]))
          .complete,
      ).toBe(true);
      const s3RaceResponse = await fetch(new URL(refreshedAdmission.uploadUrl!, http.origin), {
        method: "PUT",
        body: Uint8Array.from(s3Bytes),
      });
      expect(s3RaceResponse.status).toBe(409);
      const s3RaceRow = await store.metadata.findUpload(s3RaceItem.actorKey, s3RaceItem.idempotencyKey);
      expect(s3RaceRow?.state).toBe("pending");
      expect(JSON.stringify(s3RaceRow?.destination) === JSON.stringify(first.destination)).toBe(true);
      expect(await bucket.has(digest(s3Bytes))).toBe(false);
      const pendingItem = {
        actorKey: "operator:disposable-evidence-operator",
        idempotencyKey: legacyPending.receipt.receiptId,
      };
      const missingPending = await prepareLegacyEvidence(store.metadata, store.storage, bucket.destination, [
        pendingItem,
      ]);
      expect(missingPending.results.map((row) => row.outcome)).toEqual(["source_missing"]);
      expect(() => EvidenceStore.withLocalMetadata(state, bucket, { s3Client: client })).toThrow(
        "evidence_legacy_preparation_required",
      );
      await bucket.write(
        digest(bytesOf("legacy-pending")),
        bytesOf("legacy-pending").length,
        (async function* () {
          yield bytesOf("legacy-pending");
        })(),
      );
      expect(
        (await prepareLegacyEvidence(store.metadata, store.storage, bucket.destination, [pendingItem]))
          .complete,
      ).toBe(true);
      change(prefix);
      const reconciled = await http.call("/v1/evidence/uploads", "POST", legacyPending.request);
      expect(EvidenceReceiptSchema.parse(await reconciled.json()).state).toBe("applied");
      await http.download(s3Bytes);
      await http.download(localBytes);
      await http.download(bytesOf("legacy-pending"));
      const historical: { bytes: Buffer; recordId: string }[] = [];
      for (let index = 0; index < 34; index++) {
        const destination = new S3EvidenceBlobs(
          { backend: "s3", bucket: buckets[0]!, region: "us-east-1", prefix: `history-${index}` },
          client,
        );
        change(destination);
        const bytes = bytesOf(`history-${index}`);
        const receipt = await http.upload(bytes);
        historical.push({ bytes, recordId: receipt.recordId! });
      }
      change(bucket);
      for (const record of historical) {
        await http.download(record.bytes);
        expect((await store.record(record.recordId))?.sha256).toBe(digest(record.bytes));
      }
      // Earlier descriptors were evicted, but their associations remain readable and reconstructible.
      await http.download(historical[0]!.bytes);
      await http.download(historical[33]!.bytes);
      const repo = join(root, "cli-repo"),
        folder = join(repo, "docs/testing/proof");
      await mkdir(folder, { recursive: true });
      await exec("git", ["-C", repo, "init", "-b", "main"]);
      await exec("git", [
        "-C",
        repo,
        "-c",
        "user.name=Disposable evidence proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "disposable proof",
      ]);
      const cliBytes = bytesOf("cli-broker-authenticated-roundtrip");
      await writeFile(join(folder, "README.md"), "# LOCAL-VUH-1913\nDisposable fixture proof only.\n");
      await writeFile(join(folder, "capture.txt"), cliBytes);
      const cliOptions = { cwd: repo, host: http.origin, env: {}, operatorCredentialStore: http.broker };
      expect(
        (await runEvidenceCommand(["push", "docs/testing/proof", "--issue", "LOCAL-VUH-1913"], cliOptions))
          .ok,
      ).toBe(true);
      const manifest = await readFile(join(folder, "evidence.json"), "utf8");
      const object = JSON.parse(manifest).objects[0] as { sha256: string; url: string };
      expect(object.sha256).toBe(digest(cliBytes));
      expect(object.url).toBe(`clankie://evidence/sha256/${digest(cliBytes)}`);
      expect(
        (await runEvidenceCommand(["push", "docs/testing/proof", "--issue", "LOCAL-VUH-1913"], cliOptions))
          .ok,
      ).toBe(true);
      expect(await readFile(join(folder, "evidence.json"), "utf8")).toBe(manifest);
      await rm(join(repo, ".local/evidence/docs/testing/proof/capture.txt"));
      change(prefix);
      expect((await runEvidenceCommand(["fetch", "docs/testing/proof"], cliOptions)).ok).toBe(true);
      expect(digest(await readFile(join(repo, ".local/evidence/docs/testing/proof/capture.txt")))).toBe(
        digest(cliBytes),
      );
      summary = {
        outcome: "passed",
        proof:
          "production-evidence-routes-real-broker-auth-real-SQLite-files-production-SDK-owned-MinIO-actual-HTTP",
        checkedAt: new Date().toISOString(),
        hostedAcceptance: false,
        fullServiceStartup: false,
        ownerStoreSwitched: false,
        recordIds: [
          localReceipt,
          s3Receipt,
          prefixReceipt,
          bucketReceipt,
          sameShaS3,
          sameShaBucket,
          localApplied,
          pendingS3Applied,
        ].map((receipt) => receipt.recordId),
        checks: [
          "recorded-local-S3-bucket-prefix-reads",
          "bounded-cache-eviction-retains-34-historical-destinations",
          "actual-CLI-broker-auth-push-repeat-manifest-historical-fetch",
          "claim-capture-pending-PUT",
          "idempotency-reopen",
          "same-SHA-deterministic-associations",
          "signed-local-GET-binding",
          "device-ranges",
          "private-metadata-projections",
          "real-broker-auth-refusal",
          "unknown-record-refusal",
          "unrecorded-SDK-object-refusal",
          "unknown-legacy-startup-refusal",
          "verified-local-legacy-no-inference",
          "explicit-SHA-size-preparation",
          "ordinary-missing-source-partial-progress-originals-preserved",
          "legacy-pending-preparation-refusal-reconciliation",
          "S3-tag-before-PUT-refusal-no-fallback",
          "refreshed-link-tombstone-outlives-live-admission",
        ],
        partialPreparation: partial.results.map(({ item, outcome }) => ({ ...item, outcome })),
      };
    } finally {
      await http.close();
      store.close();
      client.destroy();
      await rm(root, { recursive: true, force: true });
    }
    if (summary && process.env.EVIDENCE_STORAGE_PROOF_OUTPUT)
      await writeFile(
        process.env.EVIDENCE_STORAGE_PROOF_OUTPUT,
        JSON.stringify(
          { ...summary, httpServerStopped: true, sqliteClosed: true, fixtureRootRemoved: true },
          null,
          2,
        ) + "\n",
      );
  },
);
