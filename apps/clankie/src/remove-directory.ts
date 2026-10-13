import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Await scratch cleanup without putting its recursive filesystem work in the service's pool. */
export async function removeDirectory(path: string, { force = false }: { force?: boolean } = {}) {
  // Keep Node's removal semantics on every host. The path is an argument, never shell code;
  // the child owns the traversal and deletion callbacks, including large dependency trees.
  await execute(
    process.execPath,
    [
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
