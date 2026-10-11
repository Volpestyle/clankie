import { execFile } from "node:child_process";
import { readdir, readlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
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
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return paths;
  }
  if (process.platform !== "darwin") throw Error("Process cwd census unavailable on this host");
  const options = { encoding: "utf8" as const, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 };
  const pids = async () => {
    const { stdout } = await exec("ps", ["-axo", "pid=,uid=,stat="], options);
    // Zombies have no cwd. Match effective uid: real-uid login helpers run as root.
    return stdout
      .trim()
      .split("\n")
      .flatMap((row) => {
        const [pid, uid, state] = row.trim().split(/\s+/u);
        if (!pid || !uid || !state) throw Error("Incomplete process inventory");
        return Number(uid) === userInfo().uid && !state.startsWith("Z") && Number(pid) > 1
          ? [Number(pid)]
          : [];
      });
  };
  const before = await pids();
  // Includes every visible system cwd too, not just harnesses or panes.
  const { stdout, stderr } = await exec("lsof", ["-nP", "-d", "cwd", "-Fpn"], options);
  if (stderr.trim()) throw Error("Incomplete process cwd census");
  const paths = new Map<number, string>();
  let pid: number | undefined;
  for (const field of stdout.split("\n")) {
    if (/^p\d+$/u.test(field)) pid = Number(field.slice(1));
    else if (field.startsWith("n") && pid !== undefined) {
      const path = field.slice(1);
      if (!isAbsolute(path)) throw Error("Unknown process cwd");
      paths.set(pid, path);
    }
  }
  const after = new Set(await pids());
  if (before.some((pid) => after.has(pid) && !paths.has(pid)))
    throw Error("Incomplete account process cwd census");
  return [...new Set(paths.values())];
}
