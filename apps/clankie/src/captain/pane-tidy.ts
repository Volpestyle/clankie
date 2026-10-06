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
import { ClosedWorkerPaneSchema, type ClosedWorkerPane } from "@clankie/protocol";
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
import { paneDraftState } from "./pane-draft.ts";
import { describeRetainedWorktrees, listTidyWorktrees, type TidyWorktreesResult } from "./tidy-worktrees.ts";

const UNDO_MS = 5 * 60_000;
const EntrySchema = ClosedWorkerPaneSchema.extend({
  sessionId: z.string().min(1),
  workingDirectory: z.string().min(1),
  owner: ConversationOwnerSchema,
  closedBy: ConversationOwnerSchema,
});
const ReportSchema = z.object({ sessionKey: z.string(), reportPath: z.string() }).strict();
export const PaneTidyStateSchema = z
  .object({ version: z.literal(1), entries: z.array(EntrySchema), reports: z.array(ReportSchema) })
  .strict();
type Entry = z.infer<typeof EntrySchema>;
export type TidyFailure =
  | { outcome: "refused"; reason: "unsent_draft" | "owner_interactive" | "results_not_kept" }
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
    };
class Failure extends Error {
  readonly result: TidyFailure;
  constructor(result: TidyFailure) {
    super(result.reason);
    this.result = result;
  }
}
const fail = (reason: Extract<TidyFailure, { outcome: "failed" }>["reason"]): never => {
  throw new Failure({ outcome: "failed", reason });
};
const refuse = (reason: Extract<TidyFailure, { outcome: "refused" }>["reason"]): never => {
  throw new Failure({ outcome: "refused", reason });
};
function sessionKey(agent: HerdrAgentSnapshot): string {
  return JSON.stringify([
    splitFleetQualified(agent.paneId)?.fleet ?? "local",
    agent.agent,
    agent.session?.value,
  ]);
}
function publicEntry(entry: Entry): ClosedWorkerPane {
  const { sessionId: _session, workingDirectory: _cwd, owner: _owner, closedBy: _by, ...visible } = entry;
  return ClosedWorkerPaneSchema.parse(visible);
}

/** Judgment is the lead's. This service checks only hard lines and technical admission. */
export class PaneTidy {
  private state: z.infer<typeof PaneTidyStateSchema>;
  private readonly pending = new Set<string>();
  private readonly path: string;
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
    // Corrupt history blocks construction; it must never become an empty journal.
    this.state = existsSync(path)
      ? PaneTidyStateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { version: 1, entries: [], reports: [] };
  }
  history(): readonly ClosedWorkerPane[] {
    return this.state.entries.slice(-128).map(publicEntry).reverse();
  }
  /** List merged, clean, unused linked worktrees; never remove one. */
  worktrees(repositoryPath: string, mergedInto = "origin/main"): Promise<TidyWorktreesResult> {
    return listTidyWorktrees(repositoryPath, mergedInto, this.ports.runner, {
      ...(this.ports.runtimeRoot ? { runtimeRoot: this.ports.runtimeRoot } : {}),
    });
  }
  async worktreeReport(repository: string, mergedInto = "origin/main") {
    const result = await this.worktrees(repository, mergedInto);
    return { ...result, retained: await describeRetainedWorktrees(result, this.ports.runner) };
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
      idleOnly?: boolean;
      expected?: { terminalId: string; sessionKey: string };
      nativeOnly?: boolean;
    },
    source: ConversationAuthority,
  ): Promise<{ outcome: "closed"; entry: ClosedWorkerPane } | TidyFailure> {
    let lock: string | undefined;
    let entry: Entry | undefined;
    try {
      const authority = captureConversationAuthority(source);
      await this.authority(authority);
      const reason = input.reason.trim();
      if (!reason || reason.length > 512 || /[\r\n]/u.test(reason) || reason.includes("\0"))
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
        const draft = ansi === undefined ? "unknown" : paneDraftState(agent.agent, ansi);
        if (draft === "draft") return refuse("unsent_draft");
        if (draft === "unknown") return fail("draft_state_unknown");
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
      if (!closed) return fail("close_unconfirmed");
      this.ports.untrack(agent.terminalId);
      return { outcome: "closed", entry: publicEntry(entry) };
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
        return { ...resumed, historyId: closed.entry.id, threadId: original.session.value };
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
  ): Promise<{ outcome: "reopened"; entry: ClosedWorkerPane } | TidyFailure> {
    let locked = false;
    try {
      const authority = captureConversationAuthority(source);
      await this.authority(authority);
      const entry = this.state.entries.find((item) => item.id === id);
      if (!entry || entry.state !== "closed") return fail("undo_unknown");
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
      if (!this.ports.resolve || !this.ports.runner.list) return fail("undo_unconfirmed");
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
            return fail("undo_unconfirmed");
        }
        if (fresh?.agent === entry.harness && fresh.session?.value === entry.sessionId)
          return fail("undo_unconfirmed");
      }
      const ref = `${fleet ?? "local"}:${entry.sessionId}`;
      const saved = await this.ports.resolve(ref);
      if (saved.sessionId !== entry.sessionId || saved.workingDirectory !== entry.workingDirectory)
        return fail("undo_unconfirmed");
      await this.authority(authority);
      if (this.now() > Date.parse(entry.undoUntil)) return fail("undo_expired");
      entry.state = "undoing";
      this.save();
      const result = await this.ports.hire(
        {
          schemaVersion: 1,
          title: entry.title || "Worker",
          workingDirectory: entry.workingDirectory,
          harness: entry.harness,
          resume: ref,
          placement: "new-tab",
          ...(fleet ? { fleet } : {}),
        },
        undefined,
        {
          owner: entry.owner,
          current: authority.current,
          authorize: async () => (await authority.authorize()) && (await this.ports.ownerValid(entry.owner)),
        },
      );
      if (result.outcome !== "spawned") return fail("undo_unconfirmed");
      entry.state = "reopened";
      entry.resumedSeatId = result.seat.seatId;
      this.save();
      return { outcome: "reopened", entry: publicEntry(entry) };
    } catch (error) {
      return error instanceof Failure ? error.result : { outcome: "failed", reason: "undo_unconfirmed" };
    } finally {
      if (locked) this.pending.delete(id);
    }
  }
}
