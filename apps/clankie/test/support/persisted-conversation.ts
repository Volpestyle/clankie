import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { InboundReportStore } from "../../src/captain/conversations/inbound-report-store.ts";

/** Decode committed files into the old inline view for receipt assertions and legacy fixtures. */
export function readPersistedConversation(path: string) {
  // A live service may commit a newer manifest and unlink the shard this read named between
  // reading meta.json and its shard (#586); read again from the newer manifest.
  for (let attempt = 1; ; attempt++) {
    try {
      return decode(path);
    } catch (error) {
      if (attempt >= 20 || (error as { cause?: { code?: string } }).cause?.code !== "ENOENT") throw error;
    }
  }
}

function decode(path: string) {
  const meta = JSON.parse(readFileSync(path, "utf8"));
  if (meta.inboundReportStore !== undefined) {
    meta.inboundAcceptances = {
      ...new InboundReportStore(dirname(path)).load(meta.inboundReportStore),
      ...meta.inboundAcceptances,
    };
    delete meta.inboundReportStore;
  }
  return meta;
}
