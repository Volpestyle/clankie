import { isDeepStrictEqual } from "node:util";
import type { SeatControl, SeatRef, SeatQuestionResult, SeatQuestionAnswer } from "@clankie/agent-hosts";
import type WebSocket from "ws";
import { CodexAppServerClient } from "./codex-app-server.ts";
import { codexAsyncQuestionAnswer, recordedCodexAsyncAnswer } from "./codex-user-input.ts";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const questionKey = (ref: SeatRef, answer: SeatQuestionAnswer) =>
  JSON.stringify(["codex-question", ref.paneId, ref.sessionId, typeof answer.requestId, answer.requestId]);
const heldAnswer = (fence: DeliveryFence, key: string): SeatQuestionResult | undefined => {
  if (fence.pending(key))
    return { outcome: "unconfirmed", detail: "Original native answer is uncertain; no replacement was sent" };
  if (fence.completed(key))
    return {
      outcome: "refused",
      detail: "Original native answer already delivered; no replacement was sent",
    };
  return undefined;
};

/** Live-controller and reconnected async answers share the same durable claim. */
export function guardedCodexQuestions(
  control: SeatControl,
  fence: DeliveryFence,
): Pick<SeatControl, "pendingQuestion" | "answerQuestion" | "status"> {
  return {
    status: () => control.status(),
    pendingQuestion: (id) => control.pendingQuestion!(id),
    async answerQuestion(answer, guard) {
      const key = questionKey(control.ref, answer);
      const held = heldAnswer(fence, key);
      if (held) return held;
      const pending = await control.pendingQuestion!(answer.requestId);
      if (pending?.delivery !== "async") return control.answerQuestion!(answer, guard);
      let receiptId: string | undefined;
      try {
        const result = await control.answerQuestion!(answer, async () => {
          await guard?.();
          // Native validation runs before this guard. Claim once, before any answer input.
          receiptId ??= fence.begin(key, {
            fingerprint: deliveryFingerprint(JSON.stringify(answer)),
            sessionId: control.ref.sessionId,
            paneId: control.ref.paneId,
          }).messageId;
        });
        if (receiptId && result.outcome === "answered")
          fence.complete(key, receiptId, { deliveryStage: "responded" });
        else if (receiptId && (result.outcome === "refused" || result.outcome === "offline"))
          fence.reconcile(key, receiptId);
        return result;
      } catch (error) {
        return { outcome: receiptId ? "unconfirmed" : "refused", detail: String(error) };
      }
    },
  };
}

/** Question-only reconnection. Never launches, resumes, queues or interrupts a worker. */
export function externalCodexQuestions(
  ref: SeatRef,
  connect: () => Promise<WebSocket | undefined>,
  assertCurrent: () => Promise<void>,
  fence: DeliveryFence,
): Pick<SeatControl, "pendingQuestion" | "answerQuestion" | "status"> {
  const connected = async <T>(run: (client: CodexAppServerClient) => Promise<T>): Promise<T> => {
    await assertCurrent();
    const socket = await connect();
    if (!socket) throw new Error("Original Codex question socket is unavailable");
    const client = new CodexAppServerClient(socket, () => {});
    try {
      await client.initialize(true);
      const loaded = object(await client.request("thread/loaded/list", {}));
      // thread/read can also read disk history. Only the original loaded thread is answerable.
      if (!Array.isArray(loaded.data) || !loaded.data.includes(ref.sessionId))
        throw new Error("Original Codex question thread is not loaded");
      await assertCurrent();
      return await run(client);
    } finally {
      client.close();
    }
  };
  const read = async (client: CodexAppServerClient) => {
    const value = await client.request("thread/read", { threadId: ref.sessionId, includeTurns: true });
    const thread = object(object(value).thread);
    if (thread.id !== ref.sessionId || !Array.isArray(thread.turns))
      throw new Error("Original Codex question thread identity is unavailable");
    client.hydrateQuestions(ref.sessionId, value);
    return { value, thread };
  };
  return {
    pendingQuestion: (requestId) =>
      connected(async (client) => {
        await read(client);
        return client.pendingQuestion(ref.sessionId, requestId);
      }),
    status: () =>
      connected(async (client) => {
        const { thread } = await read(client);
        const status = object(thread.status);
        if (status.type === "idle") return "idle";
        if (status.type === "active")
          return client.hasPendingBlockingQuestion(ref.sessionId) ? "blocked" : "working";
        return "offline";
      }),
    async answerQuestion(answer, guard): Promise<SeatQuestionResult> {
      const key = questionKey(ref, answer);
      const held = heldAnswer(fence, key);
      if (held) return held;
      let attempted = false;
      try {
        return await connected(async (client) => {
          await read(client);
          if (!client.isAsyncQuestion(ref.sessionId, answer.requestId))
            return {
              outcome: "refused",
              detail:
                "Native async question resolved or unavailable; synchronous requests need their original controller",
            };
          const result = await client.answerQuestion(ref.sessionId, answer, guard, async (question) => {
            const { thread } = await read(client);
            const pending = client.pendingQuestion(ref.sessionId, answer.requestId);
            if (
              !pending ||
              !isDeepStrictEqual(pending.questions, question.questions) ||
              client.hasPendingBlockingQuestion(ref.sessionId)
            )
              throw new Error(
                "Native question changed or a blocking request needs its original controller; nothing was sent",
              );
            const status = object(thread.status);
            if (
              !["active", "idle"].includes(String(status.type)) ||
              (Array.isArray(status.activeFlags) &&
                status.activeFlags.some((flag) => /waiting/iu.test(String(flag))))
            )
              throw new Error("Original native thread is not ready for an async answer; nothing was sent");
            const turns = (thread.turns as unknown[]).map(object);
            const active = turns.filter((turn) => turn.status === "inProgress");
            if (
              active.length > 1 ||
              (status.type === "active" && (active.length !== 1 || typeof active[0]!.id !== "string")) ||
              (status.type === "idle" && active.length !== 0)
            )
              throw new Error("Original native turn identity is unavailable; nothing was sent");
            await guard?.();
            await assertCurrent();
            const text = codexAsyncQuestionAnswer(question, answer);
            const receipt = fence.begin(key, {
              fingerprint: deliveryFingerprint(text),
              sessionId: ref.sessionId,
              paneId: ref.paneId,
            });
            attempted = true;
            const clientUserMessageId = receipt.messageId;
            const turn = active[0];
            const response = object(
              await client.request(turn ? "turn/steer" : "turn/start", {
                threadId: ref.sessionId,
                input: [{ type: "text", text, text_elements: [] }],
                clientUserMessageId,
                ...(turn ? { expectedTurnId: turn.id } : {}),
              }),
            );
            const turnId = turn ? response.turnId : object(response.turn).id;
            if (typeof turnId !== "string" || (turn && turnId !== turn.id))
              throw new Error("Native answer turn receipt is unconfirmed; do not resend");
            return { text, clientUserMessageId, turnId };
          });
          if (result.outcome !== "dispatched")
            return result.outcome === "unconfirmed" && !attempted
              ? { outcome: "refused", detail: result.detail }
              : result.outcome === "resolved"
                ? {
                    outcome: "unconfirmed",
                    detail: "Original synchronous answer receipt needs its native controller",
                  }
                : result;
          const deadline = Date.now() + 2_000;
          while (Date.now() < deadline) {
            const record = await client.request(
              "thread/read",
              { threadId: ref.sessionId, includeTurns: true },
              Math.max(1, deadline - Date.now()),
            );
            const confirmation = recordedCodexAsyncAnswer(record, ref.sessionId, result);
            if (confirmation === "answered_concurrently_by_owner")
              return { outcome: "unconfirmed", detail: "answered_concurrently_by_owner" };
            if (confirmation === "accepted") {
              fence.complete(key, result.clientUserMessageId, { deliveryStage: "responded" });
              return { outcome: "answered", deliveryStage: "responded" };
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return { outcome: "unconfirmed", detail: "native_async_answer_input_unobserved: do not resend" };
        });
      } catch (error) {
        return { outcome: attempted ? "unconfirmed" : "refused", detail: String(error) };
      }
    },
  };
}
