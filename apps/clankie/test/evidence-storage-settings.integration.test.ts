import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  EVIDENCE_STORAGE_SETTINGS_PATH,
  EvidenceStorageSnapshotSchema,
} from "@clankie/protocol/owner-settings";
import { EvidenceReceiptSchema } from "@clankie/protocol/evidence";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createEvidenceStorageSettingsRoutes } from "../src/evidence-storage-settings-routes.ts";
import { EvidenceStore, createEvidenceRoutes } from "../src/evidence-store.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { runEvidenceCommand } from "../../tui/src/command/evidence.ts";

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
it("configures through owner HTTP/CLI without applying or reassigning active/history/pending evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-storage-settings-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, host: { ...current.host, autoUpdate: false } }));
  const broker = new FileCredentialStore(join(root, "broker.json"));
  const credential = await ensureOperatorCredential({ env: {}, store: broker });
  const authenticate = createCredentialBackedOperatorAuthenticator({
    env: {},
    store: broker,
    identity: { operatorId: "fixture-owner" },
  });
  const authorize = async (request: Request) =>
    (await authenticate(request)) ? (true as const) : ("authentication_required" as const);
  const store = EvidenceStore.local(join(root, "fixed-service-evidence"));
  const app = new Hono();
  app.route("/", createEvidenceStorageSettingsRoutes(authorize, settings, store));
  app.route(
    "/",
    createEvidenceRoutes(store, async (request) => {
      const actor = await authenticate(request);
      return actor ? { kind: "operator" as const, id: actor.operatorId, onBehalfOf: [] } : undefined;
    }),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, body?: unknown, token = credential.token) =>
    fetch(host + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const cli = (args: string[]) =>
    runEvidenceCommand(["storage", ...args], { host, env: {}, operatorCredentialStore: broker });
  const claim = async (bytes: Buffer) => {
    const response = await call("/v1/evidence/uploads", {
      idempotencyKey: randomUUID(),
      sha256: digest(bytes),
      size: bytes.length,
      fileName: "capture.txt",
      contentType: "text/plain",
      issueKey: "LOCAL-VUH-1913",
    });
    expect(response.status).toBe(200);
    return EvidenceReceiptSchema.parse(await response.json());
  };
  const put = async (receipt: Awaited<ReturnType<typeof claim>>, bytes: Buffer) => {
    const response = await fetch(new URL(receipt.uploadUrl!, host), {
      method: "PUT",
      body: Uint8Array.from(bytes),
    });
    expect(response.status).toBe(200);
    return EvidenceReceiptSchema.parse(await response.json());
  };
  let assertionsCompleted = false;
  try {
    const oldBytes = Buffer.from("recorded local bytes before configuration");
    const pendingBytes = Buffer.from("pending immutable bytes before configuration");
    const applied = await put(await claim(oldBytes), oldBytes);
    const pending = await claim(pendingBytes);
    const originalRecord = await store.record(applied.recordId!);
    const originalLocation = store.blobs.location;
    const originalObject = await readFile(
      join(originalLocation, "sha256", digest(oldBytes).slice(0, 2), digest(oldBytes)),
    );
    const initial = EvidenceStorageSnapshotSchema.parse((await cli(["status"])).body);
    expect(initial).toMatchObject({
      configured: { backend: "local" },
      active: { backend: "local" },
      restartRequired: false,
    });
    const saved = EvidenceStorageSnapshotSchema.parse(
      (
        await cli([
          "s3",
          "--bucket",
          "fixture-bucket",
          "--region",
          "us-east-1",
          "--prefix",
          "evidence",
          "--expected-revision",
          initial.revision,
        ])
      ).body,
    );
    expect(saved).toMatchObject({
      configured: { backend: "s3", bucket: "fixture-bucket", prefix: "evidence" },
      active: { backend: "local" },
      restartRequired: true,
    });
    expect(store.blobs.location).toBe(originalLocation);
    expect(store.storage.activeDestination).toEqual({ backend: "local" });
    expect(await store.record(applied.recordId!)).toEqual(originalRecord);
    expect(
      await readFile(join(originalLocation, "sha256", digest(oldBytes).slice(0, 2), digest(oldBytes))),
    ).toEqual(originalObject);
    const settled = await put(pending, pendingBytes);
    expect(settled.state).toBe("applied");
    const read = await call("/v1/evidence/fetch", { sha256: digest(oldBytes) });
    expect(read.status).toBe(200);
    const link = await read.json();
    expect(Buffer.from(await (await fetch(new URL(link.url, host))).arrayBuffer())).toEqual(oldBytes);
    expect(JSON.parse(await readFile(settings.path, "utf8")).host.autoUpdate).toBe(false);
    await expect(cli(["local", "--expected-revision", initial.revision])).rejects.toThrow("Settings changed");
    const unchanged = await readFile(settings.path, "utf8");
    for (const configured of [
      { backend: "local", root: "/other" },
      { backend: "s3", bucket: "fixture-bucket", region: "us-east-1", prefix: "../escape" },
      {
        backend: "s3",
        bucket: "fixture-bucket",
        region: "us-east-1",
        prefix: "valid",
        endpoint: "http://127.0.0.1",
      },
      {
        backend: "s3",
        bucket: "fixture-bucket",
        region: "us-east-1",
        prefix: "valid",
        secretAccessKey: "not-accepted",
      },
    ]) {
      const response = await call(EVIDENCE_STORAGE_SETTINGS_PATH, {
        schemaVersion: 1,
        expectedRevision: saved.revision,
        configured,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(await readFile(settings.path, "utf8")).toBe(unchanged);
    const missingAuth = await call(EVIDENCE_STORAGE_SETTINGS_PATH, undefined, "invalid");
    expect(missingAuth.status).toBe(401);
    expect(missingAuth.headers.get("cache-control")).toBe("no-store");
    const body = { schemaVersion: 1, expectedRevision: saved.revision, configured: { backend: "local" } };
    const concurrent = await Promise.all([
      call(EVIDENCE_STORAGE_SETTINGS_PATH, body),
      call(EVIDENCE_STORAGE_SETTINGS_PATH, body),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(concurrent.every((r) => r.headers.get("cache-control") === "no-store")).toBe(true);
    const last = await call(EVIDENCE_STORAGE_SETTINGS_PATH);
    expect(last.headers.get("cache-control")).toBe("no-store");
    expect(EvidenceStorageSnapshotSchema.parse(await last.json())).toMatchObject({
      configured: { backend: "local" },
      active: { backend: "local" },
      restartRequired: false,
    });
    // Establish a valid fresh revision and successful control before changing only the unknown field.
    const validState = EvidenceStorageSnapshotSchema.parse((await cli(["status"])).body);
    const freshBody = {
      schemaVersion: 1,
      expectedRevision: validState.revision,
      configured: validState.configured,
    };
    const positiveControl = await call(EVIDENCE_STORAGE_SETTINGS_PATH, freshBody);
    expect(positiveControl.status).toBe(200);
    const controlState = EvidenceStorageSnapshotSchema.parse(await positiveControl.json());
    const freshRead = EvidenceStorageSnapshotSchema.parse((await cli(["status"])).body);
    expect(freshRead.revision).toBe(controlState.revision);
    const validRaw = await readFile(settings.path, "utf8");
    const futureRaw = JSON.stringify({ ...JSON.parse(validRaw), futureField: { preserved: 7 } });
    await writeFile(settings.path, futureRaw);
    const unknownWrite = await call(EVIDENCE_STORAGE_SETTINGS_PATH, {
      ...freshBody,
      expectedRevision: freshRead.revision,
    });
    expect(unknownWrite.status).toBe(503);
    expect(await unknownWrite.json()).toEqual({ error: "evidence_settings_invalid" });
    expect(unknownWrite.headers.get("cache-control")).toBe("no-store");
    expect(await readFile(settings.path, "utf8")).toBe(futureRaw);
    const unknownRead = await call(EVIDENCE_STORAGE_SETTINGS_PATH);
    expect(unknownRead.status).toBe(503);
    expect(await unknownRead.json()).toEqual({ error: "evidence_settings_invalid" });
    expect(unknownRead.headers.get("cache-control")).toBe("no-store");
    await expect(cli(["local"])).rejects.toThrow("evidence_settings_invalid");
    expect(await readFile(settings.path, "utf8")).toBe(futureRaw);
    await writeFile(settings.path, validRaw);
    expect(EvidenceStorageSnapshotSchema.parse((await cli(["status"])).body).revision).toBe(
      freshRead.revision,
    );
    await rm(join(root, "broker.json"), { force: true });
    expect((await call(EVIDENCE_STORAGE_SETTINGS_PATH)).status).toBe(401);
    await expect(cli(["local"])).rejects.toThrow();
    expect(store.blobs.location).toBe(originalLocation);
    assertionsCompleted = true;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.metadata.close();
    await rm(root, { recursive: true, force: true });
    let portClosed = false;
    try {
      await fetch(host + EVIDENCE_STORAGE_SETTINGS_PATH);
    } catch {
      portClosed = true;
    }
    expect(portClosed).toBe(true);
    expect(existsSync(root)).toBe(false);
    if (process.env.EVIDENCE_STORAGE_SETTINGS_PROOF_OUTPUT)
      await writeFile(
        process.env.EVIDENCE_STORAGE_SETTINGS_PROOF_OUTPUT,
        JSON.stringify(
          {
            outcome: assertionsCompleted ? "passed" : "failed",
            componentHTTPCLI: true,
            fullStartup: false,
            installedCLIProcess: false,
            hostedAcceptance: false,
            fixedActiveLocal: assertionsCompleted,
            freshRevisionUnknownRefusal: assertionsCompleted,
            httpPortClosed: portClosed,
            fixtureRootRemoved: !existsSync(root),
            privateRoot: root,
            host,
            checkedAt: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
      );
  }
});
