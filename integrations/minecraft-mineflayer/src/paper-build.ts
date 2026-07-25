import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PINNED_PAPER_VERSION = "1.21.11" as const;
export const PINNED_PAPER_BUILD = 132 as const;
export const PINNED_PAPER_JAR_NAME = "paper-1.21.11-132.jar" as const;
export const PINNED_PAPER_JAR_SIZE = 54_846_016 as const;
export const PINNED_PAPER_SHA256 =
  "5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba" as const;
export const PINNED_PAPER_DOWNLOAD_URL =
  "https://fill-data.papermc.io/v1/objects/5ffef465eeeb5f2a3c23a24419d97c51afd7dbb4923ff42df9a3f58bba1ccfba/paper-1.21.11-132.jar" as const;

export function paperCacheDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment["CLANKIE_PAPER_CACHE_DIR"]?.trim();
  return configured
    ? resolve(configured)
    : join(homedir(), ".local", "state", "clankie", "minecraft", "paper");
}

export function pinnedPaperJarPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(paperCacheDirectory(environment), PINNED_PAPER_JAR_NAME);
}
