import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Claim before delivery: concurrent refreshes and restarts cannot repeat it. */
export async function notifyResourceHolderOnce(
  directory: string,
  leaseId: string,
  notify: () => Promise<boolean>,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${createHash("sha256").update(leaseId).digest("hex")}.notice`);
  try {
    const claim = await open(path, "wx", 0o600);
    await claim.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  // A definite rejection may retry. An exception or crash is uncertain: keep
  // the claim, since delivery may already have happened. At most once means a
  // crash after claiming but before sending can miss a notice, never repeat it.
  if (!(await notify())) await unlink(path);
}
