import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes a seat's resume record. A `--new` seat passes `keepExisting`, so it fills an
 * empty record but never replaces the owner's. The result says whether this seat
 * holds the record, for a seat that goes on updating it.
 */
export function writeResumeRecord(path: string, body: string, keepExisting: boolean): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, body, { mode: 0o600, flag: keepExisting ? "wx" : "w" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
}
