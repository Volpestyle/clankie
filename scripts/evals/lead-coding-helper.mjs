/** Immutable image helper. The host passes JSON data only through the native sandbox. */
import { access, mkdir, open, readlink } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
export const MAX_HELPER_BYTES = 1024 * 1024;
const fail = () => {
  throw Error("Invalid bounded coding operation");
};
const text = (value) =>
  typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= MAX_HELPER_BYTES;

export async function codingOperation(request, cwd = process.cwd()) {
  if (!request || typeof request !== "object" || Array.isArray(request) || !text(request.op)) fail();
  const allowed =
    request.op === "bash"
      ? ["op", "command"]
      : request.op === "write"
        ? ["op", "path", "content"]
        : ["op", "path"];
  if (Object.keys(request).some((key) => !allowed.includes(key))) fail();
  if (request.op === "bash") {
    if (!text(request.command)) fail();
    return new Promise((done, reject) => {
      // No login/profile shell, ambient env, native credentials or host execution.
      const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", request.command], {
        cwd,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks = [];
      let size = 0;
      let overflow = false;
      const collect = (chunk) => {
        size += chunk.length;
        if (size > MAX_HELPER_BYTES) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (overflow || signal || !Number.isSafeInteger(code))
          reject(Error("Coding command did not settle within bounds"));
        else done({ output: Buffer.concat(chunks).toString("utf8"), exitCode: code });
      });
    });
  }
  if (!text(request.path) || !request.path) fail();
  const path = resolve(cwd, request.path);
  const rel = relative(cwd, path);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) fail();
  // Native permission profile remains the authority for symlinks and concurrent path changes.
  if (request.op === "mkdir") {
    await mkdir(path, { recursive: true });
    return { ok: true };
  }
  if (request.op === "access") {
    await access(path, constants.R_OK);
    return { ok: true };
  }
  if (request.op !== "read" && request.op !== "write") fail();
  if (request.op === "write" && !text(request.content)) fail();
  const file = await open(
    path,
    (request.op === "read" ? constants.O_RDONLY : constants.O_WRONLY | constants.O_CREAT) |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_HELPER_BYTES) fail();
    if (request.op === "write") {
      await file.truncate(0);
      await file.writeFile(request.content, "utf8");
      return { ok: true };
    }
    const bytes = Buffer.alloc(MAX_HELPER_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_HELPER_BYTES) fail();
    // Text-only lead tools cannot trigger host image parsing or attachment imports.
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
    if (content.includes("\0")) fail();
    return { content };
  } finally {
    await file.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_HELPER_BYTES) fail();
      chunks.push(chunk);
    }
    const result = await codingOperation(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    process.stdout.write(JSON.stringify({ ...result, namespace: await readlink("/proc/self/ns/pid") }));
  } catch {
    process.stderr.write("Contained coding helper refused operation\n");
    process.exitCode = 1;
  }
}
