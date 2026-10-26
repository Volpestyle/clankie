import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { SeatControl, SeatLaunch, SeatView, HarnessSeatAdapter } from "@clankie/agent-hosts";
import type { ConversationOwner } from "./conversation-owner.ts";
import { ConversationOwnerSchema } from "./conversation-owner.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import type { ProjectHireProcessProof } from "./project-hires.ts";
import { ProjectHireProcessProofSchema } from "./project-hires.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { paneDraftState } from "./pane-draft.ts";
import { parseHerdrSeatTranscript, resolveHerdrSeatTranscriptPath } from "./herdr-transcript.ts";
import { channelBody } from "./claude-worker-seat.ts";
import { z } from "zod";
import { observeNativeBirth, nativeProcessStart } from "../local-fleet-process.ts";
export type HiredRestartGuard = (phase?: "old" | "successor") => Promise<void>;

const ReceiptSchema = z
  .object({
    id: z.string(),
    paneId: z.string(),
    previousSessionId: z.string(),
    at: z.string(),
    stage: z.enum([
      "handoff_sending",
      "handoff_sent",
      "handoff_complete",
      "refused",
      "ending",
      "launching",
      "restarted",
      "uncertain",
    ]),
    reason: z.string().optional(),
    messageId: z.string().optional(),
    sessionId: z.string().optional(),
    handoffBrief: z.string().optional(),
    transcriptSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    previousProof: ProjectHireProcessProofSchema.optional(),
  })
  .strict();
export type HiredRestartReceipt = z.infer<typeof ReceiptSchema>;
export type HiredRestartResult = {
  outcome: "restarted" | "refused" | "uncertain";
  receiptId: string;
  reason?: string;
  sessionId?: string;
};
export type HiredHandoffResult =
  | { outcome: "replied"; receiptId: string; text: string }
  | { outcome: "refused" | "uncertain"; receiptId: string; reason: string };
const ProvenanceSchema = z
  .object({
    paneId: z.string(),
    sessionId: z.string(),
    terminalId: z.string(),
    originalBrief: z.string(),
    workItem: z.string().optional(),
    name: z.string().optional(),
    workingDirectory: z.string(),
    owner: ConversationOwnerSchema,
  })
  .strict();
export interface HiredRestartCandidate {
  readonly agent: HerdrAgentSnapshot;
  readonly originalBrief: string;
  readonly unavailableReason?: string;
  readonly workItem?: string | undefined;
  readonly name: string;
  readonly workingDirectory: string;
  readonly owner: ConversationOwner;
  requestHandoff(
    message: string,
    guard: HiredRestartGuard,
    signal?: AbortSignal,
  ): Promise<HiredHandoffResult>;
  restart(handoffBrief: string, guard: HiredRestartGuard): Promise<HiredRestartResult>;
}
export interface OriginalHiredRuntime {
  agent: HerdrAgentSnapshot;
  readonly originalBrief: string;
  readonly workItem?: string | undefined;
  readonly owner: ConversationOwner;
  readonly adapter: HarnessSeatAdapter;
  readonly launch: SeatLaunch;
  readonly view: SeatView;
  readonly restartView?: SeatView;
  control: SeatControl;
  proof?: ProjectHireProcessProof | undefined;
  readonly prepared: boolean;
  /** Complete policy and resource admissions while the original native process still lives. */
  admitRestart(): Promise<void>;
  /** A successor is bound only under this engine's persisted original receipt. */
  successor(
    previous: HerdrAgentSnapshot,
    next: HerdrAgentSnapshot,
    proof: ProjectHireProcessProof,
    receiptId: string,
  ): Promise<void>;
}

/** Original live closures confer authority; journal data alone can never restore it. */
export class HiredSeatRestarts {
  private readonly originals = new Map<string, OriginalHiredRuntime>();
  private readonly active = new Set<string>();
  private readonly receipts: HiredRestartReceipt[];
  private readonly provenance: z.infer<typeof ProvenanceSchema>[];
  private readonly path: string;
  private readonly runner: HerdrWatchRunner;
  private readonly proof: (pane: string) => Promise<ProjectHireProcessProof | undefined>;
  private readonly signal: (pid: number) => void;
  constructor(
    path: string,
    runner: HerdrWatchRunner,
    proof: (pane: string) => Promise<ProjectHireProcessProof | undefined>,
    signal: (pid: number) => void = (pid) => {
      process.kill(pid, "SIGTERM");
    },
  ) {
    this.path = path;
    this.runner = runner;
    this.proof = proof;
    this.signal = signal;
    this.receipts = existsSync(path)
      ? z.array(ReceiptSchema).parse(JSON.parse(readFileSync(path, "utf8")))
      : [];
    this.provenance = existsSync(`${path}.provenance.json`)
      ? z.array(ProvenanceSchema).parse(JSON.parse(readFileSync(`${path}.provenance.json`, "utf8")))
      : [];
  }
  register(runtime: OriginalHiredRuntime): void {
    this.originals.set(runtime.agent.paneId, runtime);
    const entry = {
      paneId: runtime.agent.paneId,
      terminalId: runtime.agent.terminalId,
      sessionId: runtime.control.ref.sessionId,
      originalBrief: runtime.originalBrief,
      workItem: runtime.workItem,
      name: runtime.view.name,
      workingDirectory: runtime.launch.cwd,
      owner: runtime.owner,
    };
    const index = this.provenance.findIndex((item) => item.paneId === entry.paneId);
    if (index < 0) this.provenance.push(entry);
    else this.provenance[index] = entry;
    this.write(`${this.path}.provenance.json`, this.provenance);
  }
  unavailable(agent: HerdrAgentSnapshot, owner: ConversationOwner): HiredRestartCandidate {
    const refused = async () => {
      const receipt = this.receipt(agent);
      receipt.reason = "original_runtime_unavailable";
      this.save(receipt);
      return { outcome: "refused" as const, receiptId: receipt.id, reason: receipt.reason };
    };
    return {
      agent,
      owner,
      originalBrief: "",
      name: agent.name ?? "",
      workingDirectory: agent.workingDirectory ?? "",
      unavailableReason: "original_runtime_unavailable",
      requestHandoff: refused,
      restart: refused,
    };
  }
  journal(): readonly HiredRestartReceipt[] {
    return structuredClone(this.receipts);
  }
  private save(receipt: HiredRestartReceipt): void {
    const index = this.receipts.findIndex((item) => item.id === receipt.id);
    if (index < 0) this.receipts.push(receipt);
    else this.receipts[index] = receipt;
    this.write(this.path, this.receipts);
  }
  private write(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    const file = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(file, JSON.stringify(value));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  private receipt(agent: HerdrAgentSnapshot): HiredRestartReceipt {
    return {
      id: randomUUID(),
      paneId: agent.paneId,
      previousSessionId: nativeSessionId(agent) ?? "unknown",
      at: new Date().toISOString(),
      stage: "refused",
    };
  }
  /** Unknown native state never counts as an idle, empty, original process. */
  private async check(
    runtime: OriginalHiredRuntime,
    guard: HiredRestartGuard,
    sending = false,
  ): Promise<void> {
    if (runtime.launch.harness === "claude") {
      const [cwd, home] = await Promise.all([
        // allow-swallowed-rejection -- an unreadable launch directory refuses trust_required below before any native effect.
        realpath(runtime.launch.cwd).catch(() => undefined),
        // allow-swallowed-rejection -- an unreadable home refuses trust_required below; unknown trust never permits a restart.
        realpath(runtime.launch.env?.HOME ?? homedir()).catch(() => undefined),
      ]);
      if (!cwd || !home || cwd === home) throw new Error("trust_required");
    }
    if (runtime.prepared) throw new Error("prepared_pane_restart_unsupported");
    if (!runtime.proof || runtime.proof.processes.length !== 1)
      throw new Error("original_process_proof_unavailable");
    await runtime.restartView?.guard?.();
    await guard();
    const current = await this.runner.get(runtime.agent.paneId);
    if (
      current.terminalId !== runtime.agent.terminalId ||
      current.agent !== runtime.agent.agent ||
      nativeSessionId(current) !== nativeSessionId(runtime.agent) ||
      !current.session ||
      occupantIdForHerdrSession(current.session) !== runtime.proof.nativeOccupantId
    )
      throw new Error("native_identity_changed");
    if (current.status !== "idle" || (!sending && (await runtime.control.status()) !== "idle"))
      throw new Error("not_idle");
    if (!this.runner.readPane) throw new Error("draft_unknown");
    const draft = paneDraftState(
      current.agent,
      await this.runner.readPane(current.paneId, "visible", "ansi"),
    );
    if (draft !== "empty") throw new Error(draft === "draft" ? "draft" : "draft_unknown");
    const observed = await this.proof(current.paneId);
    if (!observed || observed.nativeSessionPending || !isDeepStrictEqual(runtime.proof, observed))
      throw new Error("process_birth_or_binding_changed");
  }
  async candidates(): Promise<readonly HiredRestartCandidate[]> {
    const candidates: HiredRestartCandidate[] = [];
    for (const runtime of this.originals.values()) {
      // allow-swallowed-rejection -- a failed observation exposes only an unavailable original candidate, never replacement authority.
      const current = await this.runner.get(runtime.agent.paneId).catch(() => undefined);
      const sourceUnproven = !current || nativeSessionId(current) !== nativeSessionId(runtime.agent);
      // A failed observation retains the original receipt's identity for a refusal,
      // never authorizes the pane's unknown or replacement occupant.
      const agent = sourceUnproven ? runtime.agent : current;
      const sessionId = nativeSessionId(agent);
      const pinned =
        (guard: HiredRestartGuard): HiredRestartGuard =>
        async (phase) => {
          if (nativeSessionId(runtime.agent) !== sessionId) throw new Error("original_candidate_changed");
          await guard(phase);
        };
      candidates.push({
        agent,
        originalBrief: runtime.originalBrief,
        workItem: runtime.workItem,
        name: runtime.view.name ?? "",
        workingDirectory: runtime.launch.cwd,
        owner: runtime.owner,
        ...(sourceUnproven ? { unavailableReason: "source_unproven" } : {}),
        requestHandoff: (message, guard, signal) => this.handoff(runtime, message, pinned(guard), signal),
        restart: (brief, guard) => this.restart(runtime, brief, pinned(guard)),
      });
    }
    for (const original of this.provenance) {
      if (this.originals.has(original.paneId)) continue;
      // allow-swallowed-rejection -- an unreadable historical pane is omitted; journal data cannot authorize a restart.
      const agent = await this.runner.get(original.paneId).catch(() => undefined);
      if (!agent || agent.terminalId !== original.terminalId || nativeSessionId(agent) !== original.sessionId)
        continue;
      const refused = () => {
        const receipt = this.receipt(agent);
        receipt.reason = "original_runtime_unavailable_after_service_restart";
        this.save(receipt);
        return { outcome: "refused" as const, receiptId: receipt.id, reason: receipt.reason };
      };
      candidates.push({
        agent,
        originalBrief: original.originalBrief,
        workItem: original.workItem,
        owner: original.owner,
        unavailableReason: "original_runtime_unavailable",
        name: original.name ?? "",
        workingDirectory: original.workingDirectory,
        requestHandoff: async () => refused(),
        restart: async () => refused(),
      });
    }
    return candidates;
  }
  private async handoff(
    runtime: OriginalHiredRuntime,
    message: string,
    guard: HiredRestartGuard,
    signal?: AbortSignal,
  ): Promise<HiredHandoffResult> {
    const receipt = this.receipt(runtime.agent);
    if (this.active.has(receipt.paneId)) {
      receipt.reason = "in_progress";
      this.save(receipt);
      return { outcome: "refused", receiptId: receipt.id, reason: receipt.reason };
    }
    // A missing completion after a send is never permission to repeat it.
    if (
      this.receipts.some(
        (item) =>
          item.paneId === receipt.paneId &&
          item.previousSessionId === receipt.previousSessionId &&
          ["handoff_sending", "handoff_sent", "ending", "launching", "uncertain"].includes(item.stage),
      )
    ) {
      receipt.reason = "unresolved_original_receipt";
      this.save(receipt);
      return { outcome: "refused", receiptId: receipt.id, reason: receipt.reason };
    }
    this.active.add(receipt.paneId);
    try {
      await this.check(runtime, guard);
      receipt.stage = "handoff_sending";
      this.save(receipt);
      const sent = await runtime.control.send(message, {
        beforeDispatch: async () => {
          // Codex marks its controller working while preparing this very send;
          // the native pane still has to prove idle at the mutation boundary.
          await this.check(runtime, guard, true);
          return true;
        },
      });
      if (sent.outcome !== "accepted") throw new Error(`handoff_delivery_${sent.outcome}`);
      receipt.messageId = sent.messageId;
      receipt.stage = "handoff_sent";
      this.save(receipt);
      const timeout = Date.now() + 120_000;
      for (;;) {
        signal?.throwIfAborted();
        const completion = await runtime.control.settled(signal, sent.messageId, receipt.at);
        let text: string | undefined;
        if (completion.type === "turn_completed" && completion.messageId === sent.messageId && completion.ok)
          text = completion.text;
        // Claude does not correlate Stop hooks to channel inputs. Its original delivered
        // transcript ID, main-chain answer, fresh nonce and native Stop together do.
        if (
          runtime.launch.harness === "claude" &&
          completion.type === "settlement_unconfirmed" &&
          completion.observedStop?.ok
        )
          text = this.claudeHandoffReply(
            runtime,
            sent.messageId,
            message,
            receipt.at,
            completion.observedStop,
          );
        if (text?.trim()) {
          receipt.transcriptSha256 = this.fingerprint(runtime);
          receipt.stage = "handoff_complete";
          receipt.handoffBrief = text;
          this.save(receipt);
          return { outcome: "replied", receiptId: receipt.id, text };
        }
        if (!["settlement_unconfirmed", "turn_started"].includes(completion.type) || Date.now() >= timeout)
          throw new Error("handoff_completion_unconfirmed");
        await delay(100, undefined, signal ? { signal } : undefined);
      }
    } catch (error) {
      const uncertain = receipt.stage !== "refused";
      receipt.stage = uncertain ? "uncertain" : "refused";
      receipt.reason = String(error);
      this.save(receipt);
      return { outcome: uncertain ? "uncertain" : "refused", receiptId: receipt.id, reason: receipt.reason };
    } finally {
      this.active.delete(receipt.paneId);
    }
  }
  /** Native content and compaction state; usage-only/lifecycle rows cannot change the handoff. */
  private fingerprint(runtime: OriginalHiredRuntime): string {
    if (!runtime.agent.session) throw new Error("handoff_transcript_unavailable");
    const path = resolveHerdrSeatTranscriptPath(runtime.launch.harness, runtime.agent.session);
    if (!path) throw new Error("handoff_transcript_unavailable");
    const records: unknown[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as Record<string, unknown>;
      const payload = record.payload as Record<string, unknown> | undefined;
      const attachment = record.attachment as Record<string, unknown> | undefined;
      if (
        runtime.launch.harness === "claude"
          ? ["user", "assistant", "summary"].includes(String(record.type)) ||
            record.isCompactSummary === true ||
            (record.type === "system" && /compact/u.test(String(record.subtype))) ||
            (record.type === "attachment" && attachment?.type === "queued_command")
          : record.type === "response_item" ||
            record.type === "compacted" ||
            (record.type === "event_msg" &&
              ["user_message", "agent_message", "context_compacted", "compaction"].includes(
                String(payload?.type),
              ))
      )
        records.push(record);
    }
    if (!records.length) throw new Error("handoff_transcript_content_unavailable");
    return createHash("sha256").update(JSON.stringify(records)).digest("hex");
  }
  private claudeHandoffReply(
    runtime: OriginalHiredRuntime,
    messageId: string,
    message: string,
    armedAt: string,
    stop: { at: string; text?: string },
  ): string | undefined {
    const nonce = message.match(/handoff ID ([a-f0-9-]{36})/u)?.[1];
    if (!runtime.agent.session) return;
    const path = resolveHerdrSeatTranscriptPath("claude", runtime.agent.session);
    if (!nonce || !path || !stop.text?.includes(nonce) || Date.parse(stop.at) < Date.parse(armedAt)) return;
    const entries = parseHerdrSeatTranscript("claude", readFileSync(path, "utf8"), true);
    const index = entries.findIndex(
      (entry) =>
        entry.type === "message" &&
        entry.id === messageId &&
        entry.role === "operator" &&
        entry.internal === true &&
        channelBody(entry.text)?.trim() === message.trim(),
    );
    if (index < 0) return;
    const after = entries.slice(index + 1);
    // Any intervening prompt or channel delivery breaks this single-input proof.
    if (after.some((entry) => entry.type === "message" && entry.role === "operator")) return;
    const reply = after.findLast((entry) => entry.type === "message" && entry.role === "agent");
    if (reply?.type !== "message" || !reply.text.includes(nonce) || reply.text.trim() !== stop.text.trim())
      return;
    return reply.text;
  }
  private async restart(
    runtime: OriginalHiredRuntime,
    handoffBrief: string,
    guard: HiredRestartGuard,
  ): Promise<HiredRestartResult> {
    const receipt = this.receipt(runtime.agent);
    let signalAttempted = false;
    if (this.active.has(receipt.paneId)) {
      receipt.reason = "in_progress";
      this.save(receipt);
      return { outcome: "refused", receiptId: receipt.id, reason: receipt.reason };
    }
    this.active.add(receipt.paneId);
    try {
      if (!handoffBrief.trim() || !runtime.originalBrief.trim() || !runtime.workItem)
        throw new Error("handoff_or_original_work_missing");
      const handoff = this.receipts.findLast(
        (item) =>
          item.paneId === receipt.paneId &&
          item.previousSessionId === receipt.previousSessionId &&
          item.stage === "handoff_complete" &&
          item.handoffBrief &&
          handoffBrief.includes(item.handoffBrief),
      );
      if (!handoff?.transcriptSha256) throw new Error("original_handoff_receipt_missing");
      const unchangedHandoff = () => {
        if (this.fingerprint(runtime) !== handoff.transcriptSha256) throw new Error("handoff_superseded");
      };
      if (
        this.receipts.some(
          (item) =>
            item.paneId === receipt.paneId &&
            item.previousSessionId === receipt.previousSessionId &&
            ["handoff_sending", "handoff_sent", "ending", "launching", "restarted", "uncertain"].includes(
              item.stage,
            ),
        )
      )
        throw new Error("unresolved_original_receipt");
      unchangedHandoff();
      // The same launch object reaches adapter admission and startup; no new selection
      // or policy decision is made after ending the original native process.
      const { resumeSessionId: _resume, ...launch } = runtime.launch;
      const successorLaunch: SeatLaunch = {
        ...launch,
        brief: `${runtime.originalBrief}\n\nFresh-session handoff for ${runtime.workItem}:\n${handoffBrief}`,
      };
      await this.check(runtime, guard);
      await runtime.adapter.admitRestart?.(successorLaunch);
      await runtime.admitRestart();
      receipt.handoffBrief = handoffBrief;
      receipt.previousProof = ProjectHireProcessProofSchema.parse(runtime.proof);
      receipt.stage = "ending";
      this.save(receipt);
      await this.check(runtime, guard);
      unchangedHandoff();
      signalAttempted = true;
      this.signal(runtime.proof!.processes[0]!.pid);
      const exitBy = Date.now() + 15_000;
      for (;;) {
        const shell = await this.runner.paneShell?.(receipt.paneId);
        if (!shell || shell.shellPid !== runtime.proof!.shell.pid)
          throw new Error("original_shell_unavailable");
        if (shell.foreground.length > 0 && shell.foreground.every((item) => item.pid === shell.shellPid))
          break;
        if (Date.now() >= exitBy) throw new Error("original_native_exit_unconfirmed");
        await delay(100);
      }
      const birth = await observeNativeBirth(runtime.proof!.shell.pid);
      if (!birth || nativeProcessStart(birth) !== runtime.proof!.shell.startTime)
        throw new Error("original_shell_birth_unconfirmed");
      await runtime.control.close();
      receipt.stage = "launching";
      this.save(receipt);
      // Original launch is reused verbatim except for the deliberately fresh session and first prompt.
      const restartView = runtime.restartView ?? runtime.view;
      const start = await runtime.adapter.start(successorLaunch, {
        ...restartView,
        guard: async () => {
          await guard("successor");
          await restartView.guard?.();
        },
        bound: async (ref) => {
          await guard("successor");
          const next = await this.runner.get(receipt.paneId);
          const proof = await this.proof(receipt.paneId);
          if (
            ref.paneId !== receipt.paneId ||
            ref.harness !== runtime.launch.harness ||
            ref.sessionId === receipt.previousSessionId ||
            nativeSessionId(next) !== ref.sessionId ||
            !proof ||
            proof.nativeSessionPending ||
            proof.processes.length !== 1 ||
            !next.session ||
            proof.nativeOccupantId !== occupantIdForHerdrSession(next.session) ||
            proof.shell.pid !== runtime.proof!.shell.pid ||
            proof.shell.startTime !== runtime.proof!.shell.startTime
          )
            throw new Error("successor_identity_unconfirmed");
          await runtime.successor(runtime.agent, next, proof, receipt.id);
        },
      });
      if (start.outcome !== "started") throw new Error(`successor_start_${start.outcome}`);
      const next = await this.runner.get(receipt.paneId);
      const proof = await this.proof(receipt.paneId);
      if (
        !proof ||
        nativeSessionId(next) !== start.control.ref.sessionId ||
        start.control.ref.sessionId === receipt.previousSessionId
      )
        throw new Error("successor_binding_unconfirmed");
      runtime.agent = next;
      runtime.control = start.control;
      runtime.proof = proof;
      this.register(runtime);
      receipt.stage = "restarted";
      receipt.sessionId = start.control.ref.sessionId;
      this.save(receipt);
      return { outcome: "restarted", receiptId: receipt.id, sessionId: receipt.sessionId };
    } catch (error) {
      const uncertain = signalAttempted;
      receipt.stage = uncertain ? "uncertain" : "refused";
      receipt.reason = String(error);
      this.save(receipt);
      return { outcome: uncertain ? "uncertain" : "refused", receiptId: receipt.id, reason: receipt.reason };
    } finally {
      this.active.delete(receipt.paneId);
    }
  }
}
