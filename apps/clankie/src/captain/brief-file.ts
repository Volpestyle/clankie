import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, join } from "node:path";

/**
 * A Claude hire's brief can go by file (claude-worker-seat): the service writes
 * `{"clankieBrief": BRIEF}` to its own `claude-briefs` directory and the worker's
 * first native message is a one-line pointer to it. Whatever reads that message
 * back (issue metrics, the hire-retry reconcile, #615) resolves the pointer here,
 * and only to a file the service wrote.
 */
const POINTER = /^Execute the assignment in the clankieBrief JSON field of @([^\n]+)$/u;
const NAME = /^clankie-brief-[a-f0-9-]+\.json$/u;

/** The native message that hands a worker the brief at `path`. */
export function briefPointer(path: string): string {
  return `Execute the assignment in the clankieBrief JSON field of @${path}`;
}

export type PointedBrief =
  | { readonly kind: "brief"; readonly brief: string }
  /** The pointer names a file outside the service's retained brief directory. */
  | { readonly kind: "outside"; readonly name: string }
  | { readonly kind: "unavailable"; readonly name: string };

/**
 * The brief a pointer message names, read from `<stateDir>/claude-briefs`, or
 * undefined when the text isn't a pointer. Never follows arbitrary paths, a
 * symlink in the final component, or a file over 1 MiB.
 */
export async function pointedBrief(text: string, stateDir: string): Promise<PointedBrief | undefined> {
  const ref = POINTER.exec(text)?.[1];
  if (ref === undefined) return undefined;
  const name = basename(ref);
  const directory = await realpath(join(stateDir, "claude-briefs")).catch(() =>
    join(stateDir, "claude-briefs"),
  );
  if (ref !== join(directory, name) && ref !== join(stateDir, "claude-briefs", name))
    return { kind: "outside", name };
  if (!NAME.test(name)) return { kind: "outside", name };
  try {
    const parsed: unknown = JSON.parse(await readBrief(join(directory, name)));
    const brief =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { clankieBrief?: unknown }).clankieBrief
        : undefined;
    return typeof brief === "string" ? { kind: "brief", brief } : { kind: "unavailable", name };
  } catch {
    return { kind: "unavailable", name };
  }
}

/** The same no-follow descriptor supplies both the file check and its bytes.
 * A canonical-looking final-component symlink must never select an assignment. */
async function readBrief(path: string): Promise<string> {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("No-follow brief reads unavailable");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Brief is not a bounded regular file");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > 1024 * 1024) throw new Error("Brief exceeds 1 MiB");
    return buffer.subarray(0, used).toString("utf8");
  } finally {
    await handle.close();
  }
}
