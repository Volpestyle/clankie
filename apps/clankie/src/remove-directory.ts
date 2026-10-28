import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Bulk deletion yields to interactive and gate work: background QoS on macOS, nice 19 on Linux. */
const lowPriority: readonly string[] =
  process.platform === "darwin"
    ? ["/usr/sbin/taskpolicy", "-b"]
    : process.platform === "linux"
      ? ["nice", "-n", "19"]
      : [];

/**
 * Await scratch cleanup without putting its recursive filesystem work in the service's pool.
 * Background priority deletes about 3x slower under load, so a removal some work is
 * waiting on passes `background: false`.
 */
export async function removeDirectory(
  path: string,
  { force = false, background = true }: { force?: boolean; background?: boolean } = {},
) {
  // Keep Node's removal semantics on every host. The path is an argument, never shell code;
  // the child owns the traversal and deletion callbacks, including large dependency trees.
  const [command = process.execPath, ...prefix] = [...(background ? lowPriority : []), process.execPath];
  await execute(
    command,
    [
      ...prefix,
      "--input-type=commonjs",
      "--eval",
      "require('node:fs').rmSync(process.argv[1], { recursive: true, force: process.argv[2] === 'true' })",
      "--",
      path,
      String(force),
    ],
    { windowsHide: true },
  );
}
