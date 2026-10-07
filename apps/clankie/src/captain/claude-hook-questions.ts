import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { SeatQuestion, SeatQuestionAnswer, SeatQuestionResult, SeatRef } from "@clankie/agent-hosts";
import type { FleetSeatHook } from "@clankie/protocol";
import { redactSensitiveText } from "@clankie/observability";
import { SeatQuestionAnswerSchema } from "./codex-user-input.ts";

const AskInputSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            question: z.string().min(1).max(4000),
            header: z.string().max(200),
            options: z
              .array(
                z
                  .object({ label: z.string().min(1).max(500), description: z.string().max(2000) })
                  .passthrough(),
              )
              .min(2)
              .max(4),
            multiSelect: z.boolean().optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(4),
  })
  .passthrough();

export interface ClaudeHookAnswer {
  /** Internal delivery correlation; the command emits only hookSpecificOutput to Claude. */
  readonly requestId?: string;
  readonly hookSpecificOutput: {
    readonly hookEventName: "PreToolUse" | "PermissionRequest";
    readonly permissionDecision?: "allow" | "deny";
    readonly permissionDecisionReason?: string;
    readonly updatedInput?: Record<string, unknown>;
    readonly decision?: { readonly behavior: "allow" | "deny"; readonly message?: string };
  };
}

interface Pending {
  readonly ref: SeatRef;
  readonly hook: FleetSeatHook;
  readonly question: SeatQuestion;
  readonly multiple: readonly boolean[];
  readonly resolve: (answer: ClaudeHookAnswer) => void;
  readonly cleanup: () => void;
  answering: boolean;
}

function sameSeat(left: SeatRef, right: SeatRef): boolean {
  return left.harness === right.harness && left.paneId === right.paneId && left.sessionId === right.sessionId;
}

function denied(hook: FleetSeatHook, message: string): ClaudeHookAnswer {
  return hook.event === "PermissionRequest"
    ? { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } }
    : {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: message,
        },
      };
}

/** A live command hook is the harness answer channel; no pane input is involved. */
export class ClaudeHookQuestions {
  private readonly requests = new Map<string, Pending>();
  private readonly receipts = new Map<
    string,
    { readonly ref: SeatRef; readonly settle: (received: boolean) => void }
  >();
  private readonly used = new Set<string>();

  private readonly path: string;
  private readonly timeoutMs: number;
  private readonly receiptMs: number;
  constructor(path: string, timeoutMs = 9 * 60_000, receiptMs = 5000) {
    this.path = path;
    this.timeoutMs = timeoutMs;
    this.receiptMs = receiptMs;
    if (existsSync(path)) {
      const ids = z.array(z.string()).parse(JSON.parse(readFileSync(path, "utf8")));
      for (const id of ids) this.used.add(id);
    }
  }

  pending(ref: SeatRef, requestId: string | number): SeatQuestion | undefined {
    const pending = this.requests.get(String(requestId));
    return pending && !pending.answering && sameSeat(ref, pending.ref)
      ? structuredClone(pending.question)
      : undefined;
  }

  /** Accepted only from the authenticated command after its stdout write completed. */
  acknowledge(ref: SeatRef, requestId: string): boolean {
    const receipt = this.receipts.get(requestId);
    if (!receipt || !sameSeat(ref, receipt.ref)) return false;
    receipt.settle(true);
    return true;
  }

  async open(
    ref: SeatRef,
    hook: FleetSeatHook,
    notify: (question: SeatQuestion) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<ClaudeHookAnswer> {
    if (
      ref.harness !== "claude" ||
      ref.sessionId !== hook.sessionId ||
      !hook.toolUseId ||
      (hook.event !== "PermissionRequest" &&
        !(hook.event === "PreToolUse" && hook.toolName === "AskUserQuestion"))
    )
      return denied(hook, "claude_hook_question_invalid");
    const input = structuredClone(hook.toolInput ?? {});
    const id = `claude-hook:${createHash("sha256")
      .update(JSON.stringify([ref.paneId, ref.sessionId, hook.event, hook.toolUseId]))
      .digest("hex")}`;
    if (this.used.has(id) || this.requests.has(id))
      return denied(hook, "claude_hook_question_already_resolved_or_pending");
    let questions: SeatQuestion["questions"];
    let multiple: readonly boolean[];
    if (hook.event === "PermissionRequest") {
      questions = [
        {
          id: "q0",
          header: "Permission",
          question: redactSensitiveText(`Allow ${hook.toolName ?? "tool"}?\n${JSON.stringify(input)}`),
          isOther: false,
          isSecret: false,
          options: [
            { label: "Allow", description: "Allow this tool invocation once." },
            { label: "Deny", description: "Refuse this tool invocation." },
          ],
        },
      ];
      if (questions[0]!.question.length > 4000) return denied(hook, "claude_hook_permission_input_too_large");
      multiple = [false];
    } else {
      const parsed = AskInputSchema.safeParse(input);
      if (
        !parsed.success ||
        new Set(parsed.data.questions.map((q) => q.question)).size !== parsed.data.questions.length ||
        parsed.data.questions.some(
          (q) => new Set(q.options.map((option) => option.label)).size !== q.options.length,
        )
      )
        return denied(hook, "claude_hook_question_input_invalid_or_ambiguous");
      questions = parsed.data.questions.map((q, index) => ({
        id: `q${index}`,
        header: q.header,
        question: q.question,
        isOther: true,
        isSecret: false,
        options: q.options.map(({ label, description }) => ({ label, description })),
      }));
      multiple = parsed.data.questions.map((q) => q.multiSelect === true);
    }
    const gate =
      hook.event === "PermissionRequest"
        ? ["Read", "Edit", "Write", "Glob", "Grep"].includes(hook.toolName ?? "")
          ? "everydayWork"
          : ["WebFetch", "WebSearch"].includes(hook.toolName ?? "")
            ? "leavesMac"
            : "moneyAndAccounts"
        : "everydayWork";
    const question: SeatQuestion = {
      gate,
      requestId: id,
      turnId: hook.sessionId,
      itemId: hook.toolUseId,
      isBlocking: true,
      questions,
    };
    const snapshot: FleetSeatHook = { ...hook, toolInput: input };
    let pending!: Pending;
    const result = new Promise<ClaudeHookAnswer>((resolve) => {
      const abort = () => this.finish(pending, denied(snapshot, "claude_hook_question_cancelled"));
      const timer = setTimeout(
        () => this.finish(pending, denied(snapshot, "claude_hook_question_expired")),
        this.timeoutMs,
      );
      timer.unref();
      pending = {
        ref: { ...ref },
        hook: snapshot,
        question,
        multiple,
        resolve,
        answering: false,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      this.requests.set(id, pending);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (this.requests.has(id))
      void Promise.resolve()
        .then(() => notify(structuredClone(question)))
        .catch(() => {
          this.finish(pending, denied(snapshot, "claude_hook_question_notify_failed"));
        });
    return result;
  }

  async answer(
    ref: SeatRef,
    answer: SeatQuestionAnswer,
    beforeDispatch?: () => Promise<void>,
  ): Promise<SeatQuestionResult> {
    const parsed = SeatQuestionAnswerSchema.safeParse(answer);
    if (!parsed.success) return { outcome: "refused", detail: "native_question_answer_invalid" };
    answer = parsed.data;
    const pending = this.requests.get(String(answer.requestId));
    if (!pending || pending.answering || !sameSeat(ref, pending.ref))
      return { outcome: "refused", detail: "native_question_already_resolved_or_unknown" };
    const ids = pending.question.questions.map((q) => q.id);
    if (
      ids.length !== Object.keys(answer.answers).length ||
      ids.some((id) => !Object.hasOwn(answer.answers, id))
    )
      return { outcome: "refused", detail: "native_question_answer_ids_mismatch" };
    for (const [index, q] of pending.question.questions.entries()) {
      const values = answer.answers[q.id]!.answers;
      if (
        values.some((value) => value.trim().length === 0) ||
        new Set(values).size !== values.length ||
        (!pending.multiple[index] && values.length !== 1) ||
        (!q.isOther && values.some((value) => !q.options?.some((option) => option.label === value)))
      )
        return { outcome: "refused", detail: "native_question_answer_choices_invalid" };
    }
    pending.answering = true;
    try {
      await beforeDispatch?.();
      if (this.requests.get(String(answer.requestId)) !== pending)
        return { outcome: "refused", detail: "native_question_already_resolved_or_unknown" };
      this.remember(String(answer.requestId));
    } catch (error) {
      pending.answering = false;
      return { outcome: "refused", detail: String(error) };
    }
    let response: ClaudeHookAnswer;
    if (pending.hook.event === "PermissionRequest") {
      const allow = answer.answers.q0!.answers[0] === "Allow";
      response = {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: allow
            ? { behavior: "allow" }
            : { behavior: "deny", message: "Permission refused through the harness channel." },
        },
      };
    } else {
      const answers = Object.fromEntries(
        pending.question.questions.map((q) => [q.question, answer.answers[q.id]!.answers.join(", ")]),
      );
      response = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { ...pending.hook.toolInput, answers },
        },
      };
    }
    const id = String(answer.requestId);
    const received = new Promise<boolean>((resolve) => {
      const settle = (value: boolean) => {
        if (!this.receipts.has(id)) return;
        this.receipts.delete(id);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => settle(false), this.receiptMs);
      timer.unref();
      this.receipts.set(id, { ref: pending.ref, settle });
    });
    this.finish(pending, { ...response, requestId: id });
    return (await received)
      ? { outcome: "answered", deliveryStage: "responded" }
      : { outcome: "unconfirmed", detail: "claude_hook_answer_stdout_unconfirmed: consumed; do not retry" };
  }

  cancel(ref: SeatRef, reason = "claude_hook_question_session_closed"): void {
    for (const pending of this.requests.values())
      if (sameSeat(ref, pending.ref)) this.finish(pending, denied(pending.hook, reason));
    for (const receipt of this.receipts.values()) if (sameSeat(ref, receipt.ref)) receipt.settle(false);
  }

  private remember(id: string): void {
    const ids = [...this.used, id];
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(ids), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.used.add(id);
  }

  private finish(pending: Pending, response: ClaudeHookAnswer): void {
    const id = String(pending.question.requestId);
    if (this.requests.get(id) !== pending) return;
    // Expiry/cancellation also consumes the request; a restarted host must not approve a replay.
    if (!this.used.has(id)) {
      try {
        this.remember(id);
      } catch {
        response = denied(pending.hook, "claude_hook_question_persistence_failed");
        this.used.add(id);
      }
    }
    this.requests.delete(id);
    pending.cleanup();
    pending.resolve(response);
  }
}
