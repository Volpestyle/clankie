import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { MachineWorkerAccounts, WorkerAccountStatus } from "./harness-accounts.ts";
import type { LeadSeatLaunch, RelaunchLeadSeatInput, RelaunchLeadSeatResult } from "./lead-seat-relaunch.ts";
import type { SeatUsageLimit } from "./seat-outbox.ts";

/**
 * A usage-limited lead seat moves to the account or harness with the most
 * headroom, in its own pane, and back once the limit resets (VUH-2273). It
 * uses the same-pane launcher as fresh restarts (ADR 0271). The move is a hard
 * limit, so only an unsent draft can refuse it; moving back waits like a
 * fresh restart for a quiet owner and an idle seat. With no account to move
 * to, or a refused move, the service lane keeps running the conversation.
 */
const LaunchSchema = z
  .object({
    harness: z.enum(["claude", "codex"]),
    account: z.string().optional(),
    home: z.string().optional(),
  })
  .strict();
const StateSchema = z.record(
  z.string(),
  z
    .object({
      original: LaunchSchema,
      current: LaunchSchema,
      window: z.enum(["session", "weekly", "other"]),
      until: z.number(),
      movedAt: z.number(),
      /** An unconfirmed move or return: never retried, reported once. */
      uncertain: z.string().optional(),
    })
    .strict(),
);
type State = z.infer<typeof StateSchema>;

/** Moving back waits for the owner to be quiet this long, as a fresh restart does. */
const FAILBACK_QUIET_OWNER_MS = 15 * 60_000;

export interface LeadSeatFailoverDeps {
  readonly statePath: string;
  /** The same-pane launcher fresh restarts use (ADR 0271). */
  readonly launcher: {
    relaunchLeadSeat(input: RelaunchLeadSeatInput): Promise<RelaunchLeadSeatResult>;
    leadSeatLaunch(conversationId: string): Promise<LeadSeatLaunch | undefined>;
  };
  /** This machine's Claude and Codex accounts with their headroom. */
  readonly accounts: () => Promise<MachineWorkerAccounts>;
  /** The newly launched seat is not the limited one; let input reach it again. */
  readonly released: (conversationId: string) => void;
  readonly notice: (conversationId: string, text: string) => void;
  readonly now?: () => number;
}

function describe(launch: LeadSeatLaunch): string {
  return launch.account === undefined ? launch.harness : `${launch.harness} (${launch.account})`;
}

/**
 * The account to move to: another signed-in Claude account first, then
 * Codex, by headroom (unknown counts as half). Never the limited account,
 * and never one already known to be out of usage or held.
 */
function chooseFailoverAccount(
  report: MachineWorkerAccounts,
  original: LeadSeatLaunch,
): WorkerAccountStatus | undefined {
  const isOriginal = (account: WorkerAccountStatus) =>
    account.harness === original.harness &&
    (original.home !== undefined
      ? account.home === original.home
      : original.account !== undefined
        ? account.label === original.account || account.aliases?.includes(original.account) === true
        : account.nativeDefault === true);
  const candidates = report.accounts.filter(
    (account) =>
      (account.harness === "claude" || account.harness === "codex") &&
      account.signedIn === true &&
      account.headroom !== 0 &&
      account.held === undefined &&
      !isOriginal(account),
  );
  const rank = (account: WorkerAccountStatus) =>
    (account.harness === "claude" ? 2 : 0) + (account.headroom ?? 0.5);
  return candidates.sort((left, right) => rank(right) - rank(left))[0];
}

export function createLeadSeatFailover(deps: LeadSeatFailoverDeps) {
  const now = deps.now ?? Date.now;
  const running = new Set<string>();
  const read = (): State => {
    try {
      return StateSchema.parse(JSON.parse(readFileSync(deps.statePath, "utf8")));
    } catch {
      return {};
    }
  };
  const save = (state: State) => {
    mkdirSync(dirname(deps.statePath), { recursive: true });
    writeFileSync(`${deps.statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    renameSync(`${deps.statePath}.tmp`, deps.statePath);
  };
  const relaunch = async (
    input: RelaunchLeadSeatInput,
  ): Promise<RelaunchLeadSeatResult | { outcome: "failed"; detail: string }> => {
    try {
      return await deps.launcher.relaunchLeadSeat(input);
    } catch (error) {
      return { outcome: "failed", detail: String(error) };
    }
  };
  const resets = (until: number) => new Date(until).toISOString();

  /** The conversation's native seat just refused turns on a usage limit. */
  async function limited(conversationId: string, limit: SeatUsageLimit): Promise<void> {
    if (running.has(conversationId)) return;
    running.add(conversationId);
    try {
      const state = read();
      const moved = state[conversationId];
      if (moved?.uncertain !== undefined) return;
      // A seat we already moved hit a limit too: move again, but return to the first.
      const original = moved?.original ?? (await deps.launcher.leadSeatLaunch(conversationId));
      const current = moved?.current ?? original;
      if (original === undefined || current === undefined) {
        deps.notice(
          conversationId,
          `Clankie couldn't tell which account your native seat runs on, so it was not moved; Clankie's service lane runs this conversation until the limit resets (${resets(limit.until)}).`,
        );
        return;
      }
      const target = chooseFailoverAccount(await deps.accounts(), current);
      if (target === undefined) {
        deps.notice(
          conversationId,
          `No other Claude or Codex account here has room, so your native seat stays where it is; Clankie's service lane runs this conversation until the limit resets (${resets(limit.until)}).`,
        );
        return;
      }
      const to: LeadSeatLaunch = {
        harness: target.harness as LeadSeatLaunch["harness"],
        account: target.label,
        home: target.home,
      };
      const result = await relaunch({
        conversationId,
        harness: to.harness,
        account: target.label,
        home: target.home,
        reason: "usage_limit",
        // A limited seat cannot work at all: only an unsent draft holds the move.
        guards: { requireNoDraft: true, quietOwnerMs: 0, requireIdle: false },
      });
      if (result.outcome === "relaunched") {
        save({
          ...read(),
          [conversationId]: {
            original,
            current: to,
            window: limit.window,
            until: limit.until,
            movedAt: now(),
          },
        });
        deps.released(conversationId);
        deps.notice(
          conversationId,
          `Your native seat hit its ${limit.window === "other" ? "usage" : limit.window} limit on ${describe(current)}, so Clankie moved it to ${describe(to)} in the same pane. It moves back to ${describe(original)} after the limit resets (${resets(limit.until)}).`,
        );
        return;
      }
      if (result.outcome === "uncertain") {
        save({
          ...read(),
          [conversationId]: {
            original,
            current: to,
            window: limit.window,
            until: limit.until,
            movedAt: now(),
            uncertain: result.receiptId,
          },
        });
        deps.notice(
          conversationId,
          `Clankie's move of your native seat to ${describe(to)} is unconfirmed (receipt ${result.receiptId}): ${result.detail} It is never retried automatically; check the pane.`,
        );
        return;
      }
      deps.notice(
        conversationId,
        `Clankie couldn't move your native seat to ${describe(to)} (${result.outcome === "refused" ? result.reason : result.detail}); Clankie's service lane runs this conversation until the limit resets (${resets(limit.until)}).`,
      );
    } finally {
      running.delete(conversationId);
    }
  }

  /** Periodic: move each moved seat back once its original limit has reset. */
  async function failBack(): Promise<void> {
    for (const [conversationId, moved] of Object.entries(read())) {
      if (moved.uncertain !== undefined || now() < moved.until || running.has(conversationId)) continue;
      running.add(conversationId);
      try {
        const result = await relaunch({
          conversationId,
          harness: moved.original.harness,
          ...(moved.original.account === undefined ? {} : { account: moved.original.account }),
          ...(moved.original.home === undefined ? {} : { home: moved.original.home }),
          reason: "usage_limit_reset",
          guards: { requireNoDraft: true, quietOwnerMs: FAILBACK_QUIET_OWNER_MS, requireIdle: true },
        });
        const state = read();
        if (result.outcome === "relaunched") {
          delete state[conversationId];
          save(state);
          deps.notice(
            conversationId,
            `The ${moved.window === "other" ? "usage" : moved.window} limit reset, so Clankie moved your native seat back from ${describe(moved.current)} to ${describe(moved.original)}.`,
          );
        } else if (result.outcome === "uncertain") {
          state[conversationId] = { ...moved, uncertain: result.receiptId };
          save(state);
          deps.notice(
            conversationId,
            `Clankie's move of your native seat back to ${describe(moved.original)} is unconfirmed (receipt ${result.receiptId}): ${result.detail} It is never retried automatically; check the pane.`,
          );
        }
        // A refused return (busy, owner active, a draft) tries again on the next check.
      } finally {
        running.delete(conversationId);
      }
    }
  }

  /** What the conversation runs on now, for status. */
  function status(conversationId: string) {
    const moved = read()[conversationId];
    return moved === undefined
      ? undefined
      : {
          from: describe(moved.original),
          to: describe(moved.current),
          window: moved.window,
          until: resets(moved.until),
          ...(moved.uncertain === undefined ? {} : { uncertain: moved.uncertain }),
        };
  }

  return { limited, failBack, status };
}
