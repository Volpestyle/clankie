import { readdir, readlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { fleetProcessHelper } from "./local-fleet-process.ts";
import { nativeProcessRequest } from "./native-process-transport.ts";

const WorkingDirectoriesSchema = z
  .object({
    schemaVersion: z.literal(1),
    uid: z.number().int().nonnegative(),
    cwds: z.array(z.string().min(1).max(4096).refine(isAbsolute)).min(1).max(16_384),
  })
  .strict();

/** Bounded account process census. Failure is unknown, never permission to reclaim. */
export async function processWorkingDirectories(): Promise<string[]> {
  if (process.platform === "linux") {
    const entries = await readdir("/proc");
    if (entries.length > 32_768) throw Error("Process census exceeds its bound");
    const paths: string[] = [];
    for (const pid of entries.filter((name) => /^\d+$/u.test(name))) {
      try {
        paths.push(await readlink(`/proc/${pid}/cwd`));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // The kernel withholds a cwd behind its ptrace check (proc(5)): every other account's
        // process, and our own non-dumpable ones such as systemd --user, sd-pam, ssh-agent and
        // gpg-agent. Every dumpable process stays in the census (ADR 0280, VUH-2926).
        if (code === "ENOENT" || code === "EACCES" || code === "EPERM") continue;
        throw error;
      }
    }
    return paths;
  }
  if (process.platform !== "darwin") throw Error("Process cwd census unavailable on this host");
  const reply = await nativeProcessRequest(fleetProcessHelper(), ["--cwds", "--diagnostics"]);
  if (!reply || !reply.stdout)
    throw Error(`Incomplete account process cwd census: ${reply?.stderr.trim() || "helper unavailable"}`);
  const result = WorkingDirectoriesSchema.parse(JSON.parse(reply.stdout));
  if (result.uid !== process.getuid?.()) throw Error("Process cwd census account mismatch");
  return [...new Set(result.cwds)];
}
