import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { EvidenceStore } from "../src/evidence-store.ts";

const actor = { kind: "worker" as const, id: "worker-1", name: "Sorrel", onBehalfOf: [] };

async function record(store: EvidenceStore, bytes: Buffer, fileName: string, contentType: string) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const receipt = await store.upload(actor, {
    idempotencyKey: `key-${sha256.slice(0, 24)}`,
    sha256,
    size: bytes.length,
    contentType,
    fileName,
    issueKey: "VUH-1936",
    caption: `Proof: ${fileName}`,
  });
  await store.acceptBlob(
    EvidenceStore.actorKey(actor),
    receipt.receiptId,
    (async function* () {
      yield bytes;
    })(),
  );
  return sha256;
}

it("shows a paired device an issue's recorded evidence and small previews, never a link to the service", async () => {
  const store = EvidenceStore.local(await mkdtemp(join(tmpdir(), "evidence-device-")));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);
  const pngSha = await record(store, png, "docs/testing/shot.png", "image/png");
  const logSha = await record(store, Buffer.from("round trip ok\n"), "docs/testing/run.txt", "text/plain");
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    evidenceStore: store,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const dispatch = async (body: unknown) => {
    const response = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const listed = await dispatch({ op: "evidence_records", schemaVersion: 1, issueKey: "VUH-1936" });
  expect(listed).toMatchObject({
    result: {
      outcome: "ready",
      records: expect.arrayContaining([
        expect.objectContaining({
          sha256: pngSha,
          caption: "Proof: docs/testing/shot.png",
          actor: expect.objectContaining({ name: "Sorrel" }),
        }),
        expect.objectContaining({ sha256: logSha, url: `clankie://evidence/sha256/${logSha}` }),
      ]),
    },
  });
  expect(await dispatch({ op: "evidence_preview", schemaVersion: 1, sha256: pngSha })).toMatchObject({
    result: { outcome: "ready", available: true, contentType: "image/png", data: png.toString("base64") },
  });
  expect(await dispatch({ op: "evidence_preview", schemaVersion: 1, sha256: logSha })).toMatchObject({
    result: { outcome: "ready", available: true, text: "round trip ok\n" },
  });
  expect(await dispatch({ op: "evidence_preview", schemaVersion: 1, sha256: "0".repeat(64) })).toMatchObject({
    result: { outcome: "unavailable" },
  });
  store.close();
});
