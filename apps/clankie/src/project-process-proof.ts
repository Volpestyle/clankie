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
      const info = async () => {
        const response = JSON.parse(
          await execute(
            options.herdrBinary,
            ["pane", "process-info", "--pane", pane],
            pinHerdrEnvironment({ ...process.env }, binding.socketPath),
          ),
        );
        const value = response?.result?.process_info;
        if (value?.pane_id !== pane) throw new Error("Pane changed");
        return value;
      };
      const native = async () => {
        const agent = parseHerdrAgentResult(
          await execute(
            options.herdrBinary,
            ["agent", "get", pane],
            pinHerdrEnvironment({ ...process.env }, binding.socketPath),
          ),
        );
        if (agent.paneId !== pane || !OPERATOR_SEAT_HARNESSES.some((harness) => harness === agent.agent))
          throw new Error("Native harness unavailable");
        const session =
          agent.session ??
          (await recoverLocalCodexSession(agent, {
            bridgeSocket: binding.socketPath,
            herdrSession: binding.session,
            runCommand: async (command, args) => ({
              stdout: await execute(
                command === "herdr" ? options.herdrBinary : command,
                [...args],
                command === "herdr" ? pinHerdrEnvironment({ ...process.env }, binding.socketPath) : undefined,
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
      const shellPid: number = initial.shell_pid;
      const agentPid: number = initial.foreground_process_group_id;
      if (![shellPid, agentPid].every((pid) => Number.isSafeInteger(pid) && pid > 1) || shellPid === agentPid)
        return undefined;
      const observeProcess = async (pid: number) => {
        const output = await execute("/bin/ps", ["-p", String(pid), "-o", "lstart=,comm="]);
        const match =
          /^\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u.exec(
            output,
          );
        if (!match) throw new Error("Process unavailable");
        return { pid, startTime: match[1]!, executable: match[2]! };
      };
      const shell = await observeProcess(shellPid);
      const agent = await observeProcess(agentPid);
      const matchesLauncher = async () => {
        const mapped = await execute("/usr/sbin/lsof", ["-a", "-p", String(agentPid), "-d", "txt", "-Fn"]);
        const executable = mapped
          .split("\n")
          .find((line) => line.startsWith("n"))
          ?.slice(1);
        if (!executable || (await canonical(executable)) !== launcher.executable) return false;
        if (!launcher.script) return true;
        const command = (await execute("/bin/ps", ["-p", String(agentPid), "-o", "command="])).trim();
        // Interpreter launches need the exact installed script as argv[1], never an arbitrary
        // command containing its name. Unsupported wrappers/process-title rewrites deny.
        const [interpreter, script] = command.split(/\s+/u);
        return (
          !!interpreter &&
          !!script &&
          isAbsolute(interpreter) &&
          isAbsolute(script) &&
          (await canonical(interpreter)) === launcher.executable &&
          (await canonical(script)) === launcher.script
        );
      };
      if (!(await matchesLauncher())) return undefined;
      const latest = await info();
      if (
        !(await matchesLauncher()) ||
        JSON.stringify(await native()) !== JSON.stringify(nativeInitial) ||
        latest.shell_pid !== shellPid ||
        latest.foreground_process_group_id !== agentPid ||
        JSON.stringify(await observeProcess(shellPid)) !== JSON.stringify(shell) ||
        JSON.stringify(await observeProcess(agentPid)) !== JSON.stringify(agent)
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
        shell: { pid: shell.pid, startTime: shell.startTime },
        processes: [{ pid: agent.pid, startTime: agent.startTime }],
      };
    } catch {
      return undefined;
    }
  };
}
