import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { privateDirectory } from "./update-files.ts";

/** Existing installs have a readable state root. Only the companion subtree carries capabilities. */
export function prepareCompanionDirectory(root: string): string {
  if (!process.getuid) throw Error("local_owner_unavailable");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o022) !== 0 ||
    realpathSync(root) !== resolve(root)
  )
    throw Error("unsafe_state_root");
  // An unprotected ancestor could rename a private child underneath us. Sticky
  // temp directories keep their normal owner-only rename boundary.
  for (let parent = dirname(root); ; parent = dirname(parent)) {
    const metadata = lstatSync(parent);
    if (
      !metadata.isDirectory() ||
      (metadata.uid !== 0 && metadata.uid !== process.getuid()) ||
      ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0)
    )
      throw Error("unsafe_state_ancestor");
    if (parent === dirname(parent)) break;
  }
  const directory = join(root, "companion");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  privateDirectory(directory);
  return directory;
}
