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
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import { LeadRestartStatusSchema, type LeadRestartStatus, type LeadRestartWait } from "@clankie/protocol";
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
  | "trust_required"
  | "invalid_target"
  | "in_progress"
  | "launch_failed"
  | "watching";

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
  /** The launcher's resolved conversation directory, not the harness's possibly changed cwd. */
  readonly workingDirectory?: string;
  /** The session's native delivery binding: a delivery pinned to it reaches no other session. */
  readonly binding?: string;
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
  /**
   * Hand one message to the conversation's newly bound seat, pinned to its
   * native binding; true once that exact session took it.
   */
  readonly deliverBrief: (conversationId: string, text: string, binding: string) => Promise<boolean>;
  readonly notice: (conversationId: string, text: string) => void;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Watch (ADR 0308): while Clankie only watches, no lead session is ended or launched. */
  readonly watching?: () => Promise<boolean>;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long the old session gets to exit, and the new one to bind. */
  readonly exitTimeoutMs?: number;
  readonly bindTimeoutMs?: number;
  /** A due fresh restart refused this long tells the owner once (VUH-2821). */
  readonly restartNoticeAfterMs?: number;
}

const POLL_MS = 500;
const EXIT_TIMEOUT_MS = 30_000;
const BIND_TIMEOUT_MS = 120_000;
const RESTART_NOTICE_AFTER_MS = 2 * 60 * 60_000;
/** What each refusal of a due restart means, in the owner's notice. */
const RESTART_REFUSALS: Readonly<Record<string, string>> = {
  busy: "the seat was in a turn",
  owner_active: "you had written in the last 15 minutes",
  draft: "the pane held an unsent draft",
  draft_unknown: "the pane's input line could not be read",
  source_unproven: "the lead's native source could not be proven",
  usage_unreadable: "the lead's transcript usage could not be read uniquely",
  trust_required: "Claude's workspace trust needs an owner action",
  no_seat: "no native seat was bound",
  no_launch: "the pane's `clankie` launcher could not be found",
  no_brief: "the seat did not answer the handoff request",
  not_shell_launch: "the seat was not started by `clankie` from the pane's shell",
  invalid_target: "the launch could not be expressed in the pane",
  in_progress: "another relaunch was running",
  launch_failed: "the old session could not be signalled",
  watching: "Clankie was only watching",
};
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
  // Refused waits live beside the journal, so an older runtime's strict journal read never meets them.
  const waitsPath = `${deps.journalPath}.restart-waits.json`;
  /** A stored wait also keeps a notice it began sending, so a retry sends those exact words. */
  const StoredWaitSchema = LeadRestartStatusSchema.shape.waiting
    .unwrap()
    .extend({ pendingNotice: z.string().min(1).optional() });
  type StoredWait = z.infer<typeof StoredWaitSchema>;
  function readWaits(): Record<string, StoredWait> {
    try {
      return z.record(z.string(), StoredWaitSchema).parse(JSON.parse(readFileSync(waitsPath, "utf8")));
    } catch {
      // Observation only: a missing or unreadable record starts a new wait rather than stopping restarts.
      return {};
    }
  }
  function writeWaits(waits: Record<string, StoredWait>): void {
    mkdirSync(dirname(waitsPath), { recursive: true, mode: 0o700 });
    const temporary = `${waitsPath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(waits)}\n`, { mode: 0o600 });
    renameSync(temporary, waitsPath);
  }
  /**
   * A due fresh restart was refused (VUH-2821): extend its wait and, once the
   * wait is old enough, tell the owner once which refusal holds it. The notice's
   * words are stored before it is sent, so a save that fails after sending is
   * retried with the same words, which the conversation records only once; a
   * notice that was never stored was never sent, and the next refusal sends it.
   */
  function restartRefused(conversationId: string, reason: string, detail?: string): void {
    const waits = readWaits();
    const at = new Date(now()).toISOString();
    const previous = waits[conversationId];
    const wait: StoredWait = {
      since: previous?.since ?? at,
      lastAt: at,
      lastReason: reason,
      ...(detail === undefined ? {} : { lastDetail: detail.slice(0, 512) }),
      counts: { ...previous?.counts, [reason]: (previous?.counts[reason] ?? 0) + 1 },
      ...(previous?.noticedAt === undefined ? {} : { noticedAt: previous.noticedAt }),
      ...(previous?.pendingNotice === undefined ? {} : { pendingNotice: previous.pendingNotice }),
    };
    const waited = now() - Date.parse(wait.since);
    if (
      wait.noticedAt === undefined &&
      wait.pendingNotice === undefined &&
      waited >= (deps.restartNoticeAfterMs ?? RESTART_NOTICE_AFTER_MS)
    ) {
      const counts = Object.entries(wait.counts)
        .sort(([, a], [, b]) => b - a)
        .map(([name, count]) => `${name} ×${String(count)}`)
        .join(", ");
      wait.pendingNotice = `Clankie's fresh restart check (ADR 0271) has been refused since ${wait.since}, ${String(Math.floor(waited / 60_000))} minutes. The latest: ${reason} (${RESTART_REFUSALS[reason] ?? "see the relaunch receipt"}).${wait.lastDetail === undefined ? "" : ` ${wait.lastDetail}`} All refusals: ${counts}. \`clankie fleet status\` shows the wait; \`clankie fleet set --lead-restarts off\` stops it.`;
    }
    writeWaits({ ...waits, [conversationId]: wait });
    if (wait.pendingNotice === undefined) return;
    deps.notice(conversationId, wait.pendingNotice);
    const { pendingNotice: _sent, ...noticed } = wait;
    writeWaits({ ...waits, [conversationId]: { ...noticed, noticedAt: at } });
  }
  /** The seat relaunched, or is no longer due: its wait ends. */
  function restartSettled(conversationId: string): void {
    const waits = readWaits();
    if (waits[conversationId] === undefined) return;
    const { [conversationId]: _ended, ...rest } = waits;
    writeWaits(rest);
  }
  // Handoff briefs also live beside the journal (VUH-2860), so a new session that
  // binds after its relaunch stopped waiting still receives its brief.
  const handoffsPath = `${deps.journalPath}.handoffs.json`;
  /**
   * `pending` keeps a relaunch's brief, if it had one, until one delivery is
   * claimed as `attempting`. An attempt a later read finds unfinished stays
   * uncertain and is never resent. `unavailable` marks a receipt written before
   * briefs were kept: its brief is gone, and nothing claims it was delivered.
   */
  const HandoffSchema = z.union([
    z.object({ state: z.literal("pending"), brief: z.string().min(1).optional() }).strict(),
    z.object({ state: z.enum(["attempting", "delivered", "undelivered", "none", "unavailable"]) }).strict(),
  ]);
  type Handoff = z.infer<typeof HandoffSchema>;
  function readHandoffs(): Record<string, Handoff> {
    try {
      return z.record(z.string(), HandoffSchema).parse(JSON.parse(readFileSync(handoffsPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  function keepHandoff(receiptId: string, handoff: Handoff | undefined): void {
    const { [receiptId]: _previous, ...rest } = readHandoffs();
    // Like the journal's receipts, only the latest few are kept.
    const handoffs = Object.fromEntries(
      Object.entries(handoff === undefined ? rest : { ...rest, [receiptId]: handoff }).slice(-32),
    );
    mkdirSync(dirname(handoffsPath), { recursive: true, mode: 0o700 });
    const temporary = `${handoffsPath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(handoffs)}\n`, { mode: 0o600 });
    renameSync(temporary, handoffsPath);
  }
  function restartNotice(
    receipt: Receipt,
    sessionId: string,
    brief: "delivered" | "undelivered" | "unavailable" | undefined,
  ): string {
    const { to } = receipt;
    return `Clankie's seat restarted fresh in its pane (${receipt.reason.replaceAll("_", " ")}): session ${receipt.previousSessionId ?? "unknown"} → ${sessionId} on ${to.harness}${to.account === undefined ? "" : ` (${to.account})`}. The previous session stays resumable.${
      brief === "delivered"
        ? " The handoff brief was delivered to it."
        : brief === "undelivered"
          ? " The handoff brief did not reach it; it starts from the shared log."
          : brief === "unavailable"
            ? " Its handoff brief was not kept by the service that started this relaunch, so none was delivered; it starts from the shared log."
            : ""
    }`;
  }
  /**
   * Hand a settled relaunch's kept brief to the session its receipt names, once,
   * and tell the conversation. The claim is written before delivery, so the
   * waiting relaunch and the new session's poll never both send it, and a
   * delivery that does not confirm is never resent. The delivery is pinned to
   * that session's binding: a later session in the pane can neither take nor
   * acknowledge it, and it settles undelivered instead.
   */
  async function handOffReceipt(receiptId: string, seat: LeadSeatPane): Promise<void> {
    const { sessionId, binding } = seat;
    const receipt = read().receipts.find((entry) => entry.receiptId === receiptId);
    if (
      receipt?.stage !== "relaunched" ||
      sessionId === undefined ||
      binding === undefined ||
      receipt.sessionId !== sessionId ||
      receipt.seatId !== seat.terminalId
    )
      return;
    const handoff = readHandoffs()[receiptId];
    if (handoff?.state !== "pending") return;
    const brief = handoff.brief;
    keepHandoff(receiptId, { state: brief === undefined ? "none" : "attempting" });
    let outcome: "delivered" | "undelivered" | undefined;
    if (brief !== undefined) {
      outcome = (await deps.deliverBrief(receipt.conversationId, brief, binding).catch(() => false))
        ? "delivered"
        : "undelivered";
      keepHandoff(receiptId, { state: outcome });
    }
    deps.notice(receipt.conversationId, restartNotice(receipt, sessionId, outcome));
  }
  function drop(receiptId: string): void {
    const journal = read();
    write({ ...journal, receipts: journal.receipts.filter((entry) => entry.receiptId !== receiptId) });
    keepHandoff(receiptId, undefined);
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
    // Read again just before the session is ended, so Watch chosen meanwhile stops it.
    if ((await deps.watching?.()) === true)
      return {
        outcome: "refused",
        reason: "watching",
        detail: "Clankie is only watching. The current session was left running.",
      };
    if (input.harness === "claude") {
      // Claude Code 2.1.310 deliberately accepts home-directory trust for only
      // the current session. Never end that session for an unattended launch
      // which will need the owner again, even if its persisted flag says true.
      const directory = seat.workingDirectory;
      const paths = await Promise.all([
        // allow-swallowed-rejection -- an unreadable launch directory refuses trust_required below, before any signal or launch.
        directory === undefined ? undefined : realpath(directory).catch(() => undefined),
        // allow-swallowed-rejection -- an unreadable home refuses trust_required below; it never grants unattended trust.
        realpath(homedir()).catch(() => undefined),
      ]);
      if (paths[0] === undefined || paths[1] === undefined || paths[0] === paths[1])
        return {
          outcome: "refused",
          reason: "trust_required",
          detail: `Claude's launch directory ${directory ?? "(unknown)"} ${paths[0] === paths[1] && paths[0] !== undefined ? "is home; trust there is session-only" : "could not be verified outside home"}. Owner action: first accept folder trust for a non-home project using the selected Claude account. Then select that project with \`clankie workdir set PATH\` and restart captain. The current session was left running.`,
        };
    }
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
    // Kept first: a brief that could not be kept stops the relaunch before any effect.
    const brief = input.handoffBrief?.trim();
    keepHandoff(receiptId, brief ? { state: "pending", brief } : { state: "pending" });
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
        // The new session's own poll may have settled it first (VUH-2860).
        if (read().receipts.find((entry) => entry.receiptId === receiptId)?.stage !== "relaunched")
          save({ ...receipt, stage: "relaunched", sessionId: next.sessionId, seatId: next.terminalId });
        // allow-swallowed-rejection -- the relaunch happened either way; an unclaimed brief stays pending for the next bound poll, a claimed one is never resent.
        await handOffReceipt(receiptId, next).catch(() => undefined);
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

  /** Read-only: what became of a relaunch, never another attempt. */
  async function reconcile(receiptId: string): Promise<RelaunchLeadSeatResult> {
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
    // allow-swallowed-rejection -- an unreadable seat proves nothing; the receipt stays uncertain.
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
  }

  return {
    leadSeatLaunch,
    restartRefused,
    restartSettled,
    /** The restart's budget, latest check and refused wait, for `clankie fleet status`. */
    restartStatus(input: {
      readonly conversationId: string;
      readonly setting: "on" | "off";
      readonly budget: { readonly contextTokens: number; readonly ageMs: number };
      readonly check?: LeadRestartStatus["check"];
      readonly unknownCheck?: LeadRestartStatus["unknownCheck"];
    }): LeadRestartStatus {
      const stored = readWaits()[input.conversationId];
      const waiting: LeadRestartWait | undefined =
        stored === undefined ? undefined : (({ pendingNotice: _pending, ...wait }) => wait)(stored);
      return {
        schemaVersion: 1,
        conversationId: input.conversationId,
        setting: input.setting,
        budget: { contextTokens: input.budget.contextTokens, ageHours: input.budget.ageMs / 3_600_000 },
        noticeAfterMinutes: (deps.restartNoticeAfterMs ?? RESTART_NOTICE_AFTER_MS) / 60_000,
        ...(input.check === undefined ? {} : { check: input.check }),
        ...(input.unknownCheck === undefined ? {} : { unknownCheck: input.unknownCheck }),
        ...(waiting === undefined ? {} : { waiting }),
      };
    },
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
    /**
     * The relaunch that proves `next` succeeds `previous`, the conversation's
     * stored seat (VUH-2860): its latest receipt ended exactly that session and
     * launched the target harness in that pane, and the same terminal now runs a
     * different session of it. While the receipt is open any such session is
     * the one it launched; once settled, only the session it recorded. Anything
     * else, an unreadable journal included, is no proof.
     */
    successorReceipt(conversationId: string, previous: LeadSeatPane, next: LeadSeatPane): string | undefined {
      if (
        previous.paneId !== next.paneId ||
        previous.terminalId !== next.terminalId ||
        previous.sessionId === undefined ||
        next.sessionId === undefined ||
        next.sessionId === previous.sessionId
      )
        return undefined;
      let receipt: Receipt | undefined;
      try {
        receipt = read().receipts.findLast((entry) => entry.conversationId === conversationId);
      } catch {
        return undefined;
      }
      if (
        receipt === undefined ||
        receipt.paneId !== next.paneId ||
        receipt.previousSessionId !== previous.sessionId ||
        receipt.to.harness !== next.harness
      )
        return undefined;
      if (receipt.stage === "launching") return receipt.receiptId;
      return receipt.stage === "relaunched" &&
        receipt.sessionId === next.sessionId &&
        receipt.seatId === next.terminalId
        ? receipt.receiptId
        : undefined;
    },
    /**
     * The open relaunch whose successor has not reported a session yet (VUH-2868):
     * `next` runs the target harness in the same pane and terminal as `previous`,
     * the conversation's stored seat, with no native session, and the latest
     * receipt is still launching after ending exactly that stored session. Claude's
     * trust prompt can hold a successor here for hours. Anything else, an
     * unreadable journal included, is no proof.
     */
    pendingReceipt(conversationId: string, previous: LeadSeatPane, next: LeadSeatPane): string | undefined {
      if (
        previous.paneId !== next.paneId ||
        previous.terminalId !== next.terminalId ||
        previous.sessionId === undefined ||
        next.sessionId !== undefined
      )
        return undefined;
      let receipt: Receipt | undefined;
      try {
        receipt = read().receipts.findLast((entry) => entry.conversationId === conversationId);
      } catch {
        return undefined;
      }
      return receipt?.stage === "launching" &&
        receipt.paneId === next.paneId &&
        receipt.previousSessionId === previous.sessionId &&
        receipt.to.harness === next.harness
        ? receipt.receiptId
        : undefined;
    },
    /** Read-only: what became of a relaunch, never another attempt. */
    reconcileLeadSeatRelaunch: reconcile,
    /**
     * A new session bound by its relaunch receipt (VUH-2860): settle the receipt
     * by reconciliation. Its kept brief reaches the session at its next poll
     * (`handOff`). A receipt from before briefs were kept settles all the same,
     * and the conversation is told its brief was unavailable.
     */
    async bindSuccessor(receiptId: string): Promise<RelaunchLeadSeatResult> {
      const result = await reconcile(receiptId);
      if (result.outcome !== "relaunched") return result;
      const receipt = read().receipts.find((entry) => entry.receiptId === receiptId);
      if (receipt !== undefined && readHandoffs()[receiptId] === undefined) {
        keepHandoff(receiptId, { state: "unavailable" });
        deps.notice(receipt.conversationId, restartNotice(receipt, result.sessionId, "unavailable"));
      }
      return result;
    },
    /** At a seat's poll: hand it the brief its conversation's latest relaunch still owes it. */
    async handOff(conversationId: string, seat: LeadSeatPane): Promise<void> {
      const receipt = read().receipts.findLast((entry) => entry.conversationId === conversationId);
      if (receipt?.stage === "relaunched") await handOffReceipt(receipt.receiptId, seat);
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
