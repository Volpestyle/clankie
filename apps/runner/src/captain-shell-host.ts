/**
 * Clankie's own shell ([ADR 0086](../../../docs/adr/0086-clankie-holds-a-shell.md)).
 *
 * The runner owns it for the same reason it owns his browser: a seat that can
 * write files can edit the doctrine it is judged against, so the boundary has
 * to live in a process the captain does not control. He asks over an
 * authenticated loopback plane; the enforcement is `sandbox-exec` here.
 *
 * Two verbs, deliberately asymmetric:
 *
 * - **`run`** executes one bash command under the same `ShellSandbox` that
 *   confines a mission worker. Writes reach the scratchpad and nothing else —
 *   Seatbelt SIGKILLs a write outside it — and network egress is denied
 *   outright, because a shell that can both read the disk and reach the
 *   internet is an exfiltration tool no matter how it is described.
 * - **`read`** is an ordinary bounded file read spanning the whole host. It is
 *   `read`-class and does not need a subprocess, so it does not pay for one.
 *
 * The read boundary is the host's, not the scratchpad's. That is the operator's
 * stated intent and it is worth naming plainly: anything this account can read,
 * he can read, credentials included. The sandbox narrows what he can *change*,
 * never what he can see.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createConnectorActionClassifier, decideAction, type CompiledDoctrine } from "@clankie/doctrine";
import type { EventStore } from "@clankie/event-store";
import type {
  ActionDecision,
  CaptainFileReadRequest,
  CaptainFileReadResult,
  CaptainShellRunRequest,
  CaptainShellRunResult,
} from "@clankie/protocol";
import { ShellSandbox, SandboxPreparationError, type PreparedSandbox } from "./sandbox.ts";

/**
 * Doctrine names these two actions. `run` is `reversible-write` because the
 * only thing it can change is a scratch directory the operator can delete;
 * `read` is `read` because it changes nothing at all. An operator who wants
 * either narrowed adds it to `actions` in the doctrine profile.
 */
export const CAPTAIN_SHELL_RUN_ACTION = "shell.captain.run";
export const CAPTAIN_SHELL_READ_ACTION = "shell.captain.read";

const classify = createConnectorActionClassifier([
  { action: CAPTAIN_SHELL_RUN_ACTION, riskClass: "reversible-write" },
  { action: CAPTAIN_SHELL_READ_ACTION, riskClass: "read" },
]);

/** One result is capped well below the protocol ceiling so a `find /` cannot flood a turn. */
const MAX_STREAM_CHARACTERS = 100_000;
const MAX_READ_CHARACTERS = 100_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_READ_LINE_LIMIT = 2_000;

export interface CaptainShellLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface CaptainShellHostOptions {
  doctrine: CompiledDoctrine;
  runnerStateRoot: string;
  logger: CaptainShellLogger;
  events?: EventStore;
  environment?: NodeJS.ProcessEnv;
  /** Overrides the scratchpad location; must sit outside the attachment root. */
  scratchRoot?: string;
  sandbox?: ShellSandbox;
  spawnImpl?: typeof spawn;
  clock?: () => Date;
  idFactory?: () => string;
  principalId?: string;
}

export interface CaptainShellHost {
  /** Absolute path of the scratchpad, so the captain can be told where he lives. */
  readonly scratchPath: string;
  run(request: CaptainShellRunRequest): Promise<CaptainShellRunResult>;
  read(request: CaptainFileReadRequest): Promise<CaptainFileReadResult>;
}

export async function createCaptainShellHost(options: CaptainShellHostOptions): Promise<CaptainShellHost> {
  const environment = options.environment ?? process.env;
  // Beside the runner state root, never inside it. The attachment root defaults
  // to the runner state root, and `isGeneratedMediaRef`'s whole argument for
  // letting a picture ride a reply without an approval is that nothing the
  // captain holds can write beneath that root. A scratchpad nested inside it
  // would quietly retire that argument.
  const scratchPath = options.scratchRoot ?? join(dirname(options.runnerStateRoot), "captain-scratch");
  const attachmentRoot = environment.CLANKIE_DISCORD_ATTACHMENT_ROOT?.trim() || options.runnerStateRoot;
  if (isWithin(scratchPath, attachmentRoot)) {
    throw new Error(
      "captain scratchpad must live outside the Discord attachment root; " +
        "a writable path beneath it would make anything he writes a candidate attachment",
    );
  }
  await mkdir(scratchPath, { recursive: true, mode: 0o700 });
  const sandbox = options.sandbox ?? new ShellSandbox();
  const spawnImpl = options.spawnImpl ?? spawn;
  const clock = options.clock ?? (() => new Date());
  const idFactory = options.idFactory ?? (() => `captain-shell-${clock().toISOString()}`);
  const principalId = options.principalId ?? "captain";

  const decide = (action: string): ActionDecision =>
    decideAction(
      options.doctrine,
      {
        id: `captain-shell:${action}`,
        principal: { kind: "captain", id: principalId },
        action,
        resource: { type: "captain_shell", id: action },
        context: {
          missionId: "captain-shell",
          risk: "low",
          profileHash: options.doctrine.profileHash,
        },
      },
      classify(action),
    );

  /**
   * Every call lands an event whether or not it ran. The audit trail is half
   * the reason this crosses a process boundary at all — a shell whose refusals
   * are invisible teaches nobody anything.
   */
  const record = async (action: string, decision: ActionDecision, detail: string): Promise<void> => {
    if (!options.events) return;
    try {
      await options.events.append({
        id: idFactory(),
        occurredAt: clock().toISOString(),
        missionId: "captain-shell",
        correlationId: principalId,
        profileHash: options.doctrine.profileHash,
        type: "captain.shell.decided",
        data: {
          action,
          effect: decision.effect,
          reason: decision.reason,
          matchedPolicyIds: decision.matchedPolicyIds,
          detail: detail.slice(0, 500),
        },
      });
    } catch (error) {
      options.logger.warn(
        { event: "captain.shell.audit_failed", err: error instanceof Error ? error.message : String(error) },
        "captain shell decision could not be recorded",
      );
    }
  };

  const refusalFor = (
    decision: ActionDecision,
  ): { reason: "doctrine_denied" | "approval_required"; detail: string } =>
    decision.effect === "require_approval"
      ? { reason: "approval_required", detail: decision.reason }
      : { reason: "doctrine_denied", detail: decision.reason };

  return {
    scratchPath,

    async run(request) {
      const decision = decide(CAPTAIN_SHELL_RUN_ACTION);
      await record(CAPTAIN_SHELL_RUN_ACTION, decision, request.command);
      if (decision.effect !== "allow") {
        return { outcome: "refused", ...refusalFor(decision) };
      }

      let prepared: PreparedSandbox;
      try {
        prepared = await sandbox.prepare(
          {
            missionId: "captain-shell",
            taskId: "captain-shell",
            workerRunId: principalId,
            profileHash: options.doctrine.profileHash,
            risk: "low",
            workspacePath: scratchPath,
          },
          { command: "/bin/bash", args: ["-c", request.command] },
          // Deliberately not the runner's environment: a shell that inherits
          // CLANKIE_RUNNER_TOKEN or a provider key hands them to anything he
          // is talked into running. HOME and TMPDIR point at the scratchpad so
          // a tool that writes beside itself stays inside the boundary.
          {
            PATH: environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
            LANG: environment.LANG ?? "en_US.UTF-8",
            HOME: scratchPath,
            TMPDIR: scratchPath,
          },
        );
      } catch (error) {
        const detail =
          error instanceof SandboxPreparationError ? error.denial.reason : "sandbox preparation failed";
        options.logger.warn(
          { event: "captain.shell.sandbox_unavailable", detail },
          "captain shell sandbox unavailable",
        );
        return { outcome: "refused", reason: "sandbox_unavailable", detail };
      }

      try {
        const outcome = await execute(
          spawnImpl,
          prepared,
          scratchPath,
          request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        if (outcome.timedOut) {
          return {
            outcome: "refused",
            reason: "timed_out",
            detail: `the command was still running after ${String(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms`,
          };
        }
        const denials = await prepared.collectDenials(outcome.signal);
        return {
          outcome: "ok",
          exitCode: outcome.exitCode,
          stdout: outcome.stdout.text,
          stderr: outcome.stderr.text,
          truncated: outcome.stdout.truncated || outcome.stderr.truncated,
          denials: denials
            .slice(0, 16)
            .map((denial) => `${denial.operation}: ${denial.reason}`.slice(0, 200)),
        };
      } finally {
        await prepared.close();
      }
    },

    async read(request) {
      const decision = decide(CAPTAIN_SHELL_READ_ACTION);
      await record(CAPTAIN_SHELL_READ_ACTION, decision, request.path);
      if (decision.effect !== "allow") {
        return { outcome: "refused", ...refusalFor(decision) };
      }
      try {
        const stats = await stat(request.path);
        if (stats.isDirectory()) {
          return { outcome: "refused", reason: "path_unreadable", detail: "that path is a directory" };
        }
        // A trailing newline is a line terminator, not an empty final line.
        // Reporting "5 lines" for a four-line file is the kind of small lie
        // that makes him ask for an offset that does not exist.
        const raw = await readFile(request.path, "utf8");
        const lines = (raw.endsWith("\n") ? raw.slice(0, -1) : raw).split("\n");
        const firstLine = request.offset ?? 1;
        const limit = request.limit ?? DEFAULT_READ_LINE_LIMIT;
        const selected = lines.slice(firstLine - 1, firstLine - 1 + limit);
        const joined = selected.join("\n");
        const content = joined.slice(0, MAX_READ_CHARACTERS);
        return {
          outcome: "ok",
          path: request.path,
          content,
          truncated: content.length < joined.length || firstLine - 1 + selected.length < lines.length,
          firstLine,
          totalLines: lines.length,
        };
      } catch (error) {
        return {
          outcome: "refused",
          reason: "path_unreadable",
          detail: (error instanceof Error ? error.message : "the path could not be read").slice(0, 500),
        };
      }
    },
  };
}

/** Lexical containment: enough to catch a nested default, not a symlink attack. */
function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

interface BoundedStream {
  text: string;
  truncated: boolean;
}

interface ExecutionOutcome {
  exitCode: number;
  stdout: BoundedStream;
  stderr: BoundedStream;
  timedOut: boolean;
  signal?: NodeJS.Signals;
}

/**
 * Output is bounded while it streams rather than after the fact: a command that
 * prints a gigabyte should cost a bounded buffer, not a gigabyte of runner
 * memory that gets thrown away at the end.
 */
function execute(
  spawnImpl: typeof spawn,
  prepared: PreparedSandbox,
  cwd: string,
  timeoutMs: number,
): Promise<ExecutionOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawnImpl(prepared.command, prepared.args, {
      cwd,
      env: prepared.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = { text: "", truncated: false };
    const stderr = { text: "", truncated: false };
    let timedOut = false;

    const collect = (target: BoundedStream) => (chunk: Buffer | string) => {
      if (target.truncated) return;
      const remaining = MAX_STREAM_CHARACTERS - target.text.length;
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (value.length >= remaining) {
        target.text += value.slice(0, remaining);
        target.truncated = true;
        return;
      }
      target.text += value;
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise({ exitCode: -1, stdout, stderr, timedOut });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        ...(signal ? { signal } : {}),
      });
    });
  });
}
