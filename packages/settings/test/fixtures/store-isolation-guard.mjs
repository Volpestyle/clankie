// Preload in the regression's Vitest process and inherited Node children. Trap
// even an attempted read/write: comparing bytes alone would miss a live read.
import fs from "node:fs";
import promises from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const roots = JSON.parse(process.env.TEST_FORBIDDEN_CONFIG_ROOTS);
function assertPath(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== "string") return;
  for (const root of roots) {
    const path = relative(root, resolve(value));
    if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
      throw new Error(`live_config_access_forbidden: ${value}`);
    }
  }
}

for (const api of [fs, promises]) {
  for (const name of [
    "access",
    "appendFile",
    "chmod",
    "copyFile",
    "cp",
    "mkdir",
    "open",
    "readFile",
    "readdir",
    "realpath",
    "rename",
    "rm",
    "rmdir",
    "stat",
    "lstat",
    "truncate",
    "unlink",
    "writeFile",
    "accessSync",
    "appendFileSync",
    "chmodSync",
    "copyFileSync",
    "cpSync",
    "existsSync",
    "mkdirSync",
    "openSync",
    "readFileSync",
    "readdirSync",
    "realpathSync",
    "renameSync",
    "rmSync",
    "rmdirSync",
    "statSync",
    "lstatSync",
    "truncateSync",
    "unlinkSync",
    "writeFileSync",
    "createReadStream",
    "createWriteStream",
  ]) {
    const original = api[name];
    if (typeof original !== "function") continue;
    const guarded = function (...args) {
      assertPath(args[0]);
      if (["copyFile", "copyFileSync", "cp", "cpSync", "rename", "renameSync"].includes(name))
        assertPath(args[1]);
      return Reflect.apply(original, this, args);
    };
    if (original.native)
      guarded.native = function (...args) {
        assertPath(args[0]);
        return Reflect.apply(original.native, this, args);
      };
    api[name] = guarded;
  }
}

for (const name of ["execFile", "execFileSync", "spawn", "spawnSync", "exec", "execSync"]) {
  const original = childProcess[name];
  const guarded = function (...args) {
    if (/(?:^|[\s/])security(?:\s|$)/u.test(String(args[0])))
      throw new Error("live_keychain_access_forbidden");
    return Reflect.apply(original, this, args);
  };
  // execFile has a custom promisified implementation; wrap that route too.
  const custom = Symbol.for("nodejs.util.promisify.custom");
  if (original[custom])
    guarded[custom] = function (...args) {
      if (/(?:^|[\s/])security(?:\s|$)/u.test(String(args[0])))
        throw new Error("live_keychain_access_forbidden");
      return Reflect.apply(original[custom], this, args);
    };
  childProcess[name] = guarded;
}
syncBuiltinESMExports();
