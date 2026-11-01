import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE, parseExtensionManifest, type ExtensionManifest } from "./outside.ts";

const MAX_MANIFEST_BYTES = 64 * 1024;

function readJson(path: string): unknown {
  if (statSync(path).size > MAX_MANIFEST_BYTES) throw new Error("manifest_too_large");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("manifest_unreadable");
  }
}

/**
 * Reads an extension folder's manifest without running any of its code:
 * `clankie-extension.json`, else the `clankie` field of `package.json` (whose
 * `version` fills a missing one). Undefined when the folder has neither.
 * Throws a fixed `manifest_*` code for one that is present but invalid.
 */
export function readExtensionManifest(folder: string): ExtensionManifest | undefined {
  const own = join(folder, MANIFEST_FILE);
  if (existsSync(own)) return parseExtensionManifest(readJson(own));
  const packagePath = join(folder, "package.json");
  if (!existsSync(packagePath)) return undefined;
  const pkg = readJson(packagePath);
  if (pkg === null || typeof pkg !== "object") return undefined;
  const embedded = (pkg as { clankie?: unknown }).clankie;
  if (embedded === undefined) return undefined;
  if (embedded === null || typeof embedded !== "object" || Array.isArray(embedded))
    throw new Error("manifest_invalid");
  const version = (pkg as { version?: unknown }).version;
  return parseExtensionManifest({
    ...(typeof version === "string" ? { version } : {}),
    ...(embedded as Record<string, unknown>),
  });
}
