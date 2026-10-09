import { createHash } from "node:crypto";
import { join } from "node:path";
import type { EvidenceReference } from "@clankie/work-items";
import { EvidenceStore } from "../../src/evidence-store.ts";

/** Real evidence store records for tracker completion-contract integration tests. */
export function trackerEvidence(root: string) {
  const store = EvidenceStore.local(join(root, "evidence"));
  return {
    store,
    validateEvidence: async (_issueKey: string, references: readonly EvidenceReference[]) => {
      for (const ref of references) {
        const record = await store.record(ref.recordId);
        if (!record || record.sha256 !== ref.sha256) throw new Error("Unknown or mismatched evidence record");
      }
    },
    record: async (issueKey: string) => {
      const actor = { kind: "worker" as const, id: "integration-builder", onBehalfOf: [] };
      const bytes = Buffer.from(`Real tracker integration evidence for ${issueKey}\n`);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const receipt = await store.upload(actor, {
        idempotencyKey: `tracker-evidence-${issueKey}`,
        sha256,
        size: bytes.length,
        fileName: "round-trip.log",
        contentType: "text/plain",
        issueKey,
      });
      await store.acceptBlob(
        EvidenceStore.actorKey(actor),
        receipt.receiptId,
        (async function* () {
          yield bytes;
        })(),
      );
      const [record] = await store.list({ issueKey });
      if (!record) throw new Error("Upload did not settle");
      return { recordId: record.id, sha256, url: record.url, type: "log" as const };
    },
  };
}
