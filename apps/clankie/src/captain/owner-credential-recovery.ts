import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { PiRunError, type CredentialRecovery } from "./captain-session.ts";

/** Reserved by the invocation owning the Pi prompt, never a steering caller. */
export interface OwnerCredentialTurn {
  readonly signal: AbortSignal;
  readonly recover: (
    providerId: string,
    detail: string,
    allowRefresh?: boolean,
  ) => Promise<CredentialRecovery["outcome"] | undefined>;
  readonly retrying: () => void;
  attempted?: boolean;
  failure?: PiRunError;
}
export interface OwnerCredentialRecovery {
  current?: OwnerCredentialTurn;
}

/** Pi repairs its canonical context and continues inside the original prompt. */
export function ownerCredentialRecoveryExtension(control: OwnerCredentialRecovery): ExtensionFactory {
  return (pi) => {
    pi.on("agent_before_settle", async (event, context) => {
      const turn = control.current;
      if (turn === undefined || turn.signal.aborted) return;
      const entry = event.context.contextEntries.findLast(
        (entry) => entry.sourceEntry.type === "message" && entry.messages.length > 0,
      )?.sourceEntry;
      if (
        entry?.type !== "message" ||
        entry.message.role !== "assistant" ||
        entry.message.stopReason !== "error"
      )
        return;
      const failure = new PiRunError(entry.message.errorMessage ?? "The model run failed without a reason.");
      const providerId = context.model?.provider;
      if (!failure.credentialRejected || providerId === undefined) return;
      // The continuation may reject too. Record that result without a second refresh.
      const allowRefresh = turn.attempted !== true;
      turn.attempted = true;
      const outcome = await turn.recover(providerId, failure.message, allowRefresh).catch(() => undefined);
      if (turn.signal.aborted || control.current !== turn) return;
      if (allowRefresh && outcome === "refreshed") {
        turn.retrying();
        return {
          entries: [{ type: "context_edit" as const, targetId: entry.id, replacement: null }],
          continue: true,
        };
      }
      if (outcome !== undefined) {
        turn.failure = new PiRunError(failure.message, {
          providerId,
          outcome: outcome === "refreshed" ? "reconnect_required" : outcome,
        });
      }
    });
  };
}
