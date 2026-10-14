import { S3Client, CreateBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { ClankieSettingsSchema } from "@clankie/settings";
import {
  EVIDENCE_FETCH_PATH,
  EVIDENCE_UPLOADS_PATH,
  EvidenceReceiptSchema,
} from "@clankie/protocol/evidence";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { EvidenceStore, createEvidenceRoutes } from "../src/evidence-store.ts";
import { S3EvidenceBlobs } from "../src/evidence-s3.ts";
import { runEvidenceCommand } from "../../tui/src/command/evidence.ts";

const exec = promisify(execFile);
const minioConfig = process.env.EVIDENCE_S3_MINIO_CONFIG;

/**
 * Manual local protocol proof: start owned MinIO under clankie heavy --server,
 * then supply its private disposable binding file. No SDK mocks, AWS provider
 * chain, production destination, hosted acceptance, or service is started by CI.
 */
it.runIf(Boolean(minioConfig))(
  "pushes and fetches through real MinIO while preserving receipts, TTL and prefix/auth boundaries",
  async () => {
    const config = JSON.parse(await readFile(minioConfig!, "utf8")) as {
      endpoint: string;
      accessKeyId: string;
      secretAccessKey: string;
    };
    const endpoint = new URL(config.endpoint);
    expect(endpoint.protocol).toBe("http:");
    expect(endpoint.hostname).toBe("127.0.0.1");
    expect(endpoint.username).toBe("");
    expect(endpoint.password).toBe("");
    const client = new S3Client({
      region: "us-east-1",
      endpoint: endpoint.origin,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    const root = await mkdtemp(join(tmpdir(), "s3-evidence-"));
    const repo = join(root, "repo");
    const folder = join(repo, "docs/testing/proof");
    await mkdir(folder, { recursive: true });
    await exec("git", ["-C", repo, "init", "-b", "main"]);
    await exec("git", [
      "-C",
      repo,
      "-c",
      "user.name=Local proof",
      "-c",
      "user.email=proof@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "local protocol proof",
    ]);
    const bytes = Buffer.from("VUH-1913 real local MinIO protocol proof\n".repeat(600));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(folder, "README.md"), "# LOCAL-VUH-1913\nLocal protocol proof only.\n");
    await writeFile(join(folder, "capture.txt"), bytes);
    expect(ClankieSettingsSchema.parse({ schemaVersion: 1 }).evidence.backend).toBe("local");
    const bucket = "vuh1913-" + randomUUID();
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const blobs = new S3EvidenceBlobs(
      { backend: "s3", bucket, region: "us-east-1", prefix: "first" },
      client,
    );
    const otherBlobs = new S3EvidenceBlobs(
      { backend: "s3", bucket, region: "us-east-1", prefix: "other" },
      client,
    );
    const store = EvidenceStore.withLocalMetadata(join(root, "state"), blobs, { s3Client: client });
    // Same metadata retains the original recorded prefix even when the fixture's
    // active prefix changes. Hosted tenant metadata delivery remains separate.
    const otherStore = EvidenceStore.withLocalMetadata(join(root, "state"), otherBlobs, { s3Client: client });
    const token = randomUUID();
    const actor = { kind: "operator" as const, id: "owned-local-proof", onBehalfOf: [] };
    const authenticate = async (request: Request) =>
      request.headers.get("authorization") === "Bearer " + token ? actor : undefined;
    const app = createEvidenceRoutes(store, authenticate);
    const otherApp = createEvidenceRoutes(otherStore, authenticate);
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const host = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
    const options = { cwd: repo, host, env: { CLANKIE_OPERATOR_TOKEN: token }, stderr: { write() {} } };
    const headers = { authorization: "Bearer " + token, "content-type": "application/json" };
    let summary: Record<string, unknown> | undefined;
    try {
      const push = await runEvidenceCommand(
        ["push", "docs/testing/proof", "--issue", "LOCAL-VUH-1913"],
        options,
      );
      expect(push.ok).toBe(true);
      const pushBody = push.body as { receipts: { receiptId: string; state: string }[] };
      expect(pushBody.receipts.map((row) => row.state)).toEqual(["applied"]);
      const manifest = await readFile(join(folder, "evidence.json"), "utf8");
      const object = JSON.parse(manifest).objects[0] as { sha256: string; url: string };
      expect(object.sha256).toBe(sha256);
      expect(object.url).toBe("clankie://evidence/sha256/" + sha256);
      const repeat = await runEvidenceCommand(
        ["push", "docs/testing/proof", "--issue", "LOCAL-VUH-1913"],
        options,
      );
      expect(repeat.ok).toBe(true);
      expect(await readFile(join(folder, "evidence.json"), "utf8")).toBe(manifest);
      const signed = await store.fetch({ sha256 });
      const url = new URL(signed.url);
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
      const signedAt = url.searchParams.get("X-Amz-Date")!;
      const signingTime = Date.UTC(
        Number(signedAt.slice(0, 4)),
        Number(signedAt.slice(4, 6)) - 1,
        Number(signedAt.slice(6, 8)),
        Number(signedAt.slice(9, 11)),
        Number(signedAt.slice(11, 13)),
        Number(signedAt.slice(13, 15)),
      );
      expect(Date.parse(signed.expiresAt)).toBe(signingTime + 900_000);
      const downloaded = await fetch(signed.url);
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-type")).toBe("application/octet-stream");
      expect(downloaded.headers.get("content-disposition")).toBe("attachment");
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);
      const mirror = join(repo, ".local/evidence/docs/testing/proof/capture.txt");
      await rm(mirror);
      const fetched = await runEvidenceCommand(["fetch", "docs/testing/proof"], options);
      expect(fetched.ok).toBe(true);
      expect(await readFile(mirror)).toEqual(bytes);
      const range = await store.deviceFetch({ sha256, offset: 7, length: 113 });
      expect(Buffer.from(range.data, "base64")).toEqual(bytes.subarray(7, 120));
      await expect(store.deviceFetch({ sha256, offset: bytes.length + 1, length: 1 })).rejects.toMatchObject({
        status: 400,
        code: "invalid_request",
      });
      const opened = await blobs.open(sha256);
      expect(Buffer.from(await new Response(opened!.body).arrayBuffer())).toEqual(bytes);
      const denied = await fetch(host + EVIDENCE_FETCH_PATH, {
        method: "POST",
        body: JSON.stringify({ sha256 }),
        headers: { "content-type": "application/json" },
      });
      expect(denied.status).toBe(401);
      expect(await otherBlobs.has(sha256)).toBe(false);
      const otherFetch = await otherApp.request(EVIDENCE_FETCH_PATH, {
        method: "POST",
        headers,
        body: JSON.stringify({ sha256 }),
      });
      expect(otherFetch.status).toBe(200);
      const historical = (await otherFetch.json()) as { url: string };
      expect(
        createHash("sha256")
          .update(Buffer.from(await (await fetch(historical.url)).arrayBuffer()))
          .digest("hex"),
      ).toBe(sha256);
      // Acceptance's hash/size boundary: refused bytes never enter either prefix.
      const wrongHash = createHash("sha256").update("different bytes").digest("hex");
      for (const [expectedHash, size, refusal] of [
        [wrongHash, bytes.length, "sha256_mismatch"],
        [wrongHash, bytes.length + 1, "size_mismatch"],
      ] as const) {
        const upload = await fetch(host + EVIDENCE_UPLOADS_PATH, {
          method: "POST",
          headers,
          body: JSON.stringify({
            idempotencyKey: randomUUID(),
            sha256: expectedHash,
            size,
            fileName: "refused.txt",
            contentType: "text/plain",
          }),
        });
        expect(upload.status).toBe(200);
        const pending = EvidenceReceiptSchema.parse(await upload.json());
        const result = await fetch(new URL(pending.uploadUrl!, host), { method: "PUT", body: bytes });
        expect(result.status).toBe(422);
        const receipt = EvidenceReceiptSchema.parse(await result.json());
        expect(receipt.state).toBe("refused");
        expect(receipt.refusal).toBe(refusal);
        expect(await blobs.has(expectedHash)).toBe(false);
      }
      const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "first/" }));
      expect(objects.Contents?.length).toBe(1);
      expect((await store.list({ issueKey: "LOCAL-VUH-1913" })).length).toBe(1);
      summary = {
        outcome: "passed",
        proof: "production-SDK-real-local-MinIO",
        hostedAcceptance: false,
        checkedAt: new Date().toISOString(),
        sha256,
        size: bytes.length,
        bucket,
        status: store.status(),
        receiptIds: pushBody.receipts,
        signedTTLSeconds: 900,
        checks: [
          "local-default",
          "CLI-push-service-JSON-receipt",
          "stable-manifest-repeat",
          "signed-GET-TTL-expiry",
          "opaque-attachment",
          "CLI-fetch-SHA256",
          "device-range",
          "offset-invalid-request-refusal",
          "blob-open",
          "unauthenticated-refusal",
          "other-prefix-refusal",
          "SHA256-refusal",
          "size-refusal",
          "single-object-record",
        ],
      };
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      otherStore.close();
      store.close();
      client.destroy();
      await rm(root, { recursive: true, force: true });
    }
    if (summary && process.env.EVIDENCE_S3_PROOF_OUTPUT)
      await writeFile(
        process.env.EVIDENCE_S3_PROOF_OUTPUT,
        JSON.stringify({ ...summary, localServiceStopped: true, localStoreRemoved: true }, null, 2) + "\n",
      );
  },
);
