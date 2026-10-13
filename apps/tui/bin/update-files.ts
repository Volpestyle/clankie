/** Private bounded operation files shared with the detached helper; no ambient configuration. */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
export function privateDirectory(path: string, options: { allowReadable?: boolean } = {}): void {
  const uid = process.getuid?.();
  const fail = () => {
    throw Error("Update directory must be owned and private; unsafe symlink or target");
  };
  // Follow each link ourselves so realpath cannot hide a foreign-owned link in
  // an ancestor or in a link chain. OS-owned aliases (/tmp on macOS) are safe
  // only when their containing directory cannot be changed by other users.
  const inspect = (input: string, target: boolean, depth = 0): string => {
    if (depth > 40) return fail();
    const absolute = resolve(input);
    let current = parse(absolute).root;
    for (const component of absolute.slice(current.length).split(sep).filter(Boolean)) {
      const candidate = join(current, component);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        const parent = lstatSync(current);
        const protectedParent =
          (parent.mode & 0o022) === 0 || (parent.uid === 0 && (parent.mode & 0o1000) !== 0);
        const systemAlias = stat.uid === 0 && parent.uid === 0 && (parent.mode & 0o022) === 0;
        if (
          !protectedParent ||
          (uid !== undefined && parent.uid !== uid && parent.uid !== 0) ||
          (uid !== undefined && stat.uid !== uid && !systemAlias)
        )
          return fail();
        current = inspect(resolve(current, readlinkSync(candidate)), !systemAlias, depth + 1);
        const destination = lstatSync(current);
        // POSIX symlink mode bits do not control access; check the directory
        // they designate instead. User links must designate an owned directory without shared write access.
        if (
          !systemAlias &&
          ((destination.mode & 0o022) !== 0 || (uid !== undefined && destination.uid !== uid))
        )
          return fail();
      } else {
        if (!stat.isDirectory()) return fail();
        if (target && uid !== undefined && stat.uid !== uid && stat.uid !== 0) return fail();
        if (target && (stat.mode & 0o022) !== 0 && !(stat.uid === 0 && (stat.mode & 0o1000) !== 0))
          return fail();
        current = candidate;
      }
    }
    return current;
  };
  const canonical = inspect(path, false);
  const stat = lstatSync(canonical);
  if (
    !stat.isDirectory() ||
    (stat.mode & (options.allowReadable ? 0o022 : 0o077)) !== 0 ||
    (uid !== undefined && stat.uid !== uid)
  )
    fail();
}
export function readPrivateJson(path: string, directoryOptions: { allowReadable?: boolean } = {}): unknown {
  privateDirectory(dirname(path), directoryOptions);
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
