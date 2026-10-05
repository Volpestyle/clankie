import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
const birth = z.tuple([z.string().regex(/^[1-9]\d{0,19}$/u), z.string().regex(/^\d{1,6}$/u)]);
const pid = z.number().int().min(2).max(2_147_483_647);
const SnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z
      .object({
        pid,
        uid: z.number().int().min(0),
        birth,
        socket: z.string().regex(/^\d+:\d+:\d+$/u),
      })
      .strict(),
    ancestors: z
      .array(z.object({ pid, ppid: z.number().int().min(0).max(2_147_483_647), birth }).strict())
      .min(1)
      .max(64),
  })
  .strict();

const ProcessSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    processes: z
      .array(
        z
          .object({
            pid,
            ppid: z.number().int().min(0).max(2_147_483_647),
            uid: z.number().int().min(0),
            birth,
            executable: z.string().min(1).max(4096).refine(isAbsolute),
            argv: z.array(z.string().max(4096)).max(2),
          })
          .strict(),
      )
      .length(2),
  })
  .strict();

export type NativeProcessSnapshot = z.infer<typeof ProcessSnapshotSchema>;

/** Lossless kernel birth, including microseconds; never a display timestamp. */
export function nativeProcessStart(birth: readonly [string, string]): string {
  return `${birth[0]}.${birth[1].padStart(6, "0")}`;
}

/** Fresh same-user kernel executable/argv/lifetime observations, never a shell fallback. */
export async function observeNativeProcesses(
  shellPid: number,
  agentPid: number,
  processHelper = fleetProcessHelper(),
  execute?: (command: string, args: string[]) => Promise<string>,
): Promise<NativeProcessSnapshot | undefined> {
  if (
    (execute === undefined && process.platform !== "darwin") ||
    !isAbsolute(processHelper) ||
    !pid.safeParse(shellPid).success ||
    !pid.safeParse(agentPid).success ||
    shellPid === agentPid
  )
    return undefined;
  try {
    const args = ["--processes", String(shellPid), String(agentPid)];
    const stdout = execute
      ? await execute(processHelper, args)
      : (await exec(processHelper, args, { timeout: 1_000, maxBuffer: 1_048_576, encoding: "utf8" })).stdout;
    const parsed = ProcessSnapshotSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) return undefined;
    const snapshot = parsed.data;
    if (
      snapshot.processes[0]!.pid !== shellPid ||
      snapshot.processes[1]!.pid !== agentPid ||
      snapshot.processes.some((processIdentity) => processIdentity.uid !== process.getuid?.())
    )
      return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

const DiagnosticSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.enum([
      "startup",
      "arguments",
      "census",
      "process",
      "fd_list",
      "fd_socket",
      "socket_owner",
      "owner_pin",
      "ancestry",
      "final_socket",
      "completion",
      "executable",
      "argv",
    ]),
    reason: z.enum([
      "clock_unavailable",
      "invalid_arguments",
      "process_census_unavailable",
      "process_census_changed",
      "allocation_failed",
      "process_unavailable",
      "process_changed",
      "fd_list_unavailable",
      "fd_list_bounds",
      "fd_record_invalid",
      "socket_unavailable",
      "socket_identity_invalid",
      "multiple_owners",
      "owner_not_found",
      "budget_exhausted",
      "owner_mismatch",
      "socket_mismatch",
      "ancestry_bounds",
      "ancestry_cycle",
      "ancestry_unavailable",
      "ancestry_changed",
      "attempts_exhausted",
      "executable_unavailable",
      "argv_unavailable",
      "argv_invalid",
      "executable_changed",
      "argv_changed",
    ]),
    errno: z.number().int().min(0),
    attempt: z.number().int().min(0).max(3),
    retry: z.boolean(),
  })
  .strict();

export type NativeProcessDiagnostic = z.infer<typeof DiagnosticSchema>;

/** Opt-in fixed kernel stages only; observation cannot change admission. */
function nativeDiagnostics(stderr: string, report?: (event: NativeProcessDiagnostic) => void) {
  if (report === undefined) return;
  const prefix = "Native process proof diagnostic: ";
  for (const line of stderr.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed = DiagnosticSchema.safeParse(JSON.parse(line.slice(prefix.length)));
      if (parsed.success) void Promise.resolve(report(parsed.data)).catch(() => {});
    } catch {
      // Neither a malformed diagnostic nor its observer changes the proof.
    }
  }
}

export interface NativeSocketOwner {
  readonly pid: number;
  readonly uid: number;
  readonly birth: readonly [string, string];
  readonly socket: string;
}
export interface NativeSocketProcess {
  readonly schemaVersion: 1;
  readonly owner: NativeSocketOwner;
  readonly ancestors: readonly {
    readonly pid: number;
    readonly ppid: number;
    readonly birth: readonly [string, string];
  }[];
}

/** The immutable release ships this helper; source startup prepares its local build. */
export function fleetProcessHelper(repoRoot = resolve(import.meta.dirname, "../../..")): string {
  const packaged = join(repoRoot, "libexec/local-fleet-proof");
  return existsSync(packaged) ? packaged : join(repoRoot, ".local/fleet-proof/native-process-proof");
}

/**
 * Fresh kernel socket ownership, process births and ancestry. An expected owner
 * is an additional refusal fence, never authority or a shortcut around a census.
 * Nothing is taken from the caller's request headers.
 */
export async function observeSocketProcess(
  socket: Socket,
  processHelper: string,
  expected?: NativeSocketOwner,
  report?: (event: NativeProcessDiagnostic) => void,
): Promise<NativeSocketProcess | undefined> {
  if (
    process.platform !== "darwin" ||
    !isAbsolute(processHelper) ||
    socket.destroyed ||
    !socket.readable ||
    !socket.writable ||
    socket.remoteAddress !== "127.0.0.1" ||
    socket.localAddress !== "127.0.0.1" ||
    !socket.remotePort ||
    !socket.localPort
  )
    return undefined;
  try {
    const { stdout, stderr } = await exec(
      processHelper,
      [
        String(socket.remotePort),
        String(socket.localPort),
        ...(expected === undefined ? [] : [String(expected.pid), ...expected.birth, expected.socket]),
        ...(report === undefined ? [] : ["--diagnostics"]),
      ],
      { timeout: 1_000, maxBuffer: 65_536, encoding: "utf8" },
    );
    nativeDiagnostics(stderr, report);
    const result = SnapshotSchema.safeParse(JSON.parse(stdout));
    if (!result.success) return undefined;
    const snapshot = result.data;
    const first = snapshot.ancestors[0]!;
    if (
      snapshot.owner.uid !== process.getuid?.() ||
      first.pid !== snapshot.owner.pid ||
      JSON.stringify(first.birth) !== JSON.stringify(snapshot.owner.birth) ||
      new Set(snapshot.ancestors.map((ancestor) => ancestor.pid)).size !== snapshot.ancestors.length ||
      snapshot.ancestors.some((ancestor, index) =>
        index + 1 < snapshot.ancestors.length
          ? ancestor.ppid !== snapshot.ancestors[index + 1]!.pid
          : ancestor.ppid > 1,
      ) ||
      (expected !== undefined &&
        (snapshot.owner.pid !== expected.pid ||
          snapshot.owner.uid !== expected.uid ||
          snapshot.owner.birth[0] !== expected.birth[0] ||
          snapshot.owner.birth[1] !== expected.birth[1] ||
          snapshot.owner.socket !== expected.socket))
    )
      return undefined;
    return snapshot;
  } catch (error) {
    if (error !== null && typeof error === "object" && "stderr" in error && typeof error.stderr === "string")
      nativeDiagnostics(error.stderr, report);
    // Missing helper, unsupported ABI, ambiguous owner, exit, reuse or timeout:
    // none establishes process membership; no legacy scan silently substitutes.
    return undefined;
  }
}
