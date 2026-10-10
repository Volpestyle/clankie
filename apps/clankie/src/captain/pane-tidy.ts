import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import {
  ClosedWorkerPaneSchema,
  type ClosedWorkerPane,
  type UnreconciledWorktree,
  type WorktreeReconciliation,
} from "@clankie/protocol";
import { checkoutGit, projectPathContains, reconcileWorktree } from "@clankie/settings";
import { redactSensitiveText } from "@clankie/observability";
import {
  ConversationOwnerSchema,
  assertConversationAuthority,
  captureConversationAuthority,
  type ConversationAuthority,
  type ConversationOwner,
} from "./conversation-owner.ts";
import { codexProcess, resolveCodexSessionId } from "./codex-seat.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import type { HireSeat } from "./port.ts";
import type { SavedAgentSession } from "../agent-sessions.ts";
import { paneInputLine } from "./pane-draft.ts";
import { describeRetainedWorktrees, listTidyWorktrees, type TidyWorktreesResult } from "./tidy-worktrees.ts";
import { WorktreeDecisions, workerWorktreeHold } from "./worktree-decisions.ts";

const UNDO_MS = 5 * 60_000;
const EntrySchema = ClosedWorkerPaneSchema.extend({
  sessionId: z.string().min(1),
  workingDirectory: z.string().min(1),
  owner: ConversationOwnerSchema,
  closedBy: ConversationOwnerSchema,
  /**
   * The native input line verbatim at close (VUH-2013). `typed: false` is a uniformly faint
   * native ghost: a placeholder or Claude's suggested next prompt, never a typed draft.
   * Service-private, like the session, so older strict clients still parse the public record.
   */
  input: z
    .object({ text: z.string().max(16384), typed: z.boolean() })
    .strict()
    .optional(),
  /** Why the last Undo could not reopen the session, exactly as the resume path reported it. */
  undoFailure: z
    .object({
      reason: z.string().max(64),
      detail: z.string().max(1024).optional(),
      at: z.string().datetime(),
    })
    .strict()
    .optional(),
});
const ReportSchema = z.object({ sessionKey: z.string(), reportPath: z.string() }).strict();
export const PaneTidyStateSchema = z
  .object({ version: z.literal(1), entries: z.array(EntrySchema), reports: z.array(ReportSchema) })
  .strict();
type Entry = z.infer<typeof EntrySchema>;
export type TidyFailure =
  | { outcome: "refused"; reason: "owner_interactive" | "results_not_kept" }
  /** The native input line holds typed text; it is returned verbatim so nothing is lost. */
  | { outcome: "refused"; reason: "unsent_draft"; draft?: string }
  /** Another lead conversation hired this pane; only it may close it (VUH-1763). */
  | { outcome: "refused"; reason: "not_owner"; ownerConversationId: string }
  /** The worker's worktree holds commits not on main by content, or uncommitted files (VUH-1814). */
  | { outcome: "refused"; reason: "unlanded_work"; worktrees: WorktreeReconciliation[] }
  | {
      outcome: "failed";
      reason:
        | "draft_state_unknown"
        | "provenance_unknown"
        | "pane_unknown"
        | "herdr_unavailable"
        | "history_unavailable"
        | "close_unconfirmed"
        | "undo_expired"
        | "undo_unknown"
        | "undo_unconfirmed"
        | "authority_unavailable"
        | "busy"
        | "invalid_reason"
        | "native_exit_unavailable"
        | "restart_unsupported"
        | "report_receipt_unresolved";
      /** What the native or resume path reported, when it said more than the reason. */
      detail?: string;
    };
class Failure extends Error {
  readonly result: TidyFailure;
  constructor(result: TidyFailure) {
    super(result.reason);
    this.result = result;
  }
}
const fail = (reason: Extract<TidyFailure, { outcome: "failed" }>["reason"], detail?: string): never => {
  throw new Failure({ outcome: "failed", reason, ...(detail ? { detail: detail.slice(0, 1024) } : {}) });
};
const refuse = (
  reason: Exclude<
    Extract<TidyFailure, { outcome: "refused" }>["reason"],
    "not_owner" | "unlanded_work" | "unsent_draft"
  >,
): never => {
  throw new Failure({ outcome: "refused", reason });
};
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 512);
const validReason = (reason: string) =>
  reason.length > 0 && reason.length <= 512 && !/[\r\n]/u.test(reason) && !reason.includes("\0");
function sessionKey(agent: HerdrAgentSnapshot): string {
  return JSON.stringify([
    splitFleetQualified(agent.paneId)?.fleet ?? "local",
    agent.agent,
    agent.session?.value,
  ]);
}
function publicEntry(entry: Entry): ClosedWorkerPane {
  const {
    sessionId: _session,
    workingDirectory: _cwd,
    owner: _owner,
    closedBy: _by,
    input: _input,
    undoFailure: _undo,
    ...visible
  } = entry;
  return ClosedWorkerPaneSchema.parse(visible);
}
/** The lead's view: the public record plus what was in the input line and why Undo failed. */
export type ClosedWorkerPaneHistory = ClosedWorkerPane & Pick<Entry, "input" | "undoFailure">;
function leadEntry(entry: Entry): ClosedWorkerPaneHistory {
  return {
    ...publicEntry(entry),
    ...(entry.input ? { input: entry.input } : {}),
    ...(entry.undoFailure ? { undoFailure: entry.undoFailure } : {}),
  };
}

/** Judgment is the lead's. This service checks only hard lines and technical admission. */
export class PaneTidy {
  private state: z.infer<typeof PaneTidyStateSchema>;
  private readonly pending = new Set<string>();
  private readonly path: string;
  /** Recorded lead decisions about unlanded worktree work, beside this history. */
  readonly decisions: WorktreeDecisions;
  private readonly ports: {
    runner: HerdrWatchRunner;
    prune?(
      repository: string,
      path: string,
      guard: () => Promise<void>,
    ): Promise<import("./prune-worktree.ts").PruneWorktreeResult>;
    provenance(agent: HerdrAgentSnapshot): ConversationOwner | "unknown" | "owner_interactive";
    ownerValid(owner: ConversationOwner): Promise<boolean>;
    close(seatId: string, guard: () => Promise<void>, nativeOnly?: boolean): Promise<boolean>;
    untrack(seatId: string): void;
    hire: HireSeat;
    resolve?(ref: string): Promise<SavedAgentSession>;
    preflightResume?(session: SavedAgentSession): Promise<void>;
    nativeExitAvailable?(agent: HerdrAgentSnapshot): Promise<boolean>;
    changed(): void;
    runtimeRoot?: string;
    now?: () => number;
  };
  constructor(path: string, ports: PaneTidy["ports"]) {
    this.path = path;
    this.ports = ports;
    this.decisions = new WorktreeDecisions(join(dirname(path), "worktree-decisions.json"));
    // Corrupt history blocks construction; it must never become an empty journal.
    this.state = existsSync(path)
      ? PaneTidyStateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { version: 1, entries: [], reports: [] };
  }
  history(): readonly ClosedWorkerPane[] {
    return this.state.entries.slice(-128).map(publicEntry).reverse();
  }
  /** History for the lead's own tools, keeping input lines and Undo failures. */
  leadHistory(): readonly ClosedWorkerPaneHistory[] {
    return this.state.entries.slice(-128).map(leadEntry).reverse();
  }
  /** List merged, clean, unused linked worktrees; never remove one. */
  worktrees(repositoryPath: string, mergedInto = "origin/main"): Promise<TidyWorktreesResult> {
    return listTidyWorktrees(repositoryPath, mergedInto, this.ports.runner, {
      ...(this.ports.runtimeRoot ? { runtimeRoot: this.ports.runtimeRoot } : {}),
      dropDecided: (path, head) => this.decisions.latest(path, head)?.decision === "safe_to_drop",
    });
  }
  /**
   * Candidates are landed (merged, by content, or a decided drop). Each retained tree holding
   * work says how much and what was decided: unlanded work waits for worth_landing or
   * safe_to_drop from `decideWorktree`, and is never removed without one.
   */
  async worktreeReport(repository: string, mergedInto = "origin/main") {
    const result = await this.worktrees(repository, mergedInto);
    const retained = await describeRetainedWorktrees(result, this.ports.runner);
    return {
      ...result,
      retained: await Promise.all(
        retained.map(async (entry) => {
          if (entry.reason !== "unmerged" && entry.reason !== "dirty") return entry;
          const work = await reconcileWorktree(entry.path, mergedInto);
          const decision = work?.head ? this.decisions.latest(entry.path, work.head) : undefined;
          return {
            ...entry,
            classification: decision?.decision ?? "undecided",
            ...(work
              ? { unlandedCommits: work.unlandedCommits, dirtyFiles: work.dirtyFiles, head: work.head }
              : {}),
            ...(decision ? { decision } : {}),
          };
        }),
      ),
    };
  }
  /** Record the lead's judgment of one registered worktree's unlanded work at its current HEAD. */
  async decideWorktree(
    input: { repository: string; path: string; decision: "worth_landing" | "safe_to_drop"; reason: string },
    by: string,
  ) {
    const reason = input.reason.trim();
    if (!validReason(reason)) throw Error("Give a one-line reason");
    const fields = (await checkoutGit(input.repository, ["worktree", "list", "--porcelain", "-z"])).split(
      "\0",
    );
    if (fields[0] === `worktree ${input.path}` || !fields.includes(`worktree ${input.path}`))
      throw Error("Select a linked worktree registered to this repository");
    const work = await reconcileWorktree(input.path);
    if (!work || work.state === "unknown" || !work.head) throw Error("Worktree state is unreadable");
    return this.decisions.record({
      path: input.path,
      head: work.head,
      decision: input.decision,
      reason,
      by,
      ...(work.unlandedCommits === undefined ? {} : { unlandedCommits: work.unlandedCommits }),
      ...(work.dirtyFiles === undefined ? {} : { dirtyFiles: work.dirtyFiles }),
    });
  }
  async pruneWorktree(repository: string, path: string, source: ConversationAuthority) {
    const authority = captureConversationAuthority(source);
    await this.authority(authority);
    if (!this.ports.prune) throw Error("Worktree pruning unavailable");
    return this.ports.prune(repository, path, () => this.authority(authority));
  }
  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(PaneTidyStateSchema.parse(this.state)));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, this.path);
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.ports.changed();
  }
  /** An authenticated accepted worker report becomes a kept artifact, even if delivery is queued. */
  keepReport(agent: HerdrAgentSnapshot, text: string): void {
    if (!agent.session || !text.trim()) return;
    const root = join(dirname(this.path), "tidy-reports");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const reportPath = join(root, `${randomUUID()}.md`);
    const fd = openSync(reportPath, "wx", 0o600);
    try {
      writeFileSync(fd, redactSensitiveText(text));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directory = openSync(root, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.state.reports = [
      ...this.state.reports.filter((report) => report.sessionKey !== sessionKey(agent)),
      { sessionKey: sessionKey(agent), reportPath },
    ];
    this.save();
  }
  private async fresh(target: string): Promise<HerdrAgentSnapshot> {
    const fleet = splitFleetQualified(target)?.fleet;
    let agent = (await this.ports.runner.list?.(fleet))?.find(
      (item) => item.paneId === target || item.terminalId === target,
    );
    if (!agent) agent = await this.ports.runner.get(target).catch(() => undefined);
    if (!agent) return fail("pane_unknown");
    if (agent.agent === "unknown" && agent.session?.source === "herdr:claude")
      agent = { ...agent, agent: "claude" };
    if (agent.agent === "unknown" && agent.session?.source === "herdr:codex")
      agent = { ...agent, agent: "codex" };
    if (!agent.session && (agent.agent === "codex" || agent.agent === "unknown")) {
      const processes = await this.ports.runner.paneProcesses?.(agent.paneId);
      if (!processes) return fail("provenance_unknown");
      const process = codexProcess(processes);
      if (process) agent = { ...agent, agent: "codex" };
      const argv = process?.argv ?? [];
      const at = argv.indexOf("resume");
      // Reattached daemon clients have no rollout file in the client process. The native argv
      // must explicitly identify a UUID; --last and human labels cannot establish identity.
      const resumed = at >= 0 ? argv[at + 1] : undefined;
      const id =
        resumed && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(resumed)
          ? resumed
          : process && this.ports.runner.openFiles
            ? resolveCodexSessionId(processes!, await this.ports.runner.openFiles(process.pid))
            : undefined;
      if (id) agent = { ...agent, agent: "codex", session: { source: "herdr:codex", kind: "id", value: id } };
    }
    if (!["claude", "codex"].includes(agent.agent)) return fail("draft_state_unknown");
    if (!agent.session || agent.session.kind !== "id" || !agent.workingDirectory)
      return fail("provenance_unknown");
    return agent;
  }
  private async authority(source: ConversationAuthority): Promise<void> {
    try {
      await assertConversationAuthority(source);
    } catch {
      fail("authority_unavailable");
    }
  }
  async close(
    input: {
      pane: string;
      reason: string;
      reportPath?: string;
      /** Why the worker's unlanded commits or uncommitted files may be left behind. */
      unlandedReason?: string;
      idleOnly?: boolean;
      expected?: { terminalId: string; sessionKey: string };
      nativeOnly?: boolean;
    },
    source: ConversationAuthority,
  ): Promise<{ outcome: "closed"; entry: ClosedWorkerPaneHistory } | TidyFailure> {
    let lock: string | undefined;
    let entry: Entry | undefined;
    let line: { text: string; typed: boolean } | undefined;
    try {
      const authority = captureConversationAuthority(source);
      await this.authority(authority);
      const reason = input.reason.trim();
      const unlandedReason = input.unlandedReason?.trim();
      if (!validReason(reason) || (unlandedReason !== undefined && !validReason(unlandedReason)))
        return fail("invalid_reason");
      const agent = await this.fresh(input.pane);
      const key = sessionKey(agent);
      if (
        input.expected &&
        (agent.terminalId !== input.expected.terminalId || key !== input.expected.sessionKey)
      )
        return fail("provenance_unknown");
      if (
        this.pending.has(key) ||
        this.state.entries.some(
          (item) =>
            item.sessionId === agent.session!.value &&
            item.harness === agent.agent &&
            splitFleetQualified(item.paneId)?.fleet === splitFleetQualified(agent.paneId)?.fleet &&
            ["closing", "close_unconfirmed", "undoing"].includes(item.state),
        )
      )
        return fail("busy");
      this.pending.add(key);
      lock = key;
      const owner = this.ports.provenance(agent);
      if (owner === "unknown") return fail("provenance_unknown");
      if (owner === "owner_interactive") return refuse("owner_interactive");
      if (owner.conversationId !== authority.owner.conversationId)
        throw new Failure({
          outcome: "refused",
          reason: "not_owner",
          ownerConversationId: owner.conversationId,
        });
      if (!(await this.ports.ownerValid(owner))) return fail("provenance_unknown");
      let reportPath: string;
      let reportText: string;
      try {
        const candidate =
          input.reportPath ?? this.state.reports.find((report) => report.sessionKey === key)?.reportPath;
        if (!candidate || !isAbsolute(candidate)) return refuse("results_not_kept");
        reportPath = realpathSync(candidate);
        const stat = statSync(reportPath);
        if (!stat.isFile() || stat.size === 0) return refuse("results_not_kept");
        reportText = readFileSync(reportPath, "utf8");
      } catch (error) {
        if (error instanceof Failure) throw error;
        return refuse("results_not_kept");
      }
      // Copy the verified artifact into service-owned history before any close effect.
      this.keepReport(agent, reportText);
      reportPath = this.state.reports.find((report) => report.sessionKey === key)!.reportPath;
      // Restart resumes the same thread in the same directory, so nothing is left behind.
      const checkWorktrees = !input.nativeOnly;
      const held = checkWorktrees ? await workerWorktreeHold(agent) : [];
      if (held.length && !unlandedReason)
        throw new Failure({ outcome: "refused", reason: "unlanded_work", worktrees: held });
      const raw = await this.ports.runner
        .readPane?.(agent.paneId, "recent-unwrapped", "text")
        .catch(() => undefined);
      if (raw === undefined) return fail("herdr_unavailable");
      const guard = async () => {
        await this.authority(authority);
        const latest = await this.fresh(agent.paneId);
        if (input.idleOnly && !["idle", "waiting", "done"].includes(latest.status)) return fail("busy");
        if (
          latest.terminalId !== agent.terminalId ||
          sessionKey(latest) !== key ||
          JSON.stringify(this.ports.provenance(latest)) !== JSON.stringify(owner) ||
          !(await this.ports.ownerValid(owner))
        )
          return fail("provenance_unknown");
        const ansi = await this.ports.runner
          .readPane?.(agent.paneId, "visible", "ansi")
          .catch(() => undefined);
        const read = ansi === undefined ? { state: "unknown" as const } : paneInputLine(agent.agent, ansi);
        if (read.state === "draft")
          throw new Failure({
            outcome: "refused",
            reason: "unsent_draft",
            ...(read.text ? { draft: read.text.slice(0, 16384) } : {}),
          });
        if (read.state === "unknown") return fail("draft_state_unknown");
        line = read.text ? { text: read.text.slice(0, 16384), typed: read.typed === true } : undefined;
        // The final read just before the native close wins; an emptied line keeps the earlier text.
        if (entry && line) entry.input = line;
        // Work committed or written after the first look still holds the close.
        if (checkWorktrees && !unlandedReason) {
          const late = await workerWorktreeHold(latest);
          if (late.length)
            throw new Failure({ outcome: "refused", reason: "unlanded_work", worktrees: late });
        }
        await this.authority(authority);
      };
      await guard();
      const closedAt = this.now();
      entry = EntrySchema.parse({
        id: randomUUID(),
        paneId: agent.paneId,
        seatId: agent.terminalId,
        title: agent.title,
        harness: agent.agent,
        sessionId: agent.session!.value,
        workingDirectory: agent.workingDirectory,
        owner,
        closedBy: authority.owner,
        reason,
        lastOutput: redactSensitiveText(stripVTControlCharacters(raw)).slice(-131072),
        reportPath,
        closedAt: new Date(closedAt).toISOString(),
        undoUntil: new Date(closedAt + UNDO_MS).toISOString(),
        state: "closing",
        ...(line ? { input: line } : {}),
        ...(held.length && unlandedReason
          ? { unlanded: { reason: unlandedReason, worktrees: held.slice(0, 8) } }
          : {}),
      });
      this.state.entries.push(entry);
      this.save();
      let guardFailure: unknown;
      const closed = await this.ports.close(
        agent.terminalId,
        async () => {
          try {
            await guard();
          } catch (error) {
            guardFailure = error;
            throw error;
          }
        },
        input.nativeOnly,
      );
      if (guardFailure) {
        this.state.entries = this.state.entries.filter((item) => item.id !== entry!.id);
        this.save();
        entry = undefined;
        throw guardFailure;
      }
      entry.state = closed ? "closed" : "close_unconfirmed";
      this.save();
      if (entry.unlanded)
        try {
          this.recordLeftBehind(entry.unlanded, `${authority.owner.conversationId}: ${entry.title}`);
        } catch {
          /* The close record already keeps the reason; the per-worktree index is secondary. */
        }
      if (!closed) return fail("close_unconfirmed");
      this.ports.untrack(agent.terminalId);
      return { outcome: "closed", entry: leadEntry(entry) };
    } catch (error) {
      if (entry?.state === "closing") {
        entry.state = "close_unconfirmed";
        try {
          this.save();
        } catch {
          /* Keep the previously persisted pending record. */
        }
      }
      return error instanceof Failure ? error.result : { outcome: "failed", reason: "history_unavailable" };
    } finally {
      if (lock) this.pending.delete(lock);
    }
  }
  /**
   * Doctor's view of unreconciled worktrees: who owns each (its live pane, else the worker
   * closed from it), how long since anything happened there, and any recorded decision.
   */
  async describeUnreconciled(worktrees: readonly WorktreeReconciliation[]): Promise<UnreconciledWorktree[]> {
    const panes = (await this.ports.runner.list?.().catch(() => undefined)) ?? [];
    const platform = process.platform === "win32" ? "windows" : "posix";
    const inside = (root: string, path: string | undefined) =>
      path !== undefined && projectPathContains(root, path, platform);
    const now = this.now();
    return worktrees
      .map((worktree) => {
        const live = panes.filter(
          (pane) =>
            inside(worktree.path, pane.workingDirectory) ||
            inside(worktree.path, pane.foregroundWorkingDirectory),
        );
        const closed = this.state.entries.findLast((entry) => inside(worktree.path, entry.workingDirectory));
        const decision = this.decisions.latest(worktree.path);
        const at = worktree.lastActivityAt ? Date.parse(worktree.lastActivityAt) : undefined;
        return {
          ...worktree,
          owner: live.length
            ? live.map((pane) => pane.name ?? pane.paneId).join(", ")
            : closed
              ? `${closed.title || closed.harness} (closed ${closed.closedAt.slice(0, 10)})`
              : "unattributed",
          ...(at === undefined ? {} : { ageSeconds: Math.max(0, Math.floor((now - at) / 1000)) }),
          ...(decision ? { decision } : {}),
        };
      })
      .sort((a, b) => (b.ageSeconds ?? 0) - (a.ageSeconds ?? 0));
  }
  /** What closing this seat would leave behind; the operator close path (TUI, app) holds on it too. */
  async seatWorktreeHold(seatId: string): Promise<WorktreeReconciliation[]> {
    const agent = await this.ports.runner.resolveTerminal(seatId).catch(() => undefined);
    return agent ? workerWorktreeHold(agent) : [];
  }
  /** The close record keeps the reason; the decision ledger lets doctor and tidy see it per worktree. */
  recordLeftBehind(unlanded: { reason: string; worktrees: WorktreeReconciliation[] }, by: string): void {
    for (const worktree of unlanded.worktrees)
      this.decisions.record({
        path: worktree.path,
        ...(worktree.head ? { head: worktree.head } : {}),
        decision: "closed_unreconciled",
        reason: unlanded.reason,
        by: by.slice(0, 512),
        ...(worktree.unlandedCommits === undefined ? {} : { unlandedCommits: worktree.unlandedCommits }),
        ...(worktree.dirtyFiles === undefined ? {} : { dirtyFiles: worktree.dirtyFiles }),
      });
  }
  /** Explicit operator recovery, composed from the same journaled close/resume
   * boundaries as tidy. A lost exit/resume receipt never triggers another hire. */
  async restart(
    input: { pane: string; reportPath?: string },
    source: ConversationAuthority,
  ): Promise<import("@clankie/protocol/tool-catalog").FleetWorkerToolRestartResult> {
    try {
      await this.authority(source);
      if (splitFleetQualified(input.pane)) return fail("restart_unsupported");
      const original = await this.fresh(input.pane);
      if (original.paneId !== input.pane) return fail("provenance_unknown");
      if (splitFleetQualified(original.paneId) || original.agent !== "codex")
        return fail("restart_unsupported");
      if (!original.session || original.session.kind !== "id") return fail("provenance_unknown");
      if (!["idle", "waiting", "done"].includes(original.status)) return fail("busy");
      if (!(await this.ports.nativeExitAvailable?.(original))) return fail("native_exit_unavailable");
      await this.authority(source);
      // Validate the saved thread, cwd and registered account before exit.
      // Ordinary resume revalidates them and retains any uncertain launch.
      if (!this.ports.resolve || !this.ports.preflightResume) return fail("history_unavailable");
      const saved = await this.ports.resolve(`local:${original.session.value}`);
      if (saved.sessionId !== original.session.value || saved.workingDirectory !== original.workingDirectory)
        return fail("history_unavailable");
      await this.ports.preflightResume(saved);
      await this.authority(source);
      const closed = await this.close(
        {
          ...input,
          reason: "Restart worker tools on the same native thread",
          idleOnly: true,
          nativeOnly: true,
          expected: { terminalId: original.terminalId, sessionKey: sessionKey(original) },
        },
        source,
      );
      if (closed.outcome !== "closed") return closed;
      const resumed = await this.undo(closed.entry.id, source);
      if (resumed.outcome !== "reopened")
        return {
          outcome: resumed.outcome,
          reason:
            "detail" in resumed && resumed.detail ? `${resumed.reason}: ${resumed.detail}` : resumed.reason,
          historyId: closed.entry.id,
          threadId: original.session.value,
        };
      return {
        outcome: "restarted",
        historyId: resumed.entry.id,
        resumedSeatId: resumed.entry.resumedSeatId,
        threadId: original.session.value,
      };
    } catch (error) {
      return error instanceof Failure ? error.result : { outcome: "failed", reason: "history_unavailable" };
    }
  }
  async undo(
    id: string,
    source: ConversationAuthority,
  ): Promise<{ outcome: "reopened"; entry: ClosedWorkerPaneHistory } | TidyFailure> {
    let locked = false;
    let entry: Entry | undefined;
    try {
      const authority = captureConversationAuthority(source);
      await this.authority(authority);
      entry = this.state.entries.find((item) => item.id === id);
      // An `undoing` record outlived its attempt (the hire failed or the service stopped);
      // the session scan below decides whether it reopened, so it may be undone again.
      if (!entry || !["closed", "undoing"].includes(entry.state))
        return fail("undo_unknown", entry ? `The close record is ${entry.state}` : undefined);
      if (this.now() > Date.parse(entry.undoUntil)) return fail("undo_expired");
      if (this.pending.has(id)) return fail("busy");
      this.pending.add(id);
      locked = true;
      if (
        authority.owner.conversationId !== entry.closedBy.conversationId ||
        !(await this.ports.ownerValid(entry.owner))
      )
        return fail("authority_unavailable");
      const fleet = splitFleetQualified(entry.paneId)?.fleet;
      if (!this.ports.resolve || !this.ports.runner.list)
        return fail("undo_unconfirmed", "This body cannot list panes or resolve saved sessions");
      // Do not create a second TUI when the session was already reopened by someone else.
      for (const pane of await this.ports.runner.list(fleet)) {
        if (pane.agent !== "unknown" && pane.agent !== entry.harness) continue;
        let fresh: HerdrAgentSnapshot | undefined;
        try {
          fresh = await this.fresh(pane.paneId);
        } catch (error) {
          // A known unsupported shell shape is irrelevant; an unidentifiable native worker
          // may already be this session, so it cannot be counted as absent.
          if (!(error instanceof Failure) || error.result.reason !== "draft_state_unknown")
            return fail(
              "undo_unconfirmed",
              `Pane ${pane.paneId} could not be identified (${error instanceof Failure ? error.result.reason : String(error)}); it may already hold this session`,
            );
        }
        if (fresh?.agent === entry.harness && fresh.session?.value === entry.sessionId) {
          // The session is open again; record where instead of hiring a duplicate.
          entry.state = "reopened";
          entry.resumedSeatId = fresh.terminalId;
          delete entry.undoFailure;
          this.save();
          return { outcome: "reopened", entry: leadEntry(entry) };
        }
      }
      const ref = `${fleet ?? "local"}:${entry.sessionId}`;
      const saved = await this.ports
        .resolve(ref)
        .catch((error: unknown) =>
          fail("undo_unconfirmed", `Saved session ${ref} is unavailable: ${errorText(error)}`),
        );
      if (saved.sessionId !== entry.sessionId || saved.workingDirectory !== entry.workingDirectory)
        return fail(
          "undo_unconfirmed",
          `Saved session ${saved.sessionId} in ${saved.workingDirectory} is not the closed ${entry.sessionId} in ${entry.workingDirectory}`,
        );
      await this.authority(authority);
      if (this.now() > Date.parse(entry.undoUntil)) return fail("undo_expired");
      entry.state = "undoing";
      this.save();
      const closed = entry;
      const result = await this.ports
        .hire(
          {
            schemaVersion: 1,
            title: closed.title || "Worker",
            workingDirectory: closed.workingDirectory,
            harness: closed.harness,
            resume: ref,
            placement: "new-tab",
            ...(fleet ? { fleet } : {}),
          },
          undefined,
          {
            owner: closed.owner,
            current: authority.current,
            authorize: async () =>
              (await authority.authorize()) && (await this.ports.ownerValid(closed.owner)),
          },
        )
        .catch((error: unknown) => ({ outcome: "threw" as const, error }));
      if (result.outcome !== "spawned") {
        // Back to closed: the next Undo rescans for this session before any second hire.
        closed.state = "closed";
        this.save();
        return fail(
          "undo_unconfirmed",
          result.outcome === "threw"
            ? `Resume failed: ${errorText(result.error)}`
            : `Resume ${result.outcome}: ${result.reason}${result.detail ? ` (${result.detail})` : ""}`,
        );
      }
      closed.state = "reopened";
      closed.resumedSeatId = result.seat.seatId;
      delete closed.undoFailure;
      this.save();
      return { outcome: "reopened", entry: leadEntry(closed) };
    } catch (error) {
      const result: TidyFailure =
        error instanceof Failure
          ? error.result
          : { outcome: "failed", reason: "undo_unconfirmed", detail: `Undo failed: ${errorText(error)}` };
      if (
        entry &&
        result.outcome === "failed" &&
        result.reason !== "undo_unknown" &&
        result.reason !== "busy"
      )
        try {
          entry.undoFailure = {
            reason: result.reason,
            ...(result.detail ? { detail: result.detail } : {}),
            at: new Date(this.now()).toISOString(),
          };
          this.save();
        } catch {
          /* The returned failure still carries the reason. */
        }
      return result;
    } finally {
      if (locked) this.pending.delete(id);
    }
  }
}
