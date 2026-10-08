import { setTimeout } from "node:timers/promises";
import { createGameExtensionRuntime, type GameExtension } from "@clankie/game-extension";
import { RivalsStatusSchema, type RivalsCommand, type RivalsStatus } from "@clankie/protocol";
import { GameplaySettingsSchema, type GameplaySettings } from "@clankie/settings";

export type RivalsStart = Extract<RivalsCommand, { action: "start" }> & { sessionId: string };
export type RivalsReceipt = {
  id: string;
  requestId: string;
  startedAt: number;
  execution: RivalsStatus["execution"];
};

/** Native Session._run writes endedAt only after pad/capture cleanup. Failed cleanup is not proof. */
export function rivalsStopped(status: RivalsStatus, receipt: RivalsReceipt): boolean {
  const session = status.session;
  return (
    status.execution === receipt.execution &&
    session?.id === receipt.id &&
    session.requestId === receipt.requestId &&
    session.startedAt === receipt.startedAt &&
    session.phase === "stopped" &&
    session.error === null &&
    session.endedAt !== undefined &&
    Number.isFinite(session.endedAt) &&
    session.endedAt >= session.startedAt
  );
}

export interface RivalsExtensionHost {
  /** Broker-private, origin-pinned HTTP port. No raw pad inputs or model calls. */
  call(command: RivalsCommand, guard: () => Promise<void>): Promise<Record<string, unknown>>;
  /** Core durably records the original native receipt before admitting running. */
  remember(receipt: RivalsReceipt): void;
  admitted(result: Record<string, unknown>): void;
}

export const rivalsExtension: GameExtension<RivalsStart, void, GameplaySettings, RivalsExtensionHost> = {
  contractVersion: 1,
  id: "rivals",
  connector: { kind: "skill", sessionServer: "rivals-agent" },
  skill: { name: "rivals", path: ".agents/skills/rivals/SKILL.md" },
  settings: { key: "gameplay", schema: GameplaySettingsSchema },
  activity: null,
  create(host) {
    return createGameExtensionRuntime(async (request, control, onRunning) => {
      const { sessionId: _local, ...command } = request;
      let result = await host.call(command, control.guard);
      let status = RivalsStatusSchema.safeParse(result);
      if (!status.success || status.data.session?.requestId !== request.requestId) {
        host.admitted({ outcome: "refused", reason: "rivals_start_unconfirmed" });
        return;
      }
      const receipt: RivalsReceipt = {
        id: status.data.session.id,
        requestId: status.data.session.requestId,
        startedAt: status.data.session.startedAt,
        execution: status.data.execution,
      };
      host.remember(receipt);
      host.admitted(result);
      let running = false;
      let stopSent = false;
      while (true) {
        if (rivalsStopped(status.data, receipt)) {
          control.confirmStopped();
          return;
        }
        if (
          status.data.execution !== receipt.execution ||
          status.data.session?.id !== receipt.id ||
          status.data.session.requestId !== receipt.requestId ||
          status.data.session.startedAt !== receipt.startedAt ||
          status.data.session.phase === "failed"
        )
          return;
        if (!running && status.data.session.phase === "running") {
          await onRunning();
          running = true;
        }
        if (control.stopRequested() && !stopSent) {
          // Only the original controller receives a stop; a denial cannot prove cleanup.
          result = await host.call({ action: "stop", sessionId: receipt.id }, control.guard);
          if (result.outcome !== "ok") return;
          stopSent = true;
        } else {
          await setTimeout(250);
          result = await host.call({ action: "status" }, control.guard);
        }
        status = RivalsStatusSchema.safeParse(result);
        if (!status.success) return;
      }
    });
  },
};
