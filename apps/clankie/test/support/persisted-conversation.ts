import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { InboundReportStore } from "../../src/captain/conversations/inbound-report-store.ts";

/** Decode committed files into the old inline view for receipt assertions and legacy fixtures. */
export function readPersistedConversation(path: string) {
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
