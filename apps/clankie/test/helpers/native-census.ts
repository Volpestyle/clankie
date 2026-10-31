import { readdirSync, readFileSync, readlinkSync } from "node:fs";

/**
 * The Linux census refuses the whole observation while any thread run by this
 * account (real or effective UID) has an FD table this account cannot read,
 * because that table could hold the seat's socket (integrations/fleet-proof/README.md).
 * GitHub's hosted Linux runners always have two: systemd's non-dumpable
 * (sd-pam) and the runner's own root sudo. There a seat binding cannot be proven.
 */
export function unreadableSameAccountThreads(): string[] {
  if (process.platform !== "linux") return [];
  const uid = process.getuid!();
  const found: string[] = [];
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/u.test(name))) {
    let threads: string[];
    try {
      threads = readdirSync(`/proc/${pid}/task`);
    } catch {
      continue; // Exited between listings.
    }
    for (const tid of threads) {
      try {
        const status = readFileSync(`/proc/${pid}/task/${tid}/status`, "utf8");
        const ids = /^Uid:\s+(\d+)\s+(\d+)/mu.exec(status);
        if (!ids || (Number(ids[1]) !== uid && Number(ids[2]) !== uid)) continue;
        try {
          // The helper reads every descriptor's target, not only the listing.
          const table = `/proc/${pid}/task/${tid}/fd`;
          for (const fd of readdirSync(table)) {
            try {
              readlinkSync(`${table}/${fd}`);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EACCES")
            found.push(`${pid} ${/^Name:\s+(.*)$/mu.exec(status)?.[1] ?? "unknown"}`);
        }
      } catch {
        continue; // Exited between listings.
      }
    }
  }
  return found;
}
