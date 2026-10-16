import {
  createCodingTools,
  createReadOnlyTools,
  createPowerShellTool,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { SettingsStore } from "@clankie/settings";
import type { MachineAccessLevel } from "@clankie/protocol";
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
