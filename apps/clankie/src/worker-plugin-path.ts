import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A file of this install's worker plugin. A release bundles each module into its
 * entry's output file, so a path relative to the module's own source location
 * misses the plugin there; the nearest ancestor holding it is the install root.
 * An install without the file gets the entry-relative path, which fails on use.
 */
export function shippedWorkerFile(...segments: string[]): string {
  const relative = join("integrations", "claude-plugin", "worker", ...segments);
  for (let directory = import.meta.dirname; dirname(directory) !== directory; directory = dirname(directory))
    if (existsSync(join(directory, relative))) return join(directory, relative);
  return join(import.meta.dirname, "..", "..", "..", relative);
}
