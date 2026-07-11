import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { WorkerResult } from "@sapling/protocol";
import type { WorkerAdapter, WorkerDescriptor, WorkerRunContext } from "@sapling/worker-sdk";

const execFileAsync = promisify(execFile);

export interface ShellWorkerOptions {
  id: string;
  commandForTask: (context: WorkerRunContext) => { command: string; args: string[] };
  timeoutMs?: number;
}

export class ShellWorkerAdapter implements WorkerAdapter {
  public readonly descriptor: WorkerDescriptor;

  public constructor(private readonly options: ShellWorkerOptions) {
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
    context.emit({
      type: "terminal.command.started",
      missionId: context.missionId,
      taskId: context.task.id,
      profileHash: context.profileHash,
      data: { command: invocation.command, args: invocation.args },
    });
    try {
      const result = await execFileAsync(invocation.command, invocation.args, {
        cwd: context.workspacePath,
        timeout: this.options.timeoutMs ?? 30 * 60_000,
        maxBuffer: 10 * 1024 * 1024,
        signal: context.signal,
      });
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
        outputs: { stdout: result.stdout, stderr: result.stderr },
      };
    } catch (error) {
      const value = error as Error & { stdout?: string; stderr?: string; code?: number | string };
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
    }
  }
}
