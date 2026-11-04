import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The first `name` on PATH that resolves to something executable: its PATH entry
 * (`path`, as a launcher would run it) and the file it resolves to (`resolved`).
 * Relative PATH entries are skipped, since they would resolve against the service's
 * own working directory. Nothing is run; version and launcher checks belong to the caller.
 */
export async function findExecutable(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ readonly path: string; readonly resolved: string } | undefined> {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name);
    try {
      const resolved = await realpath(path);
      await access(resolved, constants.X_OK);
      return { path, resolved };
    } catch {
      // Not an executable in this PATH entry.
    }
  }
  return undefined;
}
