/**
 * Relaunching a native lead seat in its own pane (VUH-2274, ADR 0271).
 *
 * A lead seat is the owner's `clankie claude` (or `clankie codex`) session in a
 * Herdr pane. Its context only grows: the global-default seat ran eight days
 * and 22 compactions before a manual /clear. Relaunching ends that session and
 * starts a fresh one from the same pane's shell, on the same conversation, so
 * the shared log and the handoff brief carry the work across. The old session
 * stays resumable. VUH-2273 uses the same function to move a usage-limited
 * seat to another account or harness and back.
 *
 * Every refusal is definite: nothing was ended and nothing was launched. Once
 * the old session has been signalled the outcome is either relaunched or an
 * uncertain receipt, which is reconciled by reading, never by trying again.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { HerdrForegroundProcess } from "./codex-seat.ts";
import { paneInputLine } from "./pane-draft.ts";

/**
 * How a seat was launched. Without `home`, `account` is the numbered launch
 * command (`clankie claude2`). With `home`, the plain harness command runs
 * with that account's config directory (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`),
 * and `account` is its worker-account label.
 */
export interface LeadSeatLaunch {
  readonly harness: "claude" | "codex";
  readonly account?: string | undefined;
  readonly home?: string | undefined;
}

type LeadSeatRelaunchReason = "fresh_restart" | "usage_limit" | "usage_limit_reset";

export interface RelaunchLeadSeatInput {
  readonly conversationId: string;
  readonly harness: LeadSeatLaunch["harness"];
  /** A launch command such as `claude2`, or a worker-account label when `home` is given. */
  readonly account?: string;
  /** That account's absolute config directory; the launch sets it as `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. */
  readonly home?: string;
  readonly reason: LeadSeatRelaunchReason;
  readonly guards: {
    /** Refuse while the pane holds text the owner typed and has not sent. */
    readonly requireNoDraft: boolean;
    /** Refuse while the owner wrote in this conversation within this many milliseconds. */
    readonly quietOwnerMs: number;
    /** Refuse while the seat is in a turn or the conversation has runs in flight. */
    readonly requireIdle: boolean;
  };
  /** Delivered as the new session's first message. Absent, it starts from the shared log alone. */
  readonly handoffBrief?: string;
}

type LeadSeatRelaunchRefusal =
  | "no_seat"
  | "not_shell_launch"
  | "busy"
  | "owner_active"
  | "draft"
  | "draft_unknown"
  | "invalid_target"
  | "in_progress"
  | "launch_failed";

export type RelaunchLeadSeatResult =
  | {
      readonly outcome: "relaunched";
      readonly receiptId: string;
      readonly seatId: string;
      readonly sessionId: string;
      readonly launch: LeadSeatLaunch;
    }
  | { readonly outcome: "refused"; readonly reason: LeadSeatRelaunchRefusal; readonly detail?: string }
  | { readonly outcome: "uncertain"; readonly receiptId: string; readonly detail: string };

/** The seat currently driving a conversation, as the host observes it. */
export interface LeadSeatPane {
  readonly paneId: string;
  readonly terminalId: string;
  readonly harness: string;
  readonly sessionId?: string;
}

export interface LeadSeatRelaunchDeps {
  readonly journalPath: string;
  /** The proven native seat attached to the conversation, if any. */
  readonly seat: (conversationId: string) => Promise<LeadSeatPane | undefined>;
  readonly paneShell: (
    paneId: string,
  ) => Promise<{ readonly shellPid?: number; readonly foreground: readonly HerdrForegroundProcess[] }>;
  readonly readPane: (paneId: string) => Promise<string>;
  readonly runInPane: (paneId: string, argv: readonly string[]) => Promise<void>;
  /** The seat is bound, not in a turn, and the conversation has nothing running. */
  readonly idle: (conversationId: string) => boolean;
  readonly lastOwnerMessageAt: (conversationId: string) => number | undefined;
  /** Hand one message to the conversation's newly bound seat; true once it took it. */
  readonly deliverBrief: (conversationId: string, text: string) => Promise<boolean>;
  readonly notice: (conversationId: string, text: string) => void;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long the old session gets to exit, and the new one to bind. */
  readonly exitTimeoutMs?: number;
  readonly bindTimeoutMs?: number;
}

const POLL_MS = 500;
const EXIT_TIMEOUT_MS = 30_000;
const BIND_TIMEOUT_MS = 120_000;
const LAUNCH_COMMAND = /^(claude|codex)(\d*)$/u;

const LaunchSchema = z
  .object({
    harness: z.enum(["claude", "codex"]),
    account: z.string().optional(),
    home: z.string().optional(),
  })
  .strict();
const ReceiptSchema = z
  .object({
    receiptId: z.string().uuid(),
    conversationId: z.string().min(1),
    paneId: z.string().min(1),
    reason: z.enum(["fresh_restart", "usage_limit", "usage_limit_reset"]),
    from: LaunchSchema,
    to: LaunchSchema,
    previousSessionId: z.string().optional(),
    startedAt: z.string().datetime(),
    stage: z.enum(["ending", "launching", "relaunched"]),
    sessionId: z.string().optional(),
    seatId: z.string().optional(),
  })
  .strict();
type Receipt = z.infer<typeof ReceiptSchema>;
const JournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    receipts: z.array(ReceiptSchema),
    /** The last launch each conversation's seat was observed or relaunched with. */
    launches: z.record(z.string(), LaunchSchema),
  })
  .strict();
type Journal = z.infer<typeof JournalSchema>;

/** `[node, /path/clankie, claude2, --resume, …]`: the launcher and its parsed command. */
function launcherOf(
  foreground: readonly HerdrForegroundProcess[],
): { readonly bin: string; readonly launch: LeadSeatLaunch } | undefined {
  for (const process of foreground) {
    const argv = process.argv ?? [];
    const at = argv.findIndex((word) => basename(word) === "clankie");
    const command = at < 0 ? undefined : LAUNCH_COMMAND.exec(argv[at + 1] ?? "");
    if (!command) continue;
    const harness = command[1] as LeadSeatLaunch["harness"];
    return {
      bin: argv[at]!,
      launch: command[2] === "" ? { harness } : { harness, account: argv[at + 1]! },
    };
  }
  return undefined;
}

/** The native harness process the launcher started, which owns the session. */
function harnessProcess(
  foreground: readonly HerdrForegroundProcess[],
  harness: LeadSeatLaunch["harness"],
): HerdrForegroundProcess | undefined {
  // A Node-installed harness runs as `node /path/codex`.
  return foreground.find(
    (process) =>
      process.name === harness ||
      [process.argv?.[0] ?? process.argv0, process.argv?.[1]].some(
        (word) => basename(word ?? "") === harness,
      ),
  );
}

/** The argv typed at the pane's shell, or undefined for a target it cannot express. */
function launchArgv(
  bin: string,
  target: LeadSeatLaunch,
  conversationId: string,
): readonly string[] | undefined {
  if (target.home !== undefined) {
    if (!isAbsolute(target.home)) return undefined;
    const variable = target.harness === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
    return ["env", `${variable}=${target.home}`, bin, target.harness, "--conversation", conversationId];
  }
  const command = target.account ?? target.harness;
  const parsed = LAUNCH_COMMAND.exec(command);
  return parsed && parsed[1] === target.harness
    ? [bin, command, "--conversation", conversationId]
    : undefined;
}

export function createLeadSeatRelaunch(deps: LeadSeatRelaunchDeps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const signal = deps.signal ?? ((pid: number, name: NodeJS.Signals) => process.kill(pid, name));
  const running = new Set<string>();

  function read(): Journal {
    try {
      return JournalSchema.parse(JSON.parse(readFileSync(deps.journalPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1, receipts: [], launches: {} };
      throw error;
    }
  }
  function write(journal: Journal): void {
    mkdirSync(dirname(deps.journalPath), { recursive: true, mode: 0o700 });
    const temporary = `${deps.journalPath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    renameSync(temporary, deps.journalPath);
  }
  function drop(receiptId: string): void {
    const journal = read();
    write({ ...journal, receipts: journal.receipts.filter((entry) => entry.receiptId !== receiptId) });
  }
  function save(receipt: Receipt): void {
    const journal = read();
    const receipts = journal.receipts.filter((entry) => entry.receiptId !== receipt.receiptId);
    // Settled receipts are history; keep the last few for reconciliation reads.
    write({
      ...journal,
      receipts: [...receipts, receipt].slice(-32),
      ...(receipt.stage === "relaunched"
        ? { launches: { ...journal.launches, [receipt.conversationId]: receipt.to } }
        : {}),
    });
  }

  /**
   * How the conversation's seat was launched. The last relaunch is the answer
   * while its session still runs (it alone knows a config directory); otherwise
   * the pane's own launcher, else that relaunch for a seat that is gone.
   */
  async function leadSeatLaunch(conversationId: string): Promise<LeadSeatLaunch | undefined> {
    const seat = await deps.seat(conversationId).catch(() => undefined);
    const journal = read();
    const last = journal.receipts.findLast(
      (entry) => entry.conversationId === conversationId && entry.stage === "relaunched",
    );
    if (seat?.sessionId !== undefined && last?.sessionId === seat.sessionId) return last.to;
    const observed =
      seat === undefined
        ? undefined
        : launcherOf((await deps.paneShell(seat.paneId).catch(() => undefined))?.foreground ?? []);
    return observed?.launch ?? journal.launches[conversationId];
  }

  async function refuseFor(
    input: RelaunchLeadSeatInput,
    seat: LeadSeatPane,
  ): Promise<RelaunchLeadSeatResult | undefined> {
    if (input.guards.requireIdle && !deps.idle(input.conversationId))
      return { outcome: "refused", reason: "busy" };
    const owner = deps.lastOwnerMessageAt(input.conversationId);
    if (input.guards.quietOwnerMs > 0 && owner !== undefined && now() - owner < input.guards.quietOwnerMs)
      return { outcome: "refused", reason: "owner_active" };
    if (input.guards.requireNoDraft) {
      const ansi = await deps.readPane(seat.paneId).catch(() => undefined);
      const line = ansi === undefined ? { state: "unknown" as const } : paneInputLine(seat.harness, ansi);
      if (line.state === "draft") return { outcome: "refused", reason: "draft" };
      if (line.state === "unknown") return { outcome: "refused", reason: "draft_unknown" };
    }
    return undefined;
  }

  async function relaunch(input: RelaunchLeadSeatInput, receiptId: string): Promise<RelaunchLeadSeatResult> {
    const seat = await deps.seat(input.conversationId);
    if (seat === undefined) return { outcome: "refused", reason: "no_seat" };
    const shell = await deps.paneShell(seat.paneId).catch(() => undefined);
    const launcher = shell === undefined ? undefined : launcherOf(shell.foreground);
    const native =
      launcher === undefined ? undefined : harnessProcess(shell!.foreground, launcher.launch.harness);
    if (shell?.shellPid === undefined || launcher === undefined || native === undefined)
      return { outcome: "refused", reason: "not_shell_launch" };
    const target: LeadSeatLaunch = {
      harness: input.harness,
      ...(input.account === undefined ? {} : { account: input.account }),
      ...(input.home === undefined ? {} : { home: input.home }),
    };
    const argv = launchArgv(launcher.bin, target, input.conversationId);
    if (argv === undefined) return { outcome: "refused", reason: "invalid_target" };
    const refused = await refuseFor(input, seat);
    if (refused) return refused;

    // The durable boundary: from here an interrupted relaunch is uncertain, never retried.
    const receipt: Receipt = {
      receiptId,
      conversationId: input.conversationId,
      paneId: seat.paneId,
      reason: input.reason,
      from: launcher.launch,
      to: target,
      ...(seat.sessionId === undefined ? {} : { previousSessionId: seat.sessionId }),
      startedAt: new Date(now()).toISOString(),
      stage: "ending",
    };
    save(receipt);
    // The guards are read again just before the one irreversible step.
    const late = await refuseFor(input, seat);
    if (late) {
      drop(receiptId);
      return late;
    }
    try {
      signal(native.pid, "SIGTERM");
    } catch (error) {
      // The signal was refused by the OS, so nothing was ended.
      drop(receiptId);
      return {
        outcome: "refused",
        reason: "launch_failed",
        detail: `The session could not be ended: ${String(error)}`,
      };
    }
    const exitBy = now() + (deps.exitTimeoutMs ?? EXIT_TIMEOUT_MS);
    for (;;) {
      const current = await deps.paneShell(seat.paneId).catch(() => undefined);
      if (current !== undefined && launcherOf(current.foreground) === undefined) break;
      if (now() >= exitBy)
        return {
          outcome: "uncertain",
          receiptId,
          detail: "The old session did not exit; nothing was launched.",
        };
      await sleep(POLL_MS);
    }
    save({ ...receipt, stage: "launching" });
    try {
      await deps.runInPane(seat.paneId, argv);
    } catch (error) {
      return {
        outcome: "uncertain",
        receiptId,
        detail: `The old session ended, but the new launch did not confirm: ${String(error)}`,
      };
    }
    const bindBy = now() + (deps.bindTimeoutMs ?? BIND_TIMEOUT_MS);
    for (;;) {
      const next = await deps.seat(input.conversationId).catch(() => undefined);
      if (
        next?.sessionId !== undefined &&
        next.sessionId !== seat.sessionId &&
        deps.idle(input.conversationId)
      ) {
        save({ ...receipt, stage: "relaunched", sessionId: next.sessionId, seatId: next.terminalId });
        const brief = input.handoffBrief?.trim();
        const briefed = brief
          ? await deps.deliverBrief(input.conversationId, brief).catch(() => false)
          : false;
        deps.notice(
          input.conversationId,
          `Clankie's seat restarted fresh in its pane (${input.reason.replaceAll("_", " ")}): session ${seat.sessionId ?? "unknown"} → ${next.sessionId} on ${target.harness}${target.account === undefined ? "" : ` (${target.account})`}. The previous session stays resumable.${
            brief
              ? briefed
                ? " The handoff brief was its first message."
                : " The handoff brief did not reach it; it starts from the shared log."
              : ""
          }`,
        );
        return {
          outcome: "relaunched",
          receiptId,
          seatId: next.terminalId,
          sessionId: next.sessionId,
          launch: target,
        };
      }
      if (now() >= bindBy)
        return {
          outcome: "uncertain",
          receiptId,
          detail: "The new session was launched but has not bound to the conversation yet.",
        };
      await sleep(POLL_MS);
    }
  }

  return {
    leadSeatLaunch,
    /** The relaunch's own checks, with no effect: undefined when it would go ahead now. */
    async preflight(input: RelaunchLeadSeatInput): Promise<RelaunchLeadSeatResult | undefined> {
      const seat = await deps.seat(input.conversationId);
      if (seat === undefined) return { outcome: "refused", reason: "no_seat" };
      return refuseFor(input, seat);
    },
    async relaunchLeadSeat(input: RelaunchLeadSeatInput): Promise<RelaunchLeadSeatResult> {
      if (running.has(input.conversationId)) return { outcome: "refused", reason: "in_progress" };
      running.add(input.conversationId);
      try {
        return await relaunch(input, randomUUID());
      } finally {
        running.delete(input.conversationId);
      }
    },
    /** Read-only: what became of a relaunch, never another attempt. */
    async reconcileLeadSeatRelaunch(receiptId: string): Promise<RelaunchLeadSeatResult> {
      const receipt = read().receipts.find((entry) => entry.receiptId === receiptId);
      if (receipt === undefined)
        return { outcome: "uncertain", receiptId, detail: "No relaunch receipt has that ID." };
      if (receipt.stage === "relaunched" && receipt.sessionId && receipt.seatId)
        return {
          outcome: "relaunched",
          receiptId,
          seatId: receipt.seatId,
          sessionId: receipt.sessionId,
          launch: receipt.to,
        };
      const seat = await deps.seat(receipt.conversationId).catch(() => undefined);
      if (
        seat?.sessionId !== undefined &&
        seat.sessionId !== receipt.previousSessionId &&
        seat.paneId === receipt.paneId
      ) {
        save({ ...receipt, stage: "relaunched", sessionId: seat.sessionId, seatId: seat.terminalId });
        return {
          outcome: "relaunched",
          receiptId,
          seatId: seat.terminalId,
          sessionId: seat.sessionId,
          launch: receipt.to,
        };
      }
      return {
        outcome: "uncertain",
        receiptId,
        detail:
          receipt.stage === "ending"
            ? "The old session was signalled; no new launch is recorded."
            : "A new session was launched in the pane but has not bound to the conversation.",
      };
    },
  };
}

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;

/**
 * A Claude session's age and current context, from its own transcript: the
 * first record's time, and the input, cache-read and cache-write tokens of the
 * latest main-thread model call. Claude records no context window, so callers
 * compare tokens with their own budget. Unknown stays undefined.
 */
export async function readClaudeSessionUsage(
  path: string,
): Promise<{ readonly startedAt?: number; readonly contextTokens?: number }> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const chunk = async (start: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      return buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    };
    const records = (lines: readonly string[]) =>
      lines.flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
        } catch {
          return [];
        }
      });
    let startedAt: number | undefined;
    for (const record of records(await chunk(0, Math.min(size, HEAD_BYTES)))) {
      const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
      if (Number.isFinite(at)) {
        startedAt = at;
        break;
      }
    }
    const tail = records((await chunk(Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES))).slice(1));
    let contextTokens: number | undefined;
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const record = tail[index]!;
      // A compaction since the last call replaced that context; its size is unknown until the next.
      if (record.type === "system" && record.subtype === "compact_boundary") break;
      if (record.type !== "assistant" || record.isSidechain === true) continue;
      const usage = (record.message as { usage?: Record<string, unknown> } | undefined)?.usage;
      if (usage === undefined) continue;
      const count = (key: string) => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
      contextTokens =
        count("input_tokens") + count("cache_read_input_tokens") + count("cache_creation_input_tokens");
      break;
    }
    return {
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(contextTokens === undefined ? {} : { contextTokens }),
    };
  } finally {
    await handle.close();
  }
}
