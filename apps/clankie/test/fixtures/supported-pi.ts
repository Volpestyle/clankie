import { readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { supportedPiOnPath } from "../../src/captain/pi-native-capability.ts";

/**
 * Why the native Pi acceptance slices cannot run against this PATH, or undefined
 * when native control's own check (layout, floor and capability probe) accepts
 * its Pi (VUH-2414, VUH-2417). The reason names the Pi it found and why it was
 * refused, so a skip says which release is installed and what failed.
 */
export async function supportedPiUnavailable(path = process.env.PATH): Promise<string | undefined> {
  if (!["darwin", "linux"].includes(process.platform))
    return `native Pi control needs macOS or Linux, not ${process.platform}`;
  try {
    await supportedPiOnPath({ PATH: path });
    return undefined;
  } catch (error) {
    const refusal = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    return `the Pi on PATH fails native Pi control's own check: ${found(path) ?? "no readable Pi"}: ${refusal}`;
  }
}

/** The first `pi` on PATH as name@version, read without running it. */
function found(path: string | undefined): string | undefined {
  for (const directory of (path ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    let cli: string;
    try {
      cli = realpathSync(join(directory, "pi"));
    } catch {
      continue;
    }
    try {
      const manifest = JSON.parse(
        readFileSync(join(dirname(dirname(dirname(cli))), "package.json"), "utf8"),
      ) as { name?: unknown; version?: unknown };
      return `${cli} is ${String(manifest.name)}@${String(manifest.version)}`;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
