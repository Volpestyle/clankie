import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { FleetNativeDiagnosticReasonSchema } from "@clankie/protocol";
import { nativeProcessRequest, type NativeTransportReason } from "./native-process-transport.ts";

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

const ClaudeProcessSnapshotSchema = ProcessSnapshotSchema.extend({
  processes: z.array(ProcessSnapshotSchema.shape.processes.element).length(3),
});

export type NativeProcessSnapshot = z.infer<typeof ProcessSnapshotSchema>;

/** Lossless kernel birth, including microseconds; never a display timestamp. */
export function nativeProcessStart(birth: readonly [string, string]): string {
  return `${birth[0]}.${birth[1].padStart(6, "0")}`;
}

const ProcessBirthSchema = z
  .object({
    schemaVersion: z.literal(1),
    process: z
      .object({
        pid,
        uid: z.number().int().nonnegative(),
        birth,
      })
      .strict(),
  })
  .strict();

/** Fresh same-user process lifetime only; no executable, argv or display-time authority. */
export async function observeNativeBirth(
  processPid: number,
  signal?: AbortSignal,
): Promise<readonly [string, string] | undefined> {
  if (process.platform !== "darwin" || !pid.safeParse(processPid).success) return undefined;
  try {
    const reply = await nativeProcessRequest(fleetProcessHelper(), ["--birth", String(processPid)], signal);
    if (!reply) return undefined;
    const result = ProcessBirthSchema.parse(JSON.parse(reply.stdout)).process;
    return result.pid === processPid && result.uid === process.getuid?.() ? result.birth : undefined;
  } catch {
    return undefined;
  }
}

/** Existing server registration plus actual listener/launch observations, never caller authority. */
export async function observeCodexServer(
  processPid: number,
  endpoint: string,
  canonicalSocketPath: string,
  signal?: AbortSignal,
): Promise<readonly [string, string] | undefined> {
  if (process.platform !== "darwin" || !pid.safeParse(processPid).success) return undefined;
  try {
    const reply = await nativeProcessRequest(
      fleetProcessHelper(),
      [
        "--codex-server",
        String(processPid),
        Buffer.from(endpoint).toString("hex"),
        Buffer.from(canonicalSocketPath).toString("hex"),
      ],
      signal,
    );
    if (!reply) return undefined;
    const result = ProcessBirthSchema.parse(JSON.parse(reply.stdout)).process;
    return result.pid === processPid && result.uid === process.getuid?.() ? result.birth : undefined;
  } catch {
    return undefined;
  }
}

/** Compatibility comparison for old server-owned ps receipts; new receipts retain microseconds. */
export function nativeProcessReceipt(birth: readonly [string, string], previous?: string): string {
  if (previous === undefined || /^\d+\.\d{6}$/u.test(previous)) return nativeProcessStart(birth);
  const date = new Date(Number(birth[0]) * 1_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getMonth()]} ${String(date.getDate()).padStart(2, " ")} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${date.getFullYear()}`;
}

/** Fresh same-user kernel executable/argv/lifetime observations, never a shell fallback. */
export async function observeNativeProcesses(
  shellPid: number,
  agentPid: number,
  processHelper = fleetProcessHelper(),
  execute?: (command: string, args: string[]) => Promise<string>,
  signal?: AbortSignal,
  report?: (event: NativeProcessDiagnostic) => void,
  transport?: (reason: NativeTransportReason) => void,
  claudePid?: number,
): Promise<NativeProcessSnapshot | undefined> {
  if (
    (execute === undefined && process.platform !== "darwin") ||
    !isAbsolute(processHelper) ||
    !pid.safeParse(shellPid).success ||
    !pid.safeParse(agentPid).success ||
    shellPid === agentPid ||
    (claudePid !== undefined &&
      (!pid.safeParse(claudePid).success || claudePid === shellPid || claudePid === agentPid))
  )
    return undefined;
  try {
    const args =
      claudePid === undefined
        ? ["--processes", String(shellPid), String(agentPid)]
        : ["--claude-processes", String(shellPid), String(agentPid), String(claudePid)];
    let stdout: string | undefined;
    if (execute) stdout = await execute(processHelper, args);
    else {
      const reply = await nativeProcessRequest(
        processHelper,
        report ? [...args, "--diagnostics"] : args,
        signal,
        transport,
      );
      if (reply) {
        nativeDiagnostics(reply.stderr, report);
        stdout = reply.stdout;
      }
    }
    if (stdout === undefined) return undefined;
    const parsed = (claudePid === undefined ? ProcessSnapshotSchema : ClaudeProcessSnapshotSchema).safeParse(
      JSON.parse(stdout),
    );
    if (!parsed.success) return undefined;
    const snapshot = parsed.data;
    if (
      snapshot.processes[0]!.pid !== shellPid ||
      snapshot.processes[1]!.pid !== agentPid ||
      (claudePid !== undefined &&
        (snapshot.processes[2]!.pid !== claudePid ||
          snapshot.processes[2]!.ppid !== agentPid ||
          snapshot.processes[1]!.ppid !== shellPid)) ||
      snapshot.processes.some((processIdentity) => processIdentity.uid !== process.getuid?.())
    )
      return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

export const NativeProcessDiagnosticSchema = z
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
    reason: FleetNativeDiagnosticReasonSchema,
    errno: z.number().int().min(0),
    attempt: z.number().int().min(0).max(32),
    retry: z.boolean(),
    // Private request logs only; metrics retain the fixed reason, never these identities.
    ancestryFailure: z
      .strictObject({
        phase: z.enum(["walk", "recheck"]),
        chainIndex: z.number().int().min(0).max(63),
        failedPid: pid,
        claimantStatus: z.enum(["same", "exited", "changed", "unavailable"]),
        claimantPid: pid,
        claimantBirth: birth,
      })
      .optional(),
  })
  .strict();

export type NativeProcessDiagnostic = z.infer<typeof NativeProcessDiagnosticSchema>;

/** Opt-in fixed kernel stages only; observation cannot change admission. */
function nativeDiagnostics(stderr: string, report?: (event: NativeProcessDiagnostic) => void) {
  if (report === undefined) return;
  const prefix = "Native process proof diagnostic: ";
  for (const line of stderr.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    try {
      const parsed = NativeProcessDiagnosticSchema.safeParse(JSON.parse(line.slice(prefix.length)));
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
  transportReport?: (reason: NativeTransportReason) => void,
  signal?: AbortSignal,
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
    const reply = await nativeProcessRequest(
      processHelper,
      [
        String(socket.remotePort),
        String(socket.localPort),
        ...(expected === undefined ? [] : [String(expected.pid), ...expected.birth, expected.socket]),
        ...(report === undefined ? [] : ["--diagnostics"]),
      ],
      signal,
      transportReport,
    );
    if (!reply) return undefined;
    const { stdout, stderr } = reply;
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
