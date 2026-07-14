import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerResult } from "@clankie/protocol";
import type { WorkerAdapter, WorkerDescriptor, WorkerRunContext } from "@clankie/worker-sdk";
import {
  SandboxPreparationError,
  ShellSandbox,
  type PreparedSandbox,
  type SandboxDenial,
  type SandboxEscalation,
} from "./sandbox.ts";
import type { TerminalManager } from "./terminals.ts";

const execFileAsync = promisify(execFile);
const DEFAULT_SHELL_WORKER_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SHELL_WORKER_TERMINATION_GRACE_MS = 5_000;

export interface ShellWorkerOptions {
  id: string;
  commandForTask: (context: WorkerRunContext) => { command: string; args: string[] };
  sandbox?: ShellSandbox;
  sandboxForTask?: (context: WorkerRunContext) => SandboxEscalation;
  environmentForTask?: (context: WorkerRunContext) => NodeJS.ProcessEnv;
  timeoutMs?: number;
  terminationGraceMs?: number;
  terminalManager?: TerminalManager;
}

export class ShellWorkerAdapter implements WorkerAdapter {
  public readonly descriptor: WorkerDescriptor;

  private readonly options: ShellWorkerOptions;
  private readonly sandbox: ShellSandbox;

  public constructor(options: ShellWorkerOptions) {
    this.options = options;
    this.sandbox = options.sandbox ?? new ShellSandbox();
    this.descriptor = {
      id: options.id,
      displayName: options.id,
      harness: "shell" as const,
      capabilities: {
        kinds: ["implementation", "debugging", "verification", "review", "integration"],
        canWrite: true,
        supportsStructuredEvents: false,
        supportsTerminal: true,
        supportsNativeSession: false,
      },
    };
  }

  public async run(context: WorkerRunContext): Promise<WorkerResult> {
    const invocation = this.options.commandForTask(context);
    let prepared: PreparedSandbox;
    try {
      prepared = await this.sandbox.prepare(
        {
          missionId: context.missionId,
          taskId: context.task.id,
          workerRunId: context.workerRunId,
          profileHash: context.profileHash,
          risk: context.task.risk,
          workspacePath: context.workspacePath,
        },
        invocation,
        safeWorkerEnvironment(context, this.options.environmentForTask?.(context)),
        this.options.sandboxForTask?.(context),
      );
    } catch (error) {
      if (error instanceof SandboxPreparationError) {
        return sandboxFailure(context, invocation, "unavailable", [error.denial]);
      }
      return sandboxFailure(context, invocation, "unavailable", [
        {
          operation: "platform",
          reason: "Sandbox preparation failed before worker execution",
        },
      ]);
    }
    context.emit({
      type: "terminal.command.started",
      missionId: context.missionId,
      taskId: context.task.id,
      profileHash: context.profileHash,
      data: { command: invocation.command, args: invocation.args, sandboxProfile: prepared.profile },
    });
    if (this.options.terminalManager) {
      return this.runInTerminal(context, invocation, prepared);
    }
    try {
      const result = await execFileAsync(prepared.command, prepared.args, {
        cwd: context.workspacePath,
        env: prepared.environment,
        timeout: this.options.timeoutMs ?? DEFAULT_SHELL_WORKER_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        signal: context.signal,
      });
      const denials = await prepared.collectDenials();
      if (denials.length > 0) return sandboxFailure(context, invocation, prepared.profile, denials);
      return {
        status: "succeeded",
        summary: `${invocation.command} completed successfully.`,
        evidence: [
          {
            kind: "command",
            label: "shell-command",
            summary: [invocation.command, ...invocation.args].join(" "),
          },
          {
            kind: "log",
            label: "shell-output",
            summary: `${result.stdout}\n${result.stderr}`.trim().slice(-20_000),
          },
        ],
        outputs: { stdout: result.stdout, stderr: result.stderr, sandboxProfile: prepared.profile },
      };
    } catch (error) {
      const value = error as Error & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
        signal?: NodeJS.Signals;
      };
      const denials = await prepared.collectDenials(value.signal);
      if (denials.length > 0) {
        return sandboxFailure(context, invocation, prepared.profile, denials, value.code);
      }
      return {
        status: "failed",
        summary: `${invocation.command} failed.`,
        evidence: [
          {
            kind: "log",
            label: "shell-failure",
            summary: `${value.stdout ?? ""}\n${value.stderr ?? value.message}`.trim().slice(-20_000),
          },
        ],
        outputs: { exitCode: value.code ?? null },
        diagnosis: value.message,
      };
    } finally {
      await prepared.close();
    }
  }

  private async runInTerminal(
    context: WorkerRunContext,
    invocation: { command: string; args: string[] },
    prepared: PreparedSandbox,
  ): Promise<WorkerResult> {
    const manager = this.options.terminalManager as TerminalManager;
    const session = manager.spawnTerminal({
      workerRunId: context.workerRunId,
      title: this.descriptor.displayName,
      command: prepared.command,
      args: prepared.args,
      cwd: context.workspacePath,
      env: prepared.environment,
      context: {
        missionId: context.missionId,
        taskId: context.task.id,
        attempt: context.attempt,
        provider: this.descriptor.id,
      },
    });
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const terminate = () => {
      if (forceKill !== undefined) return;
      manager.cancel(session.id);
      forceKill = setTimeout(
        () => manager.kill(session.id),
        this.options.terminationGraceMs ?? DEFAULT_SHELL_WORKER_TERMINATION_GRACE_MS,
      );
    };
    context.signal.addEventListener("abort", terminate, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, this.options.timeoutMs ?? DEFAULT_SHELL_WORKER_TIMEOUT_MS);
    let exitCode: number | null = null;
    try {
      for await (const frame of manager.observe(session.id)) {
        if (frame.type === "closed") exitCode = frame.exitCode;
      }
      const denials = await prepared.collectDenials();
      if (denials.length > 0)
        return sandboxFailure(context, invocation, prepared.profile, denials, exitCode ?? undefined);
      return exitCode === 0 && !timedOut
        ? {
            status: "succeeded",
            summary: `${invocation.command} completed successfully in a native PTY.`,
            evidence: [
              {
                kind: "command",
                label: "shell-command",
                summary: "Interactive command completed in runner terminal.",
              },
            ],
            outputs: { terminalId: session.id, sandboxProfile: prepared.profile },
          }
        : {
            status: "failed",
            summary: `${invocation.command} failed in a native PTY.`,
            evidence: [],
            outputs: { terminalId: session.id, exitCode },
            diagnosis: timedOut
              ? "Interactive command timed out."
              : "Interactive command exited unsuccessfully.",
          };
    } finally {
      clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      context.signal.removeEventListener("abort", terminate);
      await prepared.close();
    }
  }
}

function safeWorkerEnvironment(
  context: WorkerRunContext,
  supplied: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: context.workspacePath,
    TMPDIR: context.workspacePath,
    ...supplied,
  };
}

function sandboxFailure(
  context: WorkerRunContext,
  invocation: { command: string; args: string[] },
  profile: PreparedSandbox["profile"] | "unavailable",
  denials: SandboxDenial[],
  exitCode?: number | string,
): WorkerResult {
  context.emit({
    type: "sandbox.denied",
    missionId: context.missionId,
    taskId: context.task.id,
    profileHash: context.profileHash,
    data: { sandboxProfile: profile, denials },
  });
  return {
    status: "failed",
    summary: `${invocation.command} was denied by the worker sandbox.`,
    evidence: [
      {
        kind: "command",
        label: "shell-command",
        summary: [invocation.command, ...invocation.args].join(" "),
      },
      {
        kind: "log",
        label: "sandbox-denial",
        summary: JSON.stringify({ profile, denials }),
      },
    ],
    outputs: { exitCode: exitCode ?? null, sandbox: { profile, denials } },
    diagnosis: denials.map((denial) => denial.reason).join("; "),
  };
}
