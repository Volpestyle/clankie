import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CaptainPort, LaneTool, LaneToolBank } from "./captain/port.ts";
import type { MachineJoins, JoinedSeatMachine } from "./machine-joins.ts";
import type { RemoteSeatAuthority } from "./remote-lead-bridge.ts";
import { SeatOutbox } from "./captain/seat-outbox.ts";
import { JoinedWorkerLaunchSchema } from "@clankie/protocol/machine-join";

const Hire = z.strictObject({
  title: z.string().min(1).max(128),
  brief: z
    .string()
    .min(1)
    .max(32_768)
    .refine(
      (text) => !text.includes("\0") && Buffer.byteLength(text) <= 32_768,
      "Brief must be at most 32768 UTF-8 bytes, without NUL",
    ),
  workingDirectory: z.string().min(1).max(4096).optional(),
  harness: z.literal("claude").optional(),
  model: z.string().min(1).max(128).optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
});
const Message = z.strictObject({ text: z.string().min(1).max(16_384), deliveryId: z.uuid() });
const Status = z.strictObject({ deliveryId: z.uuid() });
const reply = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }] });
const tool = (name: string, description: string, schema: z.ZodType, call: LaneTool["call"]): LaneTool => ({
  name,
  description,
  inputSchema: { ...z.toJSONSchema(schema), type: "object" },
  call,
});
interface Worker extends RemoteSeatAuthority {
  machineId: string;
  directory: string;
  sessionId: string;
  token: string;
  paneId?: string;
  abort: AbortController;
  outbox: SeatOutbox;
  touchedAt: number;
}

/** A lead grants one native worker on its joined machine; no fleet bearer or SSH identity. */
export function createJoinedWorkers(input: { captain: CaptainPort; joins: MachineJoins }) {
  const workers = new Map<string, Worker>();
  const close = (worker: Worker) => {
    workers.delete(worker.token);
    worker.abort.abort();
    worker.outbox.close();
  };
  const authority = async (token: string, machine?: JoinedSeatMachine) => {
    const worker = workers.get(token);
    if (
      !worker ||
      (machine !== undefined && worker.machineId !== machine.machineId) ||
      !(await worker.authorize())
    )
      return undefined;
    worker.touchedAt = Date.now();
    return worker;
  };
  const admit = async (worker: Worker, raw: unknown) => {
    const value = z.strictObject({ paneId: z.string().min(1).max(256), sessionId: z.uuid() }).parse(raw);
    if (value.sessionId !== worker.sessionId || (worker.paneId && worker.paneId !== value.paneId))
      throw Error("joined_worker_session_mismatch");
    // Only the approved machine's native adapter observes and admits this launch.
    worker.paneId = value.paneId;
    return { admitted: true };
  };
  const tools =
    (lead: RemoteSeatAuthority, machine: JoinedSeatMachine, directory: string, maximumTrust: boolean) =>
    async (bank: LaneToolBank): Promise<LaneToolBank> => ({
      ...bank,
      tools: [
        ...bank.tools.filter((entry) => entry.name !== "hire_agent" && entry.name !== "message_seat"),
        tool(
          "hire_agent",
          "Launch an interactive Claude worker in Herdr on this joined machine, bound to this folder and lead chat. Other directories and harnesses require their own joined lead. A lost reply never authorizes another hire.",
          Hire,
          async (args) => {
            const hire = Hire.parse(args);
            if (hire.workingDirectory !== undefined && hire.workingDirectory !== directory)
              throw Error("joined_worker_directory_mismatch");
            if (!lead.current() || !(await lead.authorize())) throw Error("joined_seat_revoked");
            for (const worker of workers.values()) if (!worker.current()) close(worker);
            if (workers.size >= 128) throw Error("joined_worker_capacity");
            const token = randomBytes(32).toString("base64url"),
              sessionId = randomUUID();
            const abort = new AbortController(),
              outbox = new SeatOutbox({ explicitAcknowledgments: true });
            const binding = createHash("sha256")
              .update(JSON.stringify([machine.machineId, sessionId, lead.binding.conversationId]))
              .digest("hex");
            const worker: Worker = {
              id: randomUUID(),
              token,
              sessionId,
              machineId: machine.machineId,
              directory,
              abort,
              outbox,
              worker: true,
              binding: { conversationId: lead.binding.conversationId, nativeOccupantId: binding },
              signal: abort.signal,
              touchedAt: Date.now(),
              current: () =>
                workers.get(token) === worker &&
                !abort.signal.aborted &&
                Date.now() - worker.touchedAt < 60 * 60_000,
              authorize: async () => {
                try {
                  await machine.authorize();
                  return (
                    worker.current() &&
                    input.captain.seatContext(worker.binding.conversationId)?.machineId === machine.machineId
                  );
                } catch {
                  close(worker);
                  return false;
                }
              },
              pollEvents: async (wait, signal) => {
                if (!worker.paneId) return [];
                return outbox.poll(wait, signal, binding);
              },
              acknowledge: async (id) => outbox.acknowledge(id, binding),
              toolBank: async () => ({
                lane: "operator",
                tools: [
                  tool(
                    "message_clankie",
                    "Send agent output to your hiring lead chat. Choose a deliveryId once and retain it; after uncertainty read message_clankie_status, never resend with a new ID.",
                    Message,
                    async (args) => {
                      const message = Message.parse(args);
                      if (!worker.paneId) throw Error("joined_worker_not_admitted");
                      if (!input.captain.receiveJoinedWorkerReport)
                        throw Error("joined_worker_reports_unavailable");
                      const result = await input.captain.receiveJoinedWorkerReport(
                        {
                          paneId: `${machine.machineId}/${worker.paneId}`,
                          binding,
                          conversationId: worker.binding.conversationId,
                          text: message.text,
                          deliveryId: message.deliveryId,
                        },
                        {
                          owner: { conversationId: worker.binding.conversationId },
                          current: worker.current,
                          authorize: worker.authorize,
                        },
                      );
                      return reply(result);
                    },
                  ),
                  tool(
                    "message_clankie_status",
                    "Read the original report delivery by its deliveryId. Never resends or marks it read.",
                    Status,
                    async (args) => {
                      const { deliveryId } = Status.parse(args);
                      return reply(
                        worker.paneId
                          ? ((await input.captain.joinedWorkerReportStatus?.(
                              `${machine.machineId}/${worker.paneId}`,
                              binding,
                              deliveryId,
                            )) ?? { stage: "unknown" })
                          : { stage: "unknown" },
                      );
                    },
                  ),
                ],
              }),
            };
            workers.set(token, worker);
            const launch = JoinedWorkerLaunchSchema.parse({
              token,
              sessionId,
              conversationId: worker.binding.conversationId,
              title: hire.title,
              brief: hire.brief,
              maximumTrust,
              ...(hire.model ? { model: hire.model } : {}),
              ...(hire.effort ? { effort: hire.effort } : {}),
            });
            try {
              const result = await input.joins.request(
                machine.machineId,
                { kind: "workers", directory, request: JSON.stringify(launch) },
                90_000,
              );
              if (!result.ok)
                return reply({
                  outcome: "unconfirmed",
                  sessionId,
                  detail: result.error,
                  advice: "Inspect the joined machine; do not repeat this hire.",
                });
              return reply({
                outcome: worker.paneId ? "started" : "unconfirmed",
                seatId: worker.paneId ? `${machine.machineId}/${worker.paneId}` : undefined,
                sessionId,
                conversationId: worker.binding.conversationId,
                detail: result.output,
              });
            } catch (error) {
              return reply({
                outcome: "unconfirmed",
                sessionId,
                detail: error instanceof Error ? error.message : String(error),
                advice: "Inspect the joined machine; do not repeat this hire.",
              });
            }
          },
        ),
        tool(
          "message_seat",
          "Send to one of this joined lead's workers by the exact seatId returned by hire_agent. Uses its native join channel, never terminal typing.",
          z.strictObject({ seat: z.string().min(1), message: z.string().min(1).max(16_384) }),
          async (args) => {
            const worker = [...workers.values()].find(
              (worker) =>
                `${worker.machineId}/${worker.paneId}` === args.seat &&
                worker.binding.conversationId === lead.binding.conversationId,
            );
            if (!worker || !(await worker.authorize())) throw Error("joined_worker_unknown");
            const result = await worker.outbox.deliver({
              kind: "message",
              conversationId: worker.binding.conversationId,
              source: "clankie",
              content: String(args.message),
              wantsReply: false,
              recipientBinding: worker.binding.nativeOccupantId,
              signal: worker.signal,
            });
            if (result.outcome === "delivered" && lead.current() && (await worker.authorize()))
              input.captain.recordJoinedWorkerReply?.(
                worker.binding.conversationId,
                `${worker.machineId}/${worker.paneId}`,
                worker.binding.nativeOccupantId,
              );
            return reply(result);
          },
        ),
      ],
    });
  return {
    authority,
    admit,
    tools,
    revokeConversation: (id: string) => {
      for (const worker of workers.values()) if (worker.binding.conversationId === id) close(worker);
    },
    close: () => {
      for (const worker of workers.values()) close(worker);
    },
  };
}
