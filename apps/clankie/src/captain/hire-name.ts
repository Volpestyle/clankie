import { createHash } from "node:crypto";
import { OperatorAgentNameSchema } from "@clankie/protocol";

// Compatibility for older callers that used task/routing labels. These are
// display names only: no routing, session, project or authorization identity.
const FALLBACK_NAMES = ["Ari", "Mei", "Noor", "Ravi", "Sora", "Zuri"] as const;

export function hireDisplayName(title: string): string {
  const name = title.trim();
  const valid = OperatorAgentNameSchema.safeParse(name);
  const routing = /^(?:fleet:|term[_-]|session[_-]|vuh[-_]?\d|pc\/[a-z0-9_-]+$)/iu.test(name);
  if (valid.success && !routing && !/\p{Cc}/u.test(title)) return valid.data;
  return FALLBACK_NAMES[createHash("sha256").update(name).digest()[0]! % FALLBACK_NAMES.length]!;
}
