import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CaptainPort, LaneTool, LaneToolBank } from "./captain/port.ts";
import type { MachineJoins, JoinedSeatMachine, JoinedWorkerHireRequest } from "./machine-joins.ts";
import { posix, win32 } from "node:path";
import type { RemoteSeatAuthority } from "./remote-lead-bridge.ts";
import { SeatOutbox } from "./captain/seat-outbox.ts";
import {
  WatchingMachineRefused,
  WorkerReportTargetIdSchema,
  type ManageWorkerReportLeads,
} from "@clankie/protocol";
import { JoinedWorkerLaunchSchema, JoinedWorkerProofSchema } from "@clankie/protocol/machine-join";

import { JoinedWorkerRecords, type JoinedWorkerRecord } from "./joined-worker-records.ts";

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
  harness: z.enum(["claude", "codex"]).optional(),
  model: z.string().min(1).max(128).optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
});
const Message = z.strictObject({
  target: WorkerReportTargetIdSchema.optional(),
  text: z.string().min(1).max(16_384),
  deliveryId: z.uuid(),
  urgent: z
    .boolean()
    .optional()
    .describe(
      "True when you are blocked, something failed, or you need a decision: your lead hears it at once. Otherwise it reaches an idle lead with its next round of reports.",
    ),
  kind: z
    .enum(["done", "blocked", "update"])
    .optional()
    .describe(
      "done: the work is finished. blocked: you cannot go on until your lead answers; say what you need in one line, and your lead hears it at once. update: progress, no reply needed. Set it on every report.",
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
  /** Claude's session; Codex's launch nonce. */
  sessionId: string;
  harness: "claude" | "codex";
  token: string;
  record: () => JoinedWorkerRecord;
  prove: () => Promise<void>;
  paneId?: string;
  /** The native session admitted in that pane: Claude's from launch, Codex's as first observed. */
  nativeSessionId?: string;
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
export function createJoinedWorkers(input: {
  captain: CaptainPort;
  joins: MachineJoins;
  workerRecordDirectory?: string;
  reportDeviceAvailable?: (id: string) => boolean;
}) {
  const journal = new JoinedWorkerRecords(input.workerRecordDirectory);
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  const workers = new Map<string, Worker>();
  let closed = false;
  const close = (worker: Worker, revoke = false) => {
    const held = journal.records.get(worker.token);
    if (revoke && held) journal.remove(held);
    workers.delete(worker.token);
    worker.abort.abort();
    worker.outbox.close();
  };
  const authority = async (token: string, machine?: JoinedSeatMachine) => {
    if (closed) return undefined;
    const key = hash(token);
    let worker = workers.get(key);
    if (!worker) {
      const held = journal.records.get(key);
      if (held && machine && held.machineId !== machine.machineId) return undefined;
      const source = held && input.joins.seatMachine(held.machineId);
      if (
        held &&
        source &&
        held.paneId &&
        held.nativeSessionId &&
        Date.now() - held.touchedAt < 60 * 60_000
      ) {
        worker = createWorker(held, source);
        // A persisted identity is inert until the approved adapter proves its current native occupant.
        try {
          await worker.prove();
        } catch {
          close(worker);
          return undefined;
        }
      }
    }
    if (
      !worker ||
      (machine !== undefined && worker.machineId !== machine.machineId) ||
      !(await worker.authorize()) ||
      !worker.current()
    )
      return undefined;
    worker.touchedAt = Date.now();
    journal.save({ ...worker.record(), touchedAt: worker.touchedAt });
    return worker;
  };
  const admit = async (worker: Worker, raw: unknown) => {
    if (!worker.current()) throw Error("joined_worker_revoked");
    const value = z
      .strictObject({
        paneId: z.string().min(1).max(256),
        sessionId: z.uuid(),
        nativeSessionId: z.string().min(1).max(256).optional(),
      })
      .parse(raw);
    // Codex mints its own session, so the adapter names the one it first observed in
    // that pane after this launch; Claude's was fixed at launch (VUH-2609).
    const native = worker.harness === "codex" ? value.nativeSessionId : value.sessionId;
    if (
      value.sessionId !== worker.sessionId ||
      native === undefined ||
      (worker.harness === "claude" && value.nativeSessionId !== undefined) ||
      (worker.paneId !== undefined && (worker.paneId !== value.paneId || worker.nativeSessionId !== native))
    )
      throw Error("joined_worker_session_mismatch");
    // Only the approved machine's native adapter observes and admits this launch, once.
    worker.paneId = value.paneId;
    worker.nativeSessionId = native;
    journal.save({ ...worker.record(), paneId: value.paneId, nativeSessionId: native });
    worker.markAdmitted();
    return { admitted: true };
  };
  const createWorker = (record: JoinedWorkerRecord, machine: JoinedSeatMachine): Worker => {
    const token = record.tokenHash,
      sessionId = record.sessionId;
    const abort = new AbortController(),
      outbox = new SeatOutbox({ explicitAcknowledgments: true });
    let markAdmitted = () => {};
    const admitted = new Promise<void>((resolve) => (markAdmitted = resolve));
    const binding = createHash("sha256")
      .update(JSON.stringify([machine.machineId, sessionId, record.conversationId]))
      .digest("hex");
    const worker: Worker = {
      id: record.id,
      token,
      record: () => journal.records.get(token)!,
      prove: async () => {
        if (!worker.paneId || !worker.nativeSessionId) throw Error("joined_worker_not_admitted");
        if (!(await worker.authorize())) throw Error("joined_worker_revoked");
        await input.joins.refuseWatching(machine.machineId);
        const proof = JoinedWorkerProofSchema.parse({
          kind: "proof",
          nonce: randomUUID(),
          paneId: worker.paneId,
          harness: worker.harness,
          nativeSessionId: worker.nativeSessionId,
        });
        const response = await input.joins.request(
          machine.machineId,
          { kind: "workers", directory: worker.directory, request: JSON.stringify(proof) },
          10_000,
        );
        if (
          !response.ok ||
          JSON.stringify(JoinedWorkerProofSchema.parse(JSON.parse(response.output ?? "null"))) !==
            JSON.stringify(proof) ||
          !(await worker.authorize())
        )
          throw Error("joined_worker_native_proof_refused");
      },
      ...(record.paneId === undefined ? {} : { paneId: record.paneId }),
      ...(record.nativeSessionId === undefined ? {} : { nativeSessionId: record.nativeSessionId }),
      sessionId,
      harness: record.harness,
      machineId: machine.machineId,
      directory: record.directory,
      abort,
      outbox,
      admitted,
      markAdmitted,
      worker: true,
      binding: { conversationId: record.conversationId, nativeOccupantId: binding },
      signal: abort.signal,
      touchedAt: record.touchedAt,
      current: () =>
        !closed &&
        workers.get(token) === worker &&
        input.joins.has(machine.machineId) &&
        input.captain.joinedWorkerReportDestination(record.conversationId) &&
        !abort.signal.aborted &&
        Date.now() - worker.touchedAt < 60 * 60_000,
      authorize: async () => {
        try {
          await machine.authorize();
          if (!worker.current()) return false;
          if (
            record.requiresLead &&
            input.captain.seatContext(record.conversationId)?.machineId !== machine.machineId
          ) {
            close(worker, true);
            return false;
          }
          return true;
        } catch {
          close(worker, true);
          return false;
        }
      },
      pollEvents: async (wait, signal) => {
        if (!worker.paneId) return [];
        // A message queued before Watch is refused here, so it starts no native turn (ADR 0308).
        await outbox.readWatch(() => input.joins.watching());
        return outbox.poll(wait, signal, binding);
      },
      acknowledge: async (id) => outbox.acknowledge(id, binding),
      toolBank: async () => ({
        lane: "operator",
        tools: [
          tool(
            "list_report_leads",
            "List the report destinations admitted for this joined hire. This grants no control or private-work reads.",
            z.strictObject({}),
            async () => {
              await worker.prove();
              const original = JSON.stringify(worker.record().reportLeads);
              const leads = await input.captain.joinedWorkerReportLeads(
                worker.record().reportLeads,
                input.reportDeviceAvailable,
              );
              await worker.prove();
              if (!(await worker.authorize()) || original !== JSON.stringify(worker.record().reportLeads))
                throw Error("joined_worker_grants_changed");
              return reply({ schemaVersion: 1, leads });
            },
          ),
          tool(
            "message_clankie",
            "Send agent output to your hiring lead chat or an explicit target from list_report_leads. Choose a deliveryId once and retain it; after uncertainty read message_clankie_status, never resend with a new ID.",
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
              await worker.prove();
              const result = await input.captain.receiveJoinedWorkerReport(
                {
                  paneId: `${machine.machineId}/${worker.paneId}`,
                  binding,
                  conversationId: worker.binding.conversationId,
                  text: message.text,
                  ...(message.target === undefined ? {} : { target: message.target }),
                  reportLeads: () => worker.record().reportLeads,
                  ...(input.reportDeviceAvailable
                    ? { reportDeviceAvailable: input.reportDeviceAvailable }
                    : {}),
                  deliveryId: message.deliveryId,
                  ...(message.urgent === true ? { urgent: true } : {}),
                  ...(message.kind === undefined ? {} : { kind: message.kind }),
                },
                {
                  owner: { conversationId: worker.binding.conversationId },
                  current: worker.current,
                  authorize: async () => {
                    await worker.prove();
                    return worker.authorize();
                  },
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
              await worker.prove();
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
    if (record.paneId) markAdmitted();
    return worker;
  };

  /** Launch once; uncertainty never authorizes another native hire. */
  const launch = async (args: {
    machine: JoinedSeatMachine;
    directory: string;
    conversationId: string;
    title: string;
    brief: string;
    harness?: "claude" | "codex";
    model?: string;
    effort?: "low" | "medium" | "high" | "max";
    maximumTrust: boolean;
    requiresLead: boolean;
  }) => {
    const { machine, directory } = args;
    await input.joins.refuseWatching(machine.machineId);
    if (closed) throw Error("joined_workers_closed");
    for (const held of journal.records.values())
      if (Date.now() - held.touchedAt >= 60 * 60_000) {
        const worker = workers.get(held.tokenHash);
        if (worker) close(worker);
        journal.remove(held);
      }
    if (journal.records.size >= 128) throw Error("joined_worker_capacity");
    const token = randomBytes(32).toString("base64url"),
      sessionId = randomUUID();
    const record: JoinedWorkerRecord = {
      id: randomUUID(),
      tokenHash: hash(token),
      sessionId,
      harness: args.harness ?? "claude",
      machineId: machine.machineId,
      directory,
      conversationId: args.conversationId,
      requiresLead: args.requiresLead,
      touchedAt: Date.now(),
      reportLeads: [
        { id: `conversation:${args.conversationId}`, owner: { conversationId: args.conversationId } },
      ],
    };
    journal.save(record);
    const worker = createWorker(record, machine);
    const request = JoinedWorkerLaunchSchema.parse({
      token,
      sessionId,
      // Claude launches omit it, so receivers from before VUH-2609 still accept them.
      ...(args.harness === "codex" ? { harness: "codex" } : {}),
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
          joinedHireId: record.id,
          sessionId,
          detail: result.error,
          advice: "Inspect the joined machine; do not repeat this hire.",
        };
      return {
        outcome: worker.paneId ? "started" : "unconfirmed",
        joinedHireId: record.id,
        seatId: worker.paneId ? `${machine.machineId}/${worker.paneId}` : undefined,
        sessionId,
        conversationId: args.conversationId,
        detail: result.output,
      };
    } catch (error) {
      return {
        outcome: "unconfirmed",
        joinedHireId: record.id,
        sessionId,
        detail: error instanceof Error ? error.message : String(error),
        advice: "Inspect the joined machine; do not repeat this hire.",
      };
    }
  };
  /**
   * Watch holds every machine at Portal (ADR 0308). Asked before a joined lead's hire or
   * message, its refusal is a definite answer: nothing was sent, so nothing needs reconciling.
   */
  const refusedWhileWatching = async (machineId: string) => {
    try {
      await input.joins.refuseWatching(machineId);
      return undefined;
    } catch (error) {
      if (!(error instanceof WatchingMachineRefused)) throw error;
      return { ...reply({ outcome: "refused", reason: "watching", detail: error.message }), isError: true };
    }
  };
  /** Down the worker's native join channel, never terminal typing; only its own lead conversation. */
  const deliver = async (seat: string, conversationId: string, message: string, leading = () => true) => {
    const worker = [...workers.values()].find(
      (worker) =>
        `${worker.machineId}/${worker.paneId}` === seat && worker.binding.conversationId === conversationId,
    );
    if (!worker || !(await worker.authorize())) throw Error("joined_worker_unknown");
    await worker.prove();
    // Its bridge delivers messages as Claude channel events; a Codex worker launched
    // without an app-server has no such channel, and is never typed into (VUH-2609).
    if (worker.harness === "codex") throw Error("joined_codex_worker_takes_no_messages");
    await input.joins.refuseWatching(worker.machineId);
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
          "Launch an interactive Claude or Codex worker in Herdr on this joined machine, signed in with that machine's own account, bound to this folder and lead chat. Other directories require their own joined lead. A lost reply never authorizes another hire.",
          Hire,
          async (args) => {
            const hire = Hire.parse(args);
            if (hire.workingDirectory !== undefined && hire.workingDirectory !== directory)
              throw Error("joined_worker_directory_mismatch");
            if (!lead.current() || !(await lead.authorize())) throw Error("joined_seat_revoked");
            const watching = await refusedWhileWatching(machine.machineId);
            if (watching) return watching;
            return reply(
              await launch({
                machine,
                directory,
                conversationId: lead.binding.conversationId,
                title: hire.title,
                brief: hire.brief,
                ...(hire.harness ? { harness: hire.harness } : {}),
                ...(hire.model ? { model: hire.model } : {}),
                ...(hire.effort ? { effort: hire.effort } : {}),
                maximumTrust,
                requiresLead: true,
              }),
            );
          },
        ),
        tool(
          "message_seat",
          "Send to one of this joined lead's workers by the exact seatId returned by hire_agent. Uses its native join channel, never terminal typing.",
          z.strictObject({ seat: z.string().min(1), message: z.string().min(1).max(16_384) }),
          async (args) => {
            const watching = await refusedWhileWatching(machine.machineId);
            if (watching) return watching;
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
      ...(request.harness ? { harness: request.harness } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
      maximumTrust,
      requiresLead: false,
    });
  };
  return {
    authority,
    manageReportLeads: async (request: ManageWorkerReportLeads, authorize: () => Promise<boolean>) => {
      if (closed || !request.joinedHireId || !(await authorize())) throw Error("joined_worker_grant_refused");
      const held = [...journal.records.values()].find((record) => record.id === request.joinedHireId);
      const machine = held && input.joins.seatMachine(held.machineId);
      if (!held || !machine) throw Error("joined_worker_unknown");
      const worker = workers.get(held.tokenHash) ?? createWorker(held, machine);
      await worker.prove();
      const snapshot = worker.record();
      const change = request.change;
      if (change.op === "grant" && !input.captain.joinedWorkerReportDestination(change.conversationId))
        throw Error("Report destination conversation is unavailable");
      await worker.prove();
      if (
        !(await worker.authorize()) ||
        !(await authorize()) ||
        !worker.current() ||
        (change.op === "grant" && !input.captain.joinedWorkerReportDestination(change.conversationId)) ||
        JSON.stringify(snapshot.reportLeads) !== JSON.stringify(worker.record().reportLeads)
      )
        throw Error("joined_worker_grant_authority_changed");
      const leads = snapshot.reportLeads;
      if (change.op === "grant")
        journal.save({
          ...worker.record(),
          reportLeads: [
            ...leads,
            {
              id: `grant:${randomUUID()}`,
              owner: { conversationId: change.conversationId },
              ...(change.deviceId === undefined
                ? {}
                : { connector: { deviceId: change.deviceId, ...(change.ref ? { ref: change.ref } : {}) } }),
            },
          ],
        });
      if (change.op === "revoke")
        journal.save({ ...worker.record(), reportLeads: leads.filter((entry) => entry.id !== change.id) });
      return worker.record().reportLeads.map((entry) => ({
        id: entry.id,
        conversationId: entry.owner.conversationId,
        ...entry.connector,
      }));
    },
    admit,
    tools,
    hire,
    deliver,
    revokeConversation: (id: string) => {
      for (const held of journal.records.values())
        if (held.conversationId === id) {
          const worker = workers.get(held.tokenHash);
          if (worker) close(worker);
          journal.remove(held);
        }
    },
    close: () => {
      closed = true;
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
