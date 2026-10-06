/** Private bounded operation files shared with the detached helper; no ambient configuration. */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
export function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    realpathSync(path) !== resolve(path) ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw Error("Update directory must be canonical, owned and private");
}
export function readPrivateJson(path: string): unknown {
  privateDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      // Atomic replacement can unlink this already-open, owned inode. Hard links remain forbidden.
      stat.nlink > 1 ||
      stat.size > 32_768 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error("Invalid private update file");
    const buffer = Buffer.alloc(32_769);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 32_768) throw Error("Update record exceeds size bound");
    return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
  } finally {
    closeSync(fd);
  }
}
export function writePrivateJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.${path.split("/").at(-1)}.next`);
  const text = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(text) > 32_768) throw Error("Update record exceeds size bound");
  writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid update record");
  return value as Record<string, unknown>;
}
export function boundedString(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0"))
    throw Error("Invalid update string");
  return value;
}
export function commitString(value: unknown): string {
  const text = boundedString(value, 64);
  if (!/^[a-f0-9]{40,64}$/u.test(text)) throw Error("Invalid update commit");
  return text;
}
export function operationId(value: unknown): string {
  const text = boundedString(value, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(text))
    throw Error("Invalid update operation id");
  return text;
}
