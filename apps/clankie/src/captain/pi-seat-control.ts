import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SeatControl, SeatEvent, SeatRef, SeatProcessIdentity } from "@clankie/agent-hosts";
import type { PiWorkerController } from "./pi-worker-controller.ts";
import type { PreparedNativeRoot, PreparedNativeSession } from "./prepared-native-host.ts";
const SEND_RECEIPT_MS = 30_000;
const Status = z.enum(["idle", "working", "blocked"]);
const Delivery = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("accepted"), messageId: z.string().uuid(), state: z.literal("started") }),
  z.object({ outcome: z.literal("unconfirmed"), messageId: z.string().uuid(), detail: z.string() }),
  z.object({ outcome: z.literal("unavailable"), detail: z.string() }),
]);

/** Shared native delivery path for prepared hires and independently admitted hand-opened sessions. */
export function createPiSeatControl({
  selected,
  native,
  verify,
  root,
  descriptor,
  dispose,
  ...deps
}: {
  selected: SeatRef;
  native: PiWorkerController;
  verify(ref: SeatRef): Promise<SeatProcessIdentity>;
  root: PreparedNativeRoot;
  descriptor: PreparedNativeSession;
  dispose(): Promise<void>;
  timeoutMs: number | undefined;
}): SeatControl {
  let lastMessageId: string | undefined;
  const control: SeatControl = {
    ref: selected,
    verify: () => verify(selected),
    async status() {
      try {
        await verify(selected);
        const status = Status.parse(await native.request("status"));
        await root!.report(descriptor!, status);
        return status;
      } catch {
        return "offline";
      }
    },
    async send(text, options) {
      const earlier = native.pending();
      if (earlier)
        return {
          outcome: "unconfirmed",
          messageId: earlier.messageId,
          deliveryStage: "uncertain",
          detail: "Original native delivery remains uncertain; no resend",
        };
      const messageId = randomUUID();
      let attempted = false;
      try {
        await verify(selected);
        attempted = true;
        const result = Delivery.parse(
          await native.request(
            "send",
            {
              messageId,
              text,
              deliverAs: "followUp",
              timeoutMs: options?.timeoutMs ?? deps.timeoutMs ?? SEND_RECEIPT_MS,
            },
            (options?.timeoutMs ?? deps.timeoutMs ?? SEND_RECEIPT_MS) + 1000,
            options?.beforeDispatch,
          ),
        );
        if (result.outcome === "unavailable")
          return { outcome: "offline", detail: result.detail, deliveryStage: "unavailable" };
        if (result.messageId !== messageId) throw new Error("Native Pi receipt mismatch");
        lastMessageId = messageId;
        if (result.outcome === "accepted") {
          await verify(selected);
          await native.acknowledge(messageId);
        }
        return {
          ...result,
          deliveryStage: result.outcome === "accepted" ? "consumed" : "uncertain",
        };
      } catch {
        if (!attempted)
          return {
            outcome: "offline",
            detail: "Original native Pi control unavailable before dispatch",
            deliveryStage: "unavailable",
          };
        return {
          outcome: "unconfirmed",
          messageId,
          detail: "Native Pi delivery unconfirmed; inspect original session before retrying",
          deliveryStage: "uncertain",
        };
      }
    },
    async settled(abort): Promise<SeatEvent> {
      while (true) {
        abort?.throwIfAborted();
        const state = await control.status();
        const at = new Date().toISOString();
        if (state === "offline") return { type: "released", at };
        if (state === "blocked")
          return { type: "blocked", at, reason: "A native Pi owner decision is pending" };
        if (state === "idle") {
          try {
            const result = z
              .discriminatedUnion("state", [
                z.object({ state: z.literal("pending") }),
                z.object({
                  state: z.literal("completed"),
                  ok: z.boolean(),
                  text: z.string().max(32_768),
                  stopReason: z.string(),
                }),
              ])
              .parse(await native.request("settlement", { messageId: lastMessageId }));
            if (result.state === "completed") {
              await verify(selected);
              return {
                type: "turn_completed",
                at,
                ok: result.ok,
                text: result.text,
                stopReason: result.stopReason,
                ...(lastMessageId ? { messageId: lastMessageId } : {}),
              };
            }
          } catch {
            return { type: "released", at };
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    async interrupt() {
      try {
        await verify(selected);
        return (await native.request("interrupt", { timeoutMs: deps.timeoutMs ?? 10_000 })) === true;
      } catch {
        return false;
      }
    },
    close: dispose,
  };

  return control;
}
