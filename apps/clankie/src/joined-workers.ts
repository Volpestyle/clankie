import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CaptainPort, LaneTool, LaneToolBank } from "./captain/port.ts";
import type { MachineJoins, JoinedSeatMachine, JoinedWorkerHireRequest } from "./machine-joins.ts";
import { posix, win32 } from "node:path";
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
const Message = z.strictObject({
  text: z.string().min(1).max(16_384),
  deliveryId: z.uuid(),
  urgent: z
    .boolean()
    .optional()
    .describe(
      "True when you are blocked, something failed, or you need a decision: your lead hears it at once. Otherwise it reaches an idle lead with its next round of reports.",
    ),
});
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
  /** Settles when the machine's adapter admits the native session. */
  admitted: Promise<void>;
  markAdmitted: () => void;
  abort: AbortController;
  outbox: SeatOutbox;
  touchedAt: number;
}

/** How long a launch request, and a report racing its admission, may wait. */
const LAUNCH_MS = 90_000;

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
    worker.markAdmitted();
    return { admitted: true };
  };
  /**
   * Launch one native worker on a joined machine, bound to a lead conversation.
   * `led` says whether that conversation still leads it; the lead tool and a
   * hire Clankie starts himself (VUH-2607) differ only there.
   */
  const launch = async (args: {
    machine: JoinedSeatMachine;
    directory: string;
    conversationId: string;
    title: string;
    brief: string;
    model?: string;
    effort?: "low" | "medium" | "high" | "max";
    maximumTrust: boolean;
    led: () => boolean;
  }) => {
    const { machine, directory } = args;
    for (const worker of workers.values()) if (!worker.current()) close(worker);
    if (workers.size >= 128) throw Error("joined_worker_capacity");
    const token = randomBytes(32).toString("base64url"),
      sessionId = randomUUID();
    const abort = new AbortController(),
      outbox = new SeatOutbox({ explicitAcknowledgments: true });
    let markAdmitted = () => {};
    const admitted = new Promise<void>((resolve) => (markAdmitted = resolve));
    const binding = createHash("sha256")
      .update(JSON.stringify([machine.machineId, sessionId, args.conversationId]))
      .digest("hex");
    const worker: Worker = {
      id: randomUUID(),
      token,
      sessionId,
      machineId: machine.machineId,
      directory,
      abort,
      outbox,
      admitted,
      markAdmitted,
      worker: true,
      binding: { conversationId: args.conversationId, nativeOccupantId: binding },
      signal: abort.signal,
      touchedAt: Date.now(),
      current: () =>
        workers.get(token) === worker && !abort.signal.aborted && Date.now() - worker.touchedAt < 60 * 60_000,
      authorize: async () => {
        try {
          await machine.authorize();
          return worker.current() && args.led();
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
            async (input_) => {
              const message = Message.parse(input_);
              // A worker briefed at startup reports inside that first turn, which
              // can finish before its adapter's admission reaches here (VUH-2607).
              if (!worker.paneId)
                await Promise.race([
                  worker.admitted,
                  new Promise((resolve) => {
                    const deadline = AbortSignal.any([worker.signal, AbortSignal.timeout(LAUNCH_MS)]);
                    deadline.addEventListener("abort", resolve, { once: true });
                  }),
                ]);
              if (!worker.paneId) throw Error("joined_worker_not_admitted");
              if (!input.captain.receiveJoinedWorkerReport) throw Error("joined_worker_reports_unavailable");
              const result = await input.captain.receiveJoinedWorkerReport(
                {
                  paneId: `${machine.machineId}/${worker.paneId}`,
                  binding,
                  conversationId: worker.binding.conversationId,
                  text: message.text,
                  deliveryId: message.deliveryId,
                  ...(message.urgent === true ? { urgent: true } : {}),
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
            async (input_) => {
              const { deliveryId } = Status.parse(input_);
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
    const request = JoinedWorkerLaunchSchema.parse({
      token,
      sessionId,
      conversationId: args.conversationId,
      title: args.title,
      brief: args.brief,
      maximumTrust: args.maximumTrust,
      ...(args.model ? { model: args.model } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
    });
    try {
      const result = await input.joins.request(
        machine.machineId,
        { kind: "workers", directory, request: JSON.stringify(request) },
        LAUNCH_MS,
      );
      if (!result.ok)
        return {
          outcome: "unconfirmed",
          sessionId,
          detail: result.error,
          advice: "Inspect the joined machine; do not repeat this hire.",
        };
      return {
        outcome: worker.paneId ? "started" : "unconfirmed",
        seatId: worker.paneId ? `${machine.machineId}/${worker.paneId}` : undefined,
        sessionId,
        conversationId: args.conversationId,
        detail: result.output,
      };
    } catch (error) {
      return {
        outcome: "unconfirmed",
        sessionId,
        detail: error instanceof Error ? error.message : String(error),
        advice: "Inspect the joined machine; do not repeat this hire.",
      };
    }
  };
  /** Down the worker's native join channel, never terminal typing; only its own lead conversation. */
  const deliver = async (seat: string, conversationId: string, message: string, leading = () => true) => {
    const worker = [...workers.values()].find(
      (worker) =>
        `${worker.machineId}/${worker.paneId}` === seat && worker.binding.conversationId === conversationId,
    );
    if (!worker || !(await worker.authorize())) throw Error("joined_worker_unknown");
    const result = await worker.outbox.deliver({
      kind: "message",
      conversationId: worker.binding.conversationId,
      source: "clankie",
      content: message,
      wantsReply: false,
      recipientBinding: worker.binding.nativeOccupantId,
      signal: worker.signal,
    });
    if (result.outcome === "delivered" && leading() && (await worker.authorize()))
      input.captain.recordJoinedWorkerReply?.(
        worker.binding.conversationId,
        `${worker.machineId}/${worker.paneId}`,
        worker.binding.nativeOccupantId,
      );
    return result;
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
            return reply(
              await launch({
                machine,
                directory,
                conversationId: lead.binding.conversationId,
                title: hire.title,
                brief: hire.brief,
                ...(hire.model ? { model: hire.model } : {}),
                ...(hire.effort ? { effort: hire.effort } : {}),
                maximumTrust,
                led: () =>
                  input.captain.seatContext(lead.binding.conversationId)?.machineId === machine.machineId,
              }),
            );
          },
        ),
        tool(
          "message_seat",
          "Send to one of this joined lead's workers by the exact seatId returned by hire_agent. Uses its native join channel, never terminal typing.",
          z.strictObject({ seat: z.string().min(1), message: z.string().min(1).max(16_384) }),
          async (args) => {
            return reply(
              await deliver(
                String(args.seat),
                lead.binding.conversationId,
                String(args.message),
                lead.current,
              ),
            );
          },
        ),
      ],
    });
  /**
   * A hire Clankie starts himself from a home conversation (VUH-2607). The
   * folder must lie in one approved when the machine joined; the receiver checks it again.
   */
  const hire = async (
    machine: JoinedSeatMachine,
    request: JoinedWorkerHireRequest,
    maximumTrust: boolean,
  ) => {
    if (!approvedDirectory(machine, request.workingDirectory))
      return {
        outcome: "failed",
        reason: "unknown_directory",
        detail: `${request.workingDirectory} is not in a folder approved when ${machine.machineId} joined (${machine.directories.join(", ")}).`,
      };
    return launch({
      machine,
      directory: request.workingDirectory,
      conversationId: request.conversationId,
      title: request.title,
      brief: request.brief,
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      maximumTrust,
      led: () => true,
    });
  };
  return {
    authority,
    admit,
    tools,
    hire,
    deliver,
    revokeConversation: (id: string) => {
      for (const worker of workers.values()) if (worker.binding.conversationId === id) close(worker);
    },
    close: () => {
      for (const worker of workers.values()) close(worker);
    },
  };
}

/** Inside one of the folders the machine's owner approved at join, as that machine spells paths. */
function approvedDirectory(machine: JoinedSeatMachine, directory: string): boolean {
  const paths = machine.platform === "win32" ? win32 : posix;
  const canonical = (path: string) =>
    machine.platform === "win32" ? paths.normalize(path).toLowerCase() : paths.normalize(path);
  const cwd = canonical(directory);
  return (
    paths.isAbsolute(cwd) &&
    machine.directories.some((root) => {
      const relative = paths.relative(canonical(root), cwd);
      return !paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`);
    })
  );
}
