import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, isAbsolute, join, normalize } from "node:path";
import { access, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { OPERATOR_SEAT_HARNESSES, type HerdrBinding } from "@clankie/protocol";
import { parseHerdrAgentResult } from "./captain/herdr-watch.ts";
import { occupantIdForHerdrSession, recoverLocalCodexSession } from "./captain/herdr-census.ts";
import { pinHerdrEnvironment } from "./herdr-session.ts";
import {
  fleetProcessHelper,
  nativeProcessStart,
  observeNativeProcesses,
  type NativeProcessDiagnostic,
} from "./local-fleet-process.ts";
import type { NativeTransportReason } from "./native-process-transport.ts";
import { nativeRequest } from "./herdr-native-request.ts";

type Run = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
const exec = promisify(execFile);
const run: Run = async (command, args, env) =>
  (await exec(command, args, { env, timeout: 5_000, maxBuffer: 2_000_000, encoding: "utf8" })).stdout;
interface NativeLauncher {
  executable: string;
  script?: string;
}
/** Resolve only the service's installed launcher; request headers and pane metadata cannot choose it. */
async function installedLauncher(harness: string): Promise<NativeLauncher | undefined> {
  const find = async (name: string) => {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      const path = join(directory, name);
      try {
        await access(path, constants.X_OK);
        return await realpath(path);
      } catch {
        /* Next service PATH entry. */
      }
    }
    return undefined;
  };
  const launcher = await find(harness);
  if (!launcher) return undefined;
  const file = await open(launcher, "r");
  const header = Buffer.alloc(256);
  try {
    await file.read(header, 0, header.length, 0);
  } finally {
    await file.close();
  }
  if (!header.subarray(0, 2).equals(Buffer.from("#!"))) return { executable: launcher };
  const shebang = header.toString("utf8").split("\n")[0]?.trim();
  if (shebang !== "#!/usr/bin/env node") return undefined;
  const interpreter = await find("node");
  return interpreter ? { executable: interpreter, script: launcher } : undefined;
}

/** A running seat's harness binary differs from the installed one only by its release. */
export interface HarnessUpdate {
  readonly harness: string;
  /** Release of the running seat's executable, e.g. `0.160.0`. */
  readonly running: string;
  /** Release the installed launcher now resolves to, e.g. `0.160.1`. */
  readonly installed: string;
}

/**
 * Harness auto-updates install each release beside the last one
 * (`…/releases/0.160.1-aarch64-apple-darwin/bin/codex`, `…/versions/2.1.3`) and
 * repoint the launcher. A seat started before the update keeps running the old
 * release. That process is still the installed harness: the two paths are
 * identical except for one version-named directory or file with the same
 * suffix. Any other difference, including a different install root, platform
 * suffix or file name, is a different executable and is refused.
 */
export function harnessReleaseSibling(
  installed: string,
  running: string,
): { readonly installed: string; readonly running: string } | undefined {
  if (installed === running || !isAbsolute(installed) || !isAbsolute(running)) return undefined;
  if (normalize(running) !== running || normalize(installed) !== installed) return undefined;
  const a = installed.split("/");
  const b = running.split("/");
  if (a.length !== b.length) return undefined;
  const differing = a.flatMap((segment, index) => (segment === b[index] ? [] : [index]));
  // The version directory sits inside a harness-owned install root, never near `/`.
  if (differing.length !== 1 || differing[0]! < 3) return undefined;
  const version = /^v?(\d+(?:\.\d+){1,3})((?:[-+_][0-9A-Za-z._+-]*)?)$/u;
  const installedRelease = a[differing[0]!]!.match(version);
  const runningRelease = b[differing[0]!]!.match(version);
  if (!installedRelease || !runningRelease || installedRelease[2] !== runningRelease[2]) return undefined;
  return { installed: installedRelease[1]!, running: runningRelease[1]! };
}

/**
 * The latest proof outcome per local pane: which seats run a superseded harness
 * release. Filled by proofs that already run for bridge and peer calls; a
 * roster read never probes processes for it.
 */
export class HarnessBinaryObservations {
  private readonly panes = new Map<
    string,
    { readonly occupantId: string; readonly update: HarnessUpdate; readonly observedAt: string }
  >();
  readonly record = (pane: string, occupantId: string, update: HarnessUpdate | undefined): void => {
    this.panes.delete(pane);
    if (update === undefined) return;
    this.panes.set(pane, { occupantId, update, observedAt: new Date().toISOString() });
    // Bounded like the roster; the oldest observation goes first.
    if (this.panes.size > 256) this.panes.delete(this.panes.keys().next().value!);
  };
  status(pane: string) {
    return this.panes.get(pane);
  }
}

export interface ProjectProcessProof {
  readonly fleet: string;
  /** Remote OS observation; machineId comes from the registered fleet, never the caller. */
  readonly workspace?: {
    readonly machineId: string;
    readonly platform: "windows" | "posix";
    readonly canonicalPath: string;
  };
  readonly pane: string;
  readonly nativeOccupantId: string;
  /** Kernel-proven startup process, before native session reporting. Never a hired/private seat. */
  readonly nativeSessionPending?: true;
  /** Only a trusted listener may set this after checking the private native-process registry. */
  readonly privateSeat?: true;
  readonly binding: { readonly socketPath: string; readonly session?: string };
  readonly processes: readonly { readonly pid: number; readonly startTime: string }[];
  readonly shell: { readonly pid: number; readonly startTime: string };
}

/** Host observation only. A foreground shell/wrapper is not an actual agent occupant. */
export function createProjectProcessObserver(options: {
  binding(): Promise<HerdrBinding | undefined>;
  herdrBinary: string;
  run?: Run;
  platform?: string;
  launcher?(harness: string): Promise<NativeLauncher | undefined>;
  canonical?(path: string): Promise<string>;
  processHelper?: string;
  signal?: AbortSignal;
  nativeDiagnostics?(event: NativeProcessDiagnostic, checkpoint: "initial" | "final", pane: string): void;
  nativeTransportDiagnostics?(reason: NativeTransportReason, pane: string): void;
  /** Every completed proof reports whether its seat runs a superseded harness release. */
  harnessBinary?(pane: string, occupantId: string, update: HarnessUpdate | undefined): void;
}) {
  const execute = options.run ?? run;
  const canonical = options.canonical ?? realpath;
  return async (fleet: string, pane: string): Promise<ProjectProcessProof | undefined> => {
    if (
      fleet !== "default" ||
      (options.platform ?? process.platform) !== "darwin" ||
      !/^w[\w]+:p[\w]+$/u.test(pane)
    )
      return undefined;
    try {
      const binding = await options.binding();
      if (!binding) return undefined;
      const read = async (method: string, params: unknown, args: string[]) =>
        options.run
          ? JSON.parse(
              await execute(
                options.herdrBinary,
                args,
                pinHerdrEnvironment({ ...process.env }, binding.socketPath),
              ),
            )
          : await nativeRequest(binding, method, params, {
              timeoutMs: 5_000,
              ...(options.signal ? { signal: options.signal } : {}),
            });
      const info = async () => {
        const response = (await read("pane.process_info", { pane_id: pane }, [
          "pane",
          "process-info",
          "--pane",
          pane,
        ])) as {
          result?: {
            process_info?: { pane_id?: string; shell_pid?: number; foreground_process_group_id?: number };
          };
        };
        const value = response?.result?.process_info;
        if (value?.pane_id !== pane) throw new Error("Pane changed");
        return value;
      };
      const native = async () => {
        const agent = parseHerdrAgentResult(
          JSON.stringify(await read("agent.get", { target: pane }, ["agent", "get", pane])),
        );
        if (agent.paneId !== pane || !OPERATOR_SEAT_HARNESSES.some((harness) => harness === agent.agent))
          throw new Error("Native harness unavailable");
        const session =
          agent.session ??
          (await recoverLocalCodexSession(agent, {
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.run === undefined ? { nativeProof: true as const } : {}),
            bridgeSocket: binding.socketPath,
            herdrSession: binding.session,
            runCommand: async (command, args) => ({
              stdout:
                command === "herdr" && args[0] === "pane" && args[1] === "process-info"
                  ? JSON.stringify(await read("pane.process_info", { pane_id: pane }, [...args]))
                  : await execute(
                      command,
                      [...args],
                      pinHerdrEnvironment({ ...process.env }, binding.socketPath),
                    ),
              stderr: "",
            }),
          }));
        return {
          nativeOccupantId: session ? occupantIdForHerdrSession(session) : undefined,
          terminalId: agent.terminalId,
          harness: agent.agent,
        };
      };
      const nativeInitial = await native();
      const launcher = await (options.launcher ?? installedLauncher)(nativeInitial.harness);
      if (!launcher) return undefined;
      const initial = await info();
      const shellPid = initial.shell_pid;
      const agentPid = initial.foreground_process_group_id;
      if (shellPid === undefined || agentPid === undefined) return undefined;
      if (![shellPid, agentPid].every((pid) => Number.isSafeInteger(pid) && pid > 1) || shellPid === agentPid)
        return undefined;
      const snapshot = (checkpoint: "initial" | "final") =>
        observeNativeProcesses(
          shellPid,
          agentPid,
          options.processHelper ?? fleetProcessHelper(),
          options.run,
          options.signal,
          options.nativeDiagnostics && ((event) => options.nativeDiagnostics!(event, checkpoint, pane)),
          options.nativeTransportDiagnostics &&
            ((reason) => options.nativeTransportDiagnostics!(reason, pane)),
        );
      const initialProcesses = await snapshot("initial");
      if (!initialProcesses) return undefined;
      const [shell, agent] = initialProcesses.processes;
      // The installed executable, or an earlier/later release beside it that a
      // harness auto-update left running. A superseded release may already be
      // pruned from disk; its kernel path is then compared without resolution.
      const executableRelease = async (
        path: string,
      ): Promise<false | { readonly installed: string; readonly running: string } | undefined> => {
        const resolved = await canonical(path).catch(() => undefined);
        if (resolved === launcher.executable) return undefined;
        return harnessReleaseSibling(launcher.executable, resolved ?? path) ?? false;
      };
      const matchesLauncher = async (
        observed: NonNullable<typeof agent>,
      ): Promise<false | { readonly update?: HarnessUpdate }> => {
        const executable = await executableRelease(observed.executable);
        if (executable === false) return false;
        const update = (release: { installed: string; running: string } | undefined) =>
          release === undefined ? {} : { update: { harness: nativeInitial.harness, ...release } };
        if (!launcher.script) return update(executable);
        // Interpreter launches need the exact installed script as argv[1], never an arbitrary
        // command containing its name. Unsupported wrappers/process-title rewrites deny.
        const [interpreter, script] = observed.argv;
        if (!interpreter || !script || !isAbsolute(interpreter) || !isAbsolute(script)) return false;
        const interpreterRelease = await executableRelease(interpreter);
        if (interpreterRelease === false || (await canonical(script)) !== launcher.script) return false;
        return update(interpreterRelease ?? executable);
      };
      const initialMatch = shell && agent ? await matchesLauncher(agent) : false;
      if (!shell || !agent || !initialMatch) return undefined;
      // Keep a roster read's permit until every owned native child has closed,
      // even when another observation fails or cancellation arrives first.
      const [paneRead, nativeRead, processRead] = await Promise.allSettled([
        info(),
        native(),
        snapshot("final"),
      ]);
      if (
        paneRead.status !== "fulfilled" ||
        nativeRead.status !== "fulfilled" ||
        processRead.status !== "fulfilled"
      )
        return undefined;
      const latest = paneRead.value;
      const latestNative = nativeRead.value;
      const finalProcesses = processRead.value;
      const finalMatch = finalProcesses ? await matchesLauncher(finalProcesses.processes[1]!) : false;
      if (
        !finalProcesses ||
        !finalMatch ||
        JSON.stringify(finalMatch) !== JSON.stringify(initialMatch) ||
        JSON.stringify(latestNative) !== JSON.stringify(nativeInitial) ||
        latest.shell_pid !== shellPid ||
        latest.foreground_process_group_id !== agentPid ||
        JSON.stringify(finalProcesses) !== JSON.stringify(initialProcesses)
      )
        return undefined;
      const current = await options.binding();
      if (current?.socketPath !== binding.socketPath || current?.session !== binding.session)
        return undefined;
      const nativeOccupantId =
        nativeInitial.nativeOccupantId ??
        `process-${createHash("sha256")
          .update(JSON.stringify([binding, pane, nativeInitial, shell, agent]))
          .digest("hex")}`;
      try {
        options.harnessBinary?.(pane, nativeOccupantId, initialMatch.update);
      } catch {
        // A diagnostic observer never changes the proof.
      }
      return {
        fleet,
        pane,
        // SessionStart reporting can depend on MCP startup completing. The actual installed
        // foreground process is already proven above; a disjoint process identity permits
        // only owner-started workspace access until a native session is reported.
        nativeOccupantId,
        ...(nativeInitial.nativeOccupantId === undefined ? { nativeSessionPending: true as const } : {}),
        binding: {
          socketPath: binding.socketPath,
          ...(binding.session === undefined ? {} : { session: binding.session }),
        },
        shell: { pid: shell.pid, startTime: nativeProcessStart(shell.birth) },
        // The release is reported beside the proof, never inside it: process
        // identity and keys derived from it do not change when the harness updates.
        processes: [{ pid: agent.pid, startTime: nativeProcessStart(agent.birth) }],
      };
    } catch {
      return undefined;
    }
  };
}
