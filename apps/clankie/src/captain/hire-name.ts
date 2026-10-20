import { createHash } from "node:crypto";
import { OperatorAgentNameSchema } from "@clankie/protocol";

// Compatibility for older callers that used task/routing labels. These are
// display names only: no routing, session, project or authorization identity.
const FALLBACK_NAMES = ["Ari", "Mei", "Noor", "Ravi", "Sora", "Zuri"] as const;

export function hireDisplayName(title: string): string {
  const name = title.trim();
  const valid = OperatorAgentNameSchema.safeParse(name);
  const routing =
    /^(?:fleet:|term[_-]|session[_-]|vuh[-_]?\d|pc\/|\/|[a-z]:\\)|\b[a-z]{2,10}[-_]\d+\b|\b(?:claude(?: code)?|codex)\b|\|/iu.test(
      name,
    );
  if (valid.success && !routing && !/\p{Cc}/u.test(title)) return valid.data;
  return FALLBACK_NAMES[createHash("sha256").update(name).digest()[0]! % FALLBACK_NAMES.length]!;
}

/** A manual Herdr label, independent of the harness's changing OSC title. */
export function hirePaneLabel(name: string, taskTitle?: string, role?: string): string {
  const shortTask = (value: string) =>
    value
      .replaceAll(/\b[a-z]{2,10}[-_]\d+\b/giu, "")
      .replaceAll(/\b(?:claude(?: code)?|codex)\b/giu, "")
      .replaceAll(/(?:[a-z]:)?[\\/]\S*/giu, "")
      .replaceAll(/[\p{Cc}|·]+/gu, " ")
      .replaceAll(/\s+/gu, " ")
      .replace(/^[\s:–—-]+|[\s:–—-]+$/gu, "")
      .trim();
  const task = shortTask(taskTitle ?? "") || shortTask(role ?? "") || "Work";
  return `${hireDisplayName(name)} · ${Array.from(task).slice(0, 60).join("")}`;
}
