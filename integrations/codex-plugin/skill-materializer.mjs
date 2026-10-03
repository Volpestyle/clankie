import { cpSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Native Codex installation skips symlinks; materialize one authored skill. */
export function materializeSkill(sourcePath, targetPath) {
  const source = lstatSync(sourcePath).isSymbolicLink()
    ? resolve(dirname(sourcePath), readlinkSync(sourcePath))
    : sourcePath;
  rmSync(targetPath, { recursive: true, force: true });
  cpSync(source, targetPath, { recursive: true, dereference: true });
}
