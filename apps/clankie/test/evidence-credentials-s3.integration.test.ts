import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { EVIDENCE_FETCH_PATH } from "@clankie/protocol/evidence";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { pathToFileURL, fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { EvidenceStore, createEvidenceRoutes } from "../src/evidence-store.ts";
import { S3EvidenceBlobs } from "../src/evidence-s3.ts";
import { evidenceS3Client } from "../src/evidence-storage.ts";
import {
  BrokerEvidenceCredentials,
  EvidenceSessionTransient,
  EvidenceSessionDenied,
} from "../src/evidence-credentials.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { fleetFixture } from "./fixtures/evidence-session/fleet.ts";
import { startEvidenceMinio } from "./fixtures/evidence-session/minio.ts";
const exec = promisify(execFile);

/** Explicit manual offline proof: real private handler, public CLI/routes/auth,
 * broker, SQLite and owned MinIO. Never part of hosted acceptance.
 */
it.runIf(Boolean(process.env.EVIDENCE_OFFLINE_MINIO_BINARY && process.env.EVIDENCE_OFFLINE_ISSUER_FIXTURE))(
  "renews tenant credentials through the private offline issuer across CLI push/fetch and historical S3 reads",
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "evidence-offline-s3-"));
    const minio = await startEvidenceMinio(root, process.env.EVIDENCE_OFFLINE_MINIO_BINARY!);
    // Also covers setup failures before the main route/CLI try block.
    context.onTestFinished(async () => {
      await minio.stop();
      await rm(root, { recursive: true, force: true });
    });
    let cleanup: unknown;
    const f = await fleetFixture(root, minio.issueSession);
    const privateFixture = await import(
      /* @vite-ignore */ pathToFileURL(process.env.EVIDENCE_OFFLINE_ISSUER_FIXTURE!).href
    );
    const issuer = await privateFixture.startOfflineEvidenceIssuer({
      directory: root,
      denied: () => new EvidenceSessionDenied(),
      signer: f.signer,
      body: f.body,
      bodyPublic: f.bodyPublic,
      encryptionPublicKey: f.key.getPublicKey().toString("base64url"),
      binding: f.binding,
      clock: () => f.now,
      issueSession: async () => {
        const session = await minio.issueSession();
        f.markers.push(session.accessKeyId, session.secretAccessKey, session.sessionToken);
        return session;
      },
    });
    context.onTestFinished(async () => {
      await issuer.close();
    });
    f.providerOptions.exchange = issuer.exchange;
    const provider = new BrokerEvidenceCredentials(f.providerOptions);
    const transport = new S3Client({
      region: "us-east-1",
      endpoint: minio.endpoint,
      forcePathStyle: true,
      credentials: minio.credentials,
    });
    await transport.send(new CreateBucketCommand({ Bucket: f.destination.bucket }));
    const options = { managedEvidence: true, evidenceCredentials: provider, s3Client: transport };
    const activeClient = evidenceS3Client(f.destination, "write", options);
    let store = EvidenceStore.withLocalMetadata(
      join(root, "state"),
      new S3EvidenceBlobs(f.destination, activeClient),
      options,
    );
    const authBroker = new FileCredentialStore(join(root, "operator-broker.json"));
    const operator = await ensureOperatorCredential({ store: authBroker, env: {} });
    const authenticate = createCredentialBackedOperatorAuthenticator({
      env: {},
      store: authBroker,
      identity: { operatorId: "offline-proof" },
    });
    const actor = async (request: Request) =>
      (await authenticate(request))
        ? { kind: "operator" as const, id: "offline-proof", onBehalfOf: [] }
        : undefined;
    let routes = createEvidenceRoutes(store, actor);
    const server = serve({ fetch: (request) => routes.fetch(request), hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const repo = join(root, "repo"),
      folder = join(repo, "docs/testing/proof");
    const bytes = Buffer.from("offline renewable tenant evidence\n".repeat(600));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const captured: string[] = [];
    try {
      await mkdir(folder, { recursive: true });
      await exec("git", ["-C", repo, "init", "-b", "main"]);
      await exec("git", [
        "-C",
        repo,
        "-c",
        "user.name=Offline fixture",
        "-c",
        "user.email=offline@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ]);
      await writeFile(join(folder, "README.md"), "# VUH-1913\nOffline proof only.\n");
      await writeFile(join(folder, "capture.txt"), bytes);
      const cli = async (args: string[]) => {
        let result: { stdout: string; stderr: string };
        try {
          result = await exec(
            process.execPath,
            [fileURLToPath(new URL("../../tui/bin/clankie.ts", import.meta.url)), "evidence", ...args],
            {
              cwd: repo,
              env: {
                ...process.env,
                CLANKIE_CONTROL_PLANE_URL: host,
                CLANKIE_CREDENTIALS_FILE: join(root, "operator-broker.json"),
              },
            },
          );
        } catch {
          throw new Error("offline_public_cli_failed");
        }
        captured.push(result.stdout, result.stderr);
        return JSON.parse(result.stdout) as { receipts?: { state: string; receiptId: string }[] };
      };
      const push = await cli(["push", "docs/testing/proof", "--issue", "VUH-1913"]);
      // Compare booleans only: assertion failures cannot print session or URL material.
      expect(push.receipts?.every((item) => item.state === "applied")).toBe(true);
      const manifest = await readFile(join(folder, "evidence.json"), "utf8");
      captured.push(manifest, JSON.stringify(store.status()));
      const mirror = join(repo, ".local/evidence/docs/testing/proof/capture.txt");
      await rm(mirror);
      await cli(["fetch", "docs/testing/proof"]);
      expect((await readFile(mirror)).equals(bytes)).toBe(true);
      const first = await store.fetch({ sha256: sha });
      const url = new URL(first.url);
      expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(900);
      const accessBefore = url.searchParams.get("X-Amz-Credential")?.split("/")[0];
      const sessionBefore = await activeClient.config.credentials();
      expect(Date.parse(first.expiresAt)).toBeLessThanOrEqual(sessionBefore.expiration!.getTime());
      const selfHosted = evidenceS3Client(f.destination, "read", { s3Client: transport });
      try {
        expect(await new S3EvidenceBlobs(f.destination, selfHosted).has(sha)).toBe(true);
      } finally {
        selfHosted.destroy();
      }
      const shortClient = new S3Client({
        region: "us-east-1",
        endpoint: minio.endpoint,
        forcePathStyle: true,
        credentials: {
          ...(await activeClient.config.credentials()),
          expiration: new Date(Date.now() + 90_000),
        },
      });
      try {
        const bounded = await new S3EvidenceBlobs(f.destination, shortClient).signedFetch(sha, 900);
        expect(Number(new URL(bounded!.url).searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(90);
      } finally {
        shortClient.destroy();
      }
      const calls = issuer.calls;
      f.advance(450_001);
      await Promise.all(
        Array.from({ length: 10 }, () => store.deviceFetch({ sha256: sha, offset: 0, length: bytes.length })),
      );
      expect(issuer.calls).toBe(calls + 1);
      const later = await store.fetch({ sha256: sha });
      expect(new URL(later.url).searchParams.get("X-Amz-Credential")?.split("/")[0] === accessBefore).toBe(
        false,
      );
      expect(Buffer.from(await (await fetch(later.url)).arrayBuffer()).equals(bytes)).toBe(true);
      // Local becomes current; historical reads still use the recorded destination and read lease.
      store.close();
      store = EvidenceStore.local(join(root, "state"), options);
      routes = createEvidenceRoutes(store, actor);
      const historical = await store.fetch({ sha256: sha });
      expect(
        new URL(historical.url).pathname.startsWith(
          `/${f.destination.bucket}/${f.destination.prefix}/sha256/`,
        ),
      ).toBe(true);
      expect(Buffer.from(await (await fetch(historical.url)).arrayBuffer()).equals(bytes)).toBe(true);
      await expect(
        store.storage.resolve(f.destination).write(
          sha,
          bytes.length,
          (async function* () {
            yield bytes;
          })(),
        ),
      ).rejects.toMatchObject({ status: 503, code: "evidence_destination_read_only" });
      const beforeUnknown = issuer.calls;
      const response = await fetch(host + EVIDENCE_FETCH_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${operator.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sha256: "0".repeat(64) }),
      });
      expect(response.status).toBe(404);
      expect(issuer.calls).toBe(beforeUnknown);
      expect(
        (
          await fetch(host + EVIDENCE_FETCH_PATH, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sha256: sha }),
          })
        ).status,
      ).toBe(401);
      const foreign = evidenceS3Client({ ...f.destination, prefix: "foreign" }, "read", options);
      try {
        await expect(foreign.config.credentials()).rejects.toThrow("evidence_session_unavailable");
      } finally {
        foreign.destroy();
      }
      // No token-bearing storage entry is visible through the generic broker summary.
      expect(await f.broker.list()).toEqual({});
      captured.push(JSON.stringify(await f.broker.list()));
      const all = captured.join("\n");
      expect(
        [...f.markers, operator.token, minio.credentials.accessKeyId, minio.credentials.secretAccessKey].some(
          (marker) => all.includes(marker),
        ),
      ).toBe(false);
      expect(/X-Amz-(?:Signature|Credential)|[?&]signature=/iu.test(all)).toBe(false);
      const exchange = issuer.exchange;
      let lost = false,
        originalReply = "",
        replayedReply = "";
      const beforeLost = issuer.calls;
      f.providerOptions.exchange = async (request, signal) => {
        const reply = await exchange(request, signal);
        if (!lost) {
          lost = true;
          originalReply = JSON.stringify(reply);
          throw new TypeError("fixture lost response");
        }
        replayedReply = JSON.stringify(reply);
        return reply;
      };
      f.advance(450_001);
      await store.deviceFetch({ sha256: sha, offset: 0, length: bytes.length });
      f.advance(20_000);
      await store.deviceFetch({ sha256: sha, offset: 0, length: bytes.length });
      expect(issuer.calls).toBe(beforeLost + 1);
      expect(Boolean(originalReply) && replayedReply === originalReply).toBe(true);
      f.advance(900_001);
      f.providerOptions.exchange = async () => {
        throw new EvidenceSessionTransient();
      };
      const unavailable = await fetch(host + EVIDENCE_FETCH_PATH, {
        method: "POST",
        headers: { authorization: `Bearer ${operator.token}`, "content-type": "application/json" },
        body: JSON.stringify({ sha256: sha }),
      });
      expect(unavailable.status).toBe(503);
      expect(/X-Amz-|disposable-/u.test(await unavailable.text())).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      store.close();
      activeClient.destroy();
      transport.destroy();
      await issuer.close();
      cleanup = await minio.stop();
      await rm(root, { recursive: true, force: true });
    }
    const stopped = cleanup as { code: number; portClosed: boolean; removed: boolean; logs: string };
    expect(stopped.code).toBe(0);
    expect(stopped.portClosed).toBe(true);
    expect(stopped.removed).toBe(true);
    expect(stopped.logs.includes(minio.credentials.secretAccessKey)).toBe(false);
    if (process.env.EVIDENCE_OFFLINE_PROOF_OUTPUT) {
      expect(
        [minio.credentials.accessKeyId, minio.credentials.secretAccessKey, ...f.markers].some((secret) =>
          stopped.logs.includes(secret),
        ),
      ).toBe(false);
      await writeFile(process.env.EVIDENCE_OFFLINE_PROOF_OUTPUT + ".minio.log", stopped.logs);
      await writeFile(
        process.env.EVIDENCE_OFFLINE_PROOF_OUTPUT,
        JSON.stringify(
          {
            result: "passed",
            path: "public CLI + evidence HTTP + production operator auth + isolated FileCredentialStore + SQLite + private signed issuer + local MinIO",
            hostedProof: false,
            sha256: sha,
            bytes: bytes.length,
            issuerCalls: issuer.calls,
            receiptStates: ["applied"],
            renewalCoalesced: true,
            lostResponseReconciledThroughIssuer: true,
            historicalReadPreserved: true,
            secretCaptureClean: true,
            cleanup: {
              minioExit: stopped.code,
              portClosed: stopped.portClosed,
              removed: stopped.removed,
              issuerStopped: true,
              evidenceServerStopped: true,
            },
          },
          null,
          2,
        ) + "\n",
      );
    }
  },
  30_000,
);
