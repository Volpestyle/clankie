import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { machineAccessAllows, type MachineAccessLevel } from "@clankie/protocol";
import { defaultSettingsPath, SettingsStore } from "./store.ts";

const path = z.string().refine(isAbsolute, "Expected an absolute path");
const EnvelopeSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    accessLevel: z.enum(["portal", "workers", "shell"]),
    runtimeRoot: path,
    runtimeFiles: z.array(path).min(1).max(256),
    home: path,
    workspaces: z.array(path).min(1).max(32),
  })
  .strict();
type LocalSandboxEnvelope = z.infer<typeof EnvelopeSchema>;
const LOCAL_SANDBOX_ENV = "CLANKIE_LOCAL_SANDBOX";
let verified: Readonly<LocalSandboxEnvelope> | undefined;

export function localSandboxControl(env: NodeJS.ProcessEnv = process.env): string {
  return env[LOCAL_SANDBOX_ENV] ?? resolve(dirname(defaultSettingsPath(env)), "local-sandbox");
}
const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);
const quote = (value: string) => JSON.stringify(value);
const exec = promisify(execFile);

/** Exact native loader dependencies, including a dynamically linked local Node. */
async function runtimeFiles(binary: string): Promise<string[]> {
  const pending = [await realpath(binary)],
    files = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file) || file.startsWith("/usr/lib/") || file.startsWith("/System/")) continue;
    if (files.size >= 256) throw new Error("Too many native runtime dependencies");
    files.add(file);
    const { stdout } = await exec("/usr/bin/otool", ["-L", file], { timeout: 5_000, maxBuffer: 1024 * 1024 });
    for (const line of stdout.split("\n").slice(1)) {
      const dependency = line.trim().split(" (compatibility")[0];
      // System dylibs may exist only in dyld's shared cache, not as files.
      if (
        !dependency ||
        dependency === file ||
        dependency.startsWith("/usr/lib/") ||
        dependency.startsWith("/System/")
      )
        continue;
      if (dependency.startsWith("@rpath/")) {
        const name = dependency.slice("@rpath/".length);
        const candidate = await realpath(join(dirname(file), name)).catch(() =>
          realpath(join(dirname(file), "../lib", name)),
        );
        pending.push(candidate);
      } else if (dependency.startsWith("@loader_path/"))
        pending.push(await realpath(join(dirname(file), dependency.slice("@loader_path/".length))));
      else if (isAbsolute(dependency)) pending.push(await realpath(dependency));
      else throw new Error("Unsupported native dependency; use a self-contained installed runtime");
    }
  }
  return [...files].sort();
}

async function requireUnlinkedRuntime(root: string, nativeFiles: readonly string[]): Promise<void> {
  const pending = [root];
  while (pending.length) {
    const file = pending.pop()!,
      info = await lstat(file);
    if (info.isDirectory()) pending.push(...(await readdir(file)).map((name) => join(file, name)));
    else if (info.isFile() && info.nlink !== 1)
      throw new Error(
        "Runtime has hard-linked files; an installed copy with no writable aliases is required",
      );
  }
  for (const file of nativeFiles)
    if ((await stat(file)).nlink !== 1)
      throw new Error("Native runtime has hard-linked files; no writable aliases are permitted");
}

/** Default deny; no inherited owner IPC, Keychain service, or outside fleet socket. */
function localSandboxProfile(control: string, envelope: LocalSandboxEnvelope): string {
  const writable = [envelope.home, ...envelope.workspaces];
  return [
    "(version 1)",
    "(deny default)",
    // Apple's narrow loader rules, not system.sb's broad XPC permissions.
    '(import "/System/Library/Sandbox/Profiles/dyld-support.sb")',
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow dynamic-code-generation)",
    "(allow process-info*)",
    "(allow signal (target self) (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    // OS binaries/libraries and certificate data are public runtime support.
    `(allow file-read* file-map-executable (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple") (subpath "/private/etc") (subpath ${quote(envelope.runtimeRoot)}) ${envelope.runtimeFiles.map((file) => `(literal ${quote(file)})`).join(" ")})`,
    `(allow file-read* (literal ${quote(join(control, "envelope.json"))}))`,
    `(allow file-read* file-write* file-map-executable ${writable.map((dir) => `(subpath ${quote(dir)})`).join(" ")})`,
    '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
    // Same native PTY extension rule as Apple's application.sb: no blanket
    // read/write permission to another seat's tty devices.
    "(allow pseudo-tty)",
    '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
    '(allow file-read* file-write* file-ioctl (require-all (regex "^/dev/ttys[0-9]*") (extension "com.apple.sandbox.pty")))',
    // Internet is permitted; Unix IPC is restricted to the private home.
    '(allow network-outbound (remote tcp "*:*"))',
    // The public system resolver is distinct from owner/harness control IPC.
    '(allow mach-lookup (global-name "com.apple.mDNSResponder"))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
    '(allow network-bind network-inbound (local tcp "localhost:*"))',
    `(allow network-bind network-inbound (local unix-socket (subpath ${quote(envelope.home)})))`,
    `(allow network-outbound (remote unix-socket (subpath ${quote(envelope.home)})))`,
    "",
  ].join("\n");
}

export async function readLocalSandbox(control: string): Promise<LocalSandboxEnvelope | undefined> {
  try {
    return EnvelopeSchema.parse(JSON.parse(await readFile(join(control, "envelope.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Owner-only preparation. Does not start, stop or modify any existing process. */
export async function prepareLocalSandbox(input: {
  control: string;
  runtimeRoot: string;
  home: string;
  workspaces: readonly string[];
  accessLevel: MachineAccessLevel;
  settingsPath: string;
}): Promise<LocalSandboxEnvelope> {
  if (process.platform !== "darwin") throw new Error("Local OS sandbox requires macOS Seatbelt");
  if (input.accessLevel === "screen") throw new Error("Screen access requires an unrestricted owner launch");
  if (resolve(input.home) === sep) throw new Error("A private runtime home cannot be the filesystem root");
  const runtimeRoot = await realpath(input.runtimeRoot);
  // Only installed, self-contained releases: no writable source/store dependency escape.
  await stat(join(runtimeRoot, "release.json"));
  await stat(join(runtimeRoot, "libexec", "node"));
  const nativeFiles = await runtimeFiles(join(runtimeRoot, "libexec", "node"));
  await requireUnlinkedRuntime(runtimeRoot, nativeFiles);
  const workspaces = [...new Set(await Promise.all(input.workspaces.map((dir) => realpath(dir))))];
  if (!workspaces.length || workspaces.some((dir) => dir === "/" || dir === homedir()))
    throw new Error("Explicit workspace directories are required; the whole home is not a workspace");
  for (const dir of workspaces)
    if (!(await stat(dir)).isDirectory()) throw new Error("Workspace is not a directory");
  await mkdir(input.control, { recursive: true, mode: 0o700 });
  await mkdir(input.home, { recursive: true, mode: 0o700 });
  const control = await realpath(input.control),
    home = await realpath(input.home);
  if (Buffer.byteLength(join(home, "h", "12345678", "herdr", "herdr-client.sock")) > 103)
    throw new Error(
      "Sandbox private home is too long for native fleet sockets; choose a shorter --home path",
    );
  if (
    overlaps(control, home) ||
    overlaps(runtimeRoot, control) ||
    overlaps(runtimeRoot, home) ||
    nativeFiles.some((file) => within(file, home) || within(file, control)) ||
    workspaces.some(
      (dir) =>
        overlaps(dir, control) ||
        overlaps(dir, runtimeRoot) ||
        overlaps(dir, home) ||
        nativeFiles.some((file) => within(file, dir)),
    )
  )
    throw new Error("Sandbox control, runtime, private home and workspaces must be disjoint");
  if (await readLocalSandbox(control))
    throw new Error("A sandbox is already prepared; owner removal is required first");
  const envelope = EnvelopeSchema.parse({
    version: 1,
    id: randomUUID(),
    accessLevel: input.accessLevel,
    runtimeRoot,
    runtimeFiles: nativeFiles,
    home,
    workspaces,
  });
  const settings = await new SettingsStore(input.settingsPath).load();
  const config = join(home, "config", "clankie");
  await mkdir(config, { recursive: true, mode: 0o700 });
  await writeFile(
    join(config, "settings.json"),
    JSON.stringify(
      {
        ...settings,
        machineAccess: { ...settings.machineAccess, local: envelope.accessLevel },
        herdr: {
          ...settings.herdr,
          runtime: settings.herdr.runtime === "disabled" ? "disabled" : "bundled",
          socketPath: undefined,
        },
        captain: { ...settings.captain, workingDirectory: workspaces[0] },
        execution: {
          ...settings.execution,
          connections: [],
          workspaces: workspaces.map((dir) => ({ kind: "directory", path: dir })),
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  for (const dir of ["state", "s", "tmp", "h"])
    await mkdir(join(home, dir), { recursive: true, mode: 0o700 });
  await writeFile(join(control, "refusal-probe"), "Owner-readable sandbox refusal probe\n", { mode: 0o600 });
  await writeFile(join(control, "profile.sb"), localSandboxProfile(control, envelope), { mode: 0o600 });
  // Publish last; partial preparation cannot become a healthy unrestricted launch.
  await writeFile(join(control, "envelope.json"), JSON.stringify(envelope), { mode: 0o600, flag: "wx" });
  await chmod(control, 0o700);
  return envelope;
}

export async function removeLocalSandbox(control: string): Promise<void> {
  // Native permissions refuse this operation from the bounded service/worker.
  // Keep the private home and all workspace data; only remove launch controls.
  await rm(join(control, "envelope.json"), { force: true });
  await rm(join(control, "profile.sb"), { force: true });
  await rm(join(control, "refusal-probe"), { force: true });
}

/** Every owner/recovery launch uses the persisted envelope, not mutable access intent. */
export async function localSandboxLaunch(input: {
  control: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  runtimeRoot: string;
  operatorToken?: string;
}): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
  const envelope = await readLocalSandbox(input.control);
  if (!envelope) return { command: input.command, args: [...input.args], env: input.env };
  if (process.platform !== "darwin" || (await realpath(input.runtimeRoot)) !== envelope.runtimeRoot)
    throw new Error(
      "Sandbox runtime changed or macOS Seatbelt is unavailable; owner re-preparation required",
    );
  const profile = await readFile(join(input.control, "profile.sb"), "utf8");
  if (profile !== localSandboxProfile(input.control, envelope))
    throw new Error("Sandbox profile does not match its envelope");
  // The launching owner can read this same-user file; the child must prove the
  // newly applied OS boundary changes that, rather than relying on POSIX denial.
  await readFile(join(input.control, "refusal-probe"));
  // Do not hand ambient credentials, injected loaders, login profiles or IPC pointers to this home.
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "LANG",
    "LC_ALL",
    "TERM",
    "COLORTERM",
    "HOST",
    "PORT",
    "CLANKIE_HOST",
    "CLANKIE_CAPTAIN_TOKEN",
    "CLANKIE_OPERATOR_TOKEN",
  ])
    if (input.env[name] !== undefined) env[name] = input.env[name];
  Object.assign(env, {
    HOME: envelope.home,
    XDG_CONFIG_HOME: join(envelope.home, "config"),
    XDG_STATE_HOME: join(envelope.home, "state"),
    CLANKIE_STATE_HOME: join(envelope.home, "state"),
    CLANKIE_SETTINGS_FILE: join(envelope.home, "config", "clankie", "settings.json"),
    CLANKIE_STATE: join(envelope.home, "s"),
    TMPDIR: join(envelope.home, "tmp"),
    // Do not load a host OpenSSL configuration with arbitrary include paths.
    OPENSSL_CONF: "/dev/null",
    SHELL: "/bin/zsh",
    [LOCAL_SANDBOX_ENV]: input.control,
    PATH: [
      join(envelope.home, "bin"),
      join(envelope.runtimeRoot, "bin"),
      join(envelope.runtimeRoot, "libexec"),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
  });
  if (input.operatorToken !== undefined) env.CLANKIE_OPERATOR_TOKEN = input.operatorToken;
  return {
    command: "/usr/bin/sandbox-exec",
    args: ["-f", join(input.control, "profile.sb"), input.command, ...input.args],
    env,
  };
}

/** Kernel refusal, not a launch marker, establishes this process's immutable ceiling. */
export async function verifyLocalSandbox(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<LocalSandboxEnvelope> | undefined> {
  const control = env[LOCAL_SANDBOX_ENV];
  if (!control) return undefined;
  if (process.platform !== "darwin") throw new Error("Sandbox attestation requires macOS");
  const envelope = await readLocalSandbox(control);
  if (!envelope) throw new Error("Sandbox envelope is missing");
  const probe = join(control, "refusal-probe");
  const info = await stat(probe);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o400) === 0 ||
    [envelope.home, ...envelope.workspaces, envelope.runtimeRoot].some((dir) => within(probe, dir))
  )
    throw new Error("Sandbox refusal probe must be an owner-readable regular file");
  try {
    await readFile(probe);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    verified = Object.freeze(envelope);
    return verified;
  }
  throw new Error("Sandbox is not enforced: its outside refusal probe was readable");
}

export function verifiedLocalSandbox(): Readonly<LocalSandboxEnvelope> | undefined {
  return verified;
}
export function localSandboxAccess(level: MachineAccessLevel): MachineAccessLevel {
  return verified && !machineAccessAllows(verified.accessLevel, level) ? verified.accessLevel : level;
}
