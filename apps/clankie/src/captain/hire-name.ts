import { createHash, randomUUID } from "node:crypto";
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

const HANDLE_NAMES = [
  "ari",
  "basil",
  "cleo",
  "dex",
  "ember",
  "fern",
  "gus",
  "hazel",
  "iris",
  "juno",
  "kit",
  "lark",
  "moss",
  "nell",
  "otto",
  "pip",
  "quill",
  "rowan",
  "sage",
  "tam",
  "umi",
  "vale",
  "wren",
  "zuri",
] as const;

/**
 * A name for a seat Clankie adopted without naming it (VUH-2667), read like a hire's: its Herdr
 * handle without the tag ("basil-91c2" is Basil), or else one picked for the persona, stable for it.
 * Never the pane's title.
 */
export function adoptedName(personaId: string, handle?: string): string {
  const base = handle
    ?.trim()
    .replace(/-[0-9a-f]{4}$/iu, "")
    .replaceAll(/[-_]+/gu, " ")
    .trim();
  const picked = HANDLE_NAMES[createHash("sha256").update(personaId).digest()[0]! % HANDLE_NAMES.length]!;
  const name = base || picked;
  return hireDisplayName(name[0]!.toLocaleUpperCase() + name.slice(1));
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

/**
 * Herdr agent names are `[a-z][a-z0-9_-]{0,31}` and must be unique among live
 * agents, so the operator's free-text title has to become one. A short suffix
 * makes the immutable subject unique while the roster title carries the
 * operator's original words.
 */
export function herdrAgentName(title: string, suffix: string = randomUUID().slice(0, 4)): string {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .replace(/-+$/u, "");
  const base = (slug.length === 0 ? "agent" : slug).slice(0, 32 - suffix.length - 1);
  return `${base}-${suffix}`;
}
