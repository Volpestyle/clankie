export const PI_WORKER_MESSAGE: "clankie-worker-message";
export interface PiWorkerRuntime {
  initialize(input: unknown): Promise<unknown>;
  status(): Promise<"idle" | "working" | "blocked">;
  send(input: unknown): Promise<{
    outcome: "accepted" | "unconfirmed" | "unavailable";
    messageId?: string;
    detail?: string;
    state?: "started";
  }>;
  settlement(input: unknown): Promise<unknown>;
  interrupt(input?: unknown): Promise<boolean>;
  close(): void;
}
/** Structural native extension seam; no captain Pi types or runtime imported. */
export function createPiWorkerRuntime(pi: unknown, controller: unknown): PiWorkerRuntime;
