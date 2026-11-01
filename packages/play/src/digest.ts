/** Stable digests for journal provenance: key order must never change a hash. */
import { createHash } from "node:crypto";

export { canonicalJson } from "@clankie/protocol/canonical-json";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
