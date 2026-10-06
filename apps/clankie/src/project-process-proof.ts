import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, isAbsolute, join } from "node:path";
import { access, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { OPERATOR_SEAT_HARNESSES, type HerdrBinding } from "@clankie/protocol";
import { parseHerdrAgentResult } from "./captain/herdr-watch.ts";
import { occupantIdForHerdrSession, recoverLocalCodexSession } from "./captain/herdr-census.ts";
import { pinHerdrEnvironment } from "./herdr-session.ts";
import { fleetProcessHelper, nativeProcessStart, observeNativeProcesses } from "./local-fleet-process.ts";
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
      const snapshot = () =>
        observeNativeProcesses(
          shellPid,
          agentPid,
          options.processHelper ?? fleetProcessHelper(),
          options.run,
          options.signal,
        );
      const initialProcesses = await snapshot();
      if (!initialProcesses) return undefined;
      const [shell, agent] = initialProcesses.processes;
      const matchesLauncher = async (observed: NonNullable<typeof agent>) => {
        if ((await canonical(observed.executable)) !== launcher.executable) return false;
        if (!launcher.script) return true;
        // Interpreter launches need the exact installed script as argv[1], never an arbitrary
        // command containing its name. Unsupported wrappers/process-title rewrites deny.
        const [interpreter, script] = observed.argv;
        return (
          !!interpreter &&
          !!script &&
          isAbsolute(interpreter) &&
          isAbsolute(script) &&
          (await canonical(interpreter)) === launcher.executable &&
          (await canonical(script)) === launcher.script
        );
      };
      if (!shell || !agent || !(await matchesLauncher(agent))) return undefined;
      // Keep a roster read's permit until every owned native child has closed,
      // even when another observation fails or cancellation arrives first.
      const [paneRead, nativeRead, processRead] = await Promise.allSettled([info(), native(), snapshot()]);
      if (
        paneRead.status !== "fulfilled" ||
        nativeRead.status !== "fulfilled" ||
        processRead.status !== "fulfilled"
      )
        return undefined;
      const latest = paneRead.value;
      const latestNative = nativeRead.value;
      const finalProcesses = processRead.value;
      if (
        !finalProcesses ||
        !(await matchesLauncher(finalProcesses.processes[1]!)) ||
        JSON.stringify(latestNative) !== JSON.stringify(nativeInitial) ||
        latest.shell_pid !== shellPid ||
        latest.foreground_process_group_id !== agentPid ||
        JSON.stringify(finalProcesses) !== JSON.stringify(initialProcesses)
      )
        return undefined;
      const current = await options.binding();
      if (current?.socketPath !== binding.socketPath || current?.session !== binding.session)
        return undefined;
      return {
        fleet,
        pane,
        // SessionStart reporting can depend on MCP startup completing. The actual installed
        // foreground process is already proven above; a disjoint process identity permits
        // only owner-started workspace access until a native session is reported.
        nativeOccupantId:
          nativeInitial.nativeOccupantId ??
          `process-${createHash("sha256")
            .update(JSON.stringify([binding, pane, nativeInitial, shell, agent]))
            .digest("hex")}`,
        ...(nativeInitial.nativeOccupantId === undefined ? { nativeSessionPending: true as const } : {}),
        binding: {
          socketPath: binding.socketPath,
          ...(binding.session === undefined ? {} : { session: binding.session }),
        },
        shell: { pid: shell.pid, startTime: nativeProcessStart(shell.birth) },
        processes: [{ pid: agent.pid, startTime: nativeProcessStart(agent.birth) }],
      };
    } catch {
      return undefined;
    }
  };
}
