import {
  createCodingTools,
  createReadOnlyTools,
  createPowerShellTool,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SettingsStore } from "@clankie/settings";
import type { MachineAccessLevel } from "@clankie/protocol";
import type { JoinedWorkerHireRequest } from "../machine-joins.ts";
import type {
  JoinedMachineOperation,
  JoinedMachineResult,
  JoinedShellAuditEntry,
} from "@clankie/protocol/machine-join";
import { createHash, randomUUID } from "node:crypto";
import { requireMachineAccess } from "../machine-access.ts";

/** The join registry as the shell tool sees it; the receiver enforces its own ceiling. */
export interface JoinedShellMachines {
  has(id: string): boolean;
  accessCeiling(id: string): MachineAccessLevel | undefined;
  request(id: string, operation: JoinedMachineOperation, timeoutMs?: number): Promise<JoinedMachineResult>;
  recordShell(entry: JoinedShellAuditEntry): Promise<void>;
  /** Clankie's own Claude worker on a joined machine at the workers level (VUH-2607). */
  hireWorker?(request: JoinedWorkerHireRequest): Promise<Record<string, unknown>>;
  messageWorker?(input: {
    seat: string;
    conversationId: string;
    message: string;
  }): Promise<Record<string, unknown>>;
}

const JOINED_EFFORTS = new Set(["low", "medium", "high", "max"]);
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  details: value,
});

/**
 * Lets hire_agent and message_seat reach a joined machine (VUH-2607): `fleet` naming
 * a `join-` machine hires a Claude worker there, in a folder approved at join, while
 * the machine's live level allows workers. Owner-started turns only, like its shell.
 * Every other target keeps the original tool unchanged.
 */
export function joinedHireTools<T extends { name: string; description: string; execute: unknown }>(
  tools: readonly T[],
  joins: JoinedShellMachines,
  settings: SettingsStore,
  caller: { conversationId: string; turn: { readonly autonomous?: boolean | undefined } },
): T[] {
  if (joins.hireWorker === undefined || joins.messageWorker === undefined) return [...tools];
  const hireWorker = joins.hireWorker.bind(joins);
  const messageWorker = joins.messageWorker.bind(joins);
  const joinedSeat = (seat: unknown) =>
    typeof seat === "string" && seat.startsWith("join-") && joins.has(seat.slice(0, seat.indexOf("/")));
  return tools.map((tool) => {
    const original = tool.execute as (...args: unknown[]) => Promise<unknown>;
    if (tool.name === "hire_agent")
      return {
        ...tool,
        description:
          tool.description +
          " A machine that joined you with `clankie join` (id `join-…`) is a fleet too: name it as fleet to hire a Claude or Codex worker there, in a folder approved when it joined, while its level allows workers. It uses that machine's own Claude or Codex login; only turns the owner started may hire there. A Codex worker there reports with message_clankie but cannot be sent messages yet.",
        execute: async (id: unknown, params: Record<string, unknown>, ...rest: unknown[]) => {
          const fleet = params.fleet;
          if (typeof fleet !== "string" || !fleet.startsWith("join-")) return original(id, params, ...rest);
          if (!joins.has(fleet)) throw new Error(`No joined machine ${fleet}.`);
          if (caller.turn.autonomous === true)
            throw new Error(
              "A joined machine hire runs only in a turn the owner started; an autonomous turn cannot start one.",
            );
          // Live owner policy at the call; the receiver enforces its own ceiling again.
          await requireMachineAccess(settings, fleet, "workers", joins);
          if (params.harness !== undefined && params.harness !== "claude" && params.harness !== "codex")
            return result({
              outcome: "failed",
              reason: "harness_unavailable",
              detail: "A joined machine runs Claude or Codex workers.",
            });
          if (typeof params.brief !== "string" || params.brief.length === 0)
            return result({
              outcome: "failed",
              reason: "not_ready",
              detail: "A joined machine hire needs a brief.",
            });
          return result(
            await hireWorker({
              machineId: fleet,
              conversationId: caller.conversationId,
              title: String(params.title),
              brief: params.brief,
              workingDirectory: String(params.workingDirectory),
              ...(params.harness === "codex" ? { harness: "codex" as const } : {}),
              ...(typeof params.model === "string" ? { model: params.model } : {}),
              ...(typeof params.effort === "string" && JOINED_EFFORTS.has(params.effort)
                ? { effort: params.effort as "low" | "medium" | "high" | "max" }
                : {}),
            }),
          );
        },
      };
    if (tool.name === "message_seat")
      return {
        ...tool,
        execute: async (id: unknown, params: Record<string, unknown>, ...rest: unknown[]) => {
          if (!joinedSeat(params.seat)) return original(id, params, ...rest);
          if (typeof params.message !== "string")
            throw new Error("A worker on a joined machine takes a plain message.");
          return result(
            await messageWorker({
              seat: String(params.seat),
              conversationId: caller.conversationId,
              message: params.message,
            }),
          );
        },
      };
    return tool;
  });
}

/**
 * Remote execution on the owner's other machines is offered only in the owner
 * console lane with machine tools: never Discord (even owner-only rooms or DMs),
 * whose lanes carry an access plan, and never peer seats, which use MCP banks.
 */
export function offersJoinedMachineShell(input: {
  lane: string;
  systemTools: boolean;
  discordAccess: unknown;
}): boolean {
  return input.systemTools && input.lane === "operator" && input.discordAccess === undefined;
}

/**
 * Clankie's own shell on a joined machine: owner console lanes only. Every call
 * rechecks the live level and is durably audited before anything is sent.
 */
export function joinedMachineShellTool(
  joins: JoinedShellMachines,
  settings: SettingsStore,
  caller: {
    lane: string;
    conversationId: string;
    /** The session's live turn context; read at each call, never cached. */
    turn: { readonly autonomous?: boolean | undefined };
    /** How long the home waits for the receiver; production keeps the registry default. */
    requestTimeoutMs?: number;
  },
) {
  return defineTool({
    name: "joined_machine_shell",
    label: "Joined machine: shell",
    description:
      "Run one shell command on a machine that joined you with `clankie join` (transport `join` in the " +
      "machines list; its id starts with `join-`). Your other shell tools run on this machine, not there. " +
      "It needs that machine's level at shell or screen, runs as its owner in a folder approved when it " +
      "joined, uses /bin/sh on macOS and Linux or PowerShell on Windows (the machines list names the " +
      "platform), stops after 30 seconds, and returns up to 8192 characters of output with stderr and a " +
      "non-zero exit marked. A refusal names the machine, its level and what it needs; only the owner " +
      "can raise the level. Only turns the owner started may use it: autonomy, wakes and worker reports " +
      "are refused. Every call is recorded for the owner. A lost delivery is never re-run, so check " +
      "state before repeating an effect.",
    parameters: Type.Object({
      // Same form as the protocol's joined machine id, so a refusal is always auditable.
      machineId: Type.String({
        pattern: "^join-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
      }),
      directory: Type.String({ minLength: 1, maxLength: 4096 }),
      command: Type.String({ minLength: 1, maxLength: 8192 }),
    }),
    execute: async (_id, params) => {
      const entry: JoinedShellAuditEntry = {
        id: randomUUID(),
        requestedAt: new Date().toISOString(),
        lane: caller.lane,
        // Captured once, before any check, so the record says who asked.
        origin: caller.turn.autonomous === true ? "autonomous" : "owner",
        conversationId: caller.conversationId,
        machineId: params.machineId,
        directory: params.directory,
        commandSha256: createHash("sha256").update(params.command).digest("hex"),
        outcome: "dispatched",
      };
      const finish = (outcome: JoinedShellAuditEntry["outcome"], detail: Partial<JoinedShellAuditEntry>) =>
        joins.recordShell({ ...entry, ...detail, outcome, finishedAt: new Date().toISOString() });
      try {
        // Untrusted input (a wake, a Linear hook, a worker report) never reaches another machine.
        if (entry.origin === "autonomous")
          throw new Error(
            "joined_machine_shell runs only in a turn the owner started; an autonomous turn cannot use it.",
          );
        if (!joins.has(params.machineId)) throw new Error(`No joined machine ${params.machineId}.`);
        // Live owner policy on every call; nothing about an earlier grant is reused.
        await requireMachineAccess(settings, params.machineId, "shell", joins);
      } catch (error) {
        await finish("refused", { error: error instanceof Error ? error.message.slice(0, 256) : "refused" });
        throw error;
      }
      // An unrecorded command never leaves this machine.
      await joins.recordShell(entry);
      const { id: _request, ...result } = await joins
        .request(
          params.machineId,
          { kind: "shell", directory: params.directory, command: params.command },
          caller.requestTimeoutMs,
        )
        .catch(async (error: unknown) => {
          await finish("failed", { error: "dispatch_failed" });
          throw error;
        });
      // Current receivers begin with their own `[exit N]` or `[stopped …]` line; an
      // older receiver reports success only for exit 0 and has no such line.
      const header = result.ok
        ? /^\[(exit (\d+)|exit unknown|stopped [^\]\n]+)\]\n/u.exec(result.output ?? "")
        : null;
      const exitCode = header
        ? header[2] === undefined
          ? undefined
          : Number(header[2])
        : result.ok
          ? 0
          : undefined;
      const stoppedEarly = header !== null && header[2] === undefined;
      await finish(
        result.ok && !stoppedEarly ? "completed" : result.error === "unconfirmed" ? "unknown" : "failed",
        {
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(result.error
            ? { error: result.error }
            : stoppedEarly
              ? { error: header![1]!.slice(0, 256) }
              : {}),
        },
      );
      return {
        content: [
          {
            type: "text" as const,
            text: result.ok
              ? (result.output ?? "") + (result.truncated ? "\n[output truncated at 8192 characters]" : "")
              : JSON.stringify(result),
          },
        ],
        details: result,
      };
    },
  });
}

/** Override every native coding tool, including tools a session can activate later. */
export function machineCodingTools(
  cwd: string,
  settings: SettingsStore,
  options?: Parameters<typeof createCodingTools>[1],
) {
  const coding = createCodingTools(cwd, options);
  const tools = [
    ...coding,
    ...createReadOnlyTools(cwd, options).filter((tool) => tool.name !== "read"),
    createPowerShellTool(cwd),
  ];
  return tools.map((tool) => ({
    ...tool,
    // Let the SDK retain its configured/default active loadout.
    defaultActive: false,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      await requireMachineAccess(settings, "local", "shell");
      return tool.execute(...args);
    },
  }));
}
