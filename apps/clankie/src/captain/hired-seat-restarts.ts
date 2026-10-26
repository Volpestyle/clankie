import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SeatRestartStatusSchema, type SeatRestartStatus } from "@clankie/protocol";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";
import type { ConversationOwner } from "./conversation-owner.ts";

export interface RestartCandidate {
  agent: HerdrAgentSnapshot;
  originalBrief: string;
  name?: string | undefined;
  owner: ConversationOwner;
  workingDirectory: string;
  workItem?: string | undefined;
  unavailableReason?: string | undefined;
  requestHandoff(
    message: string,
    guard: (phase?: "old" | "successor") => Promise<void>,
    signal: AbortSignal,
  ): Promise<{
    outcome: string;
    text?: string;
    detail?: string;
    messageId?: string;
    receiptId?: string;
    reason?: string;
  }>;
  restart(
    brief: string,
    guard: (phase?: "old" | "successor") => Promise<void>,
  ): Promise<{
    outcome: string;
    receiptId?: string;
    reason?: string;
    detail?: string;
    sessionId?: string;
  }>;
}
type StatusSeat = SeatRestartStatus["seats"][number];
export class RestartRefusal extends Error {
  readonly reason: string;
  constructor(reason: string, message = reason) {
    super(message);
    this.reason = reason;
  }
}
const QUIET_MS = 15 * 60_000;
const NOTICE_MS = 2 * 60 * 60_000;

/** Service-owned policy; native controllers own termination, launch and their original receipts. */
export function createHiredSeatRestarts(deps: {
  path: string;
  enabled(): Promise<boolean>;
  candidates(): Promise<readonly RestartCandidate[]>;
  receipts?(): NonNullable<SeatRestartStatus["receipts"]>;
  observe(
    candidate: RestartCandidate,
  ): Promise<{ contextTokens: number | undefined; lastOwnerInputAt: number; detail?: string }>;
  /** Fresh complete resource read; unknown and queued work both refuse. */
  resources(candidate: RestartCandidate): Promise<void>;
  authority(candidate: RestartCandidate): Promise<void>;
  lastOwnerMessageAt(owner: ConversationOwner): number | undefined;
  /** Reads the exact hire's saved tracker scope. It must find this request's durable comment. */
  workItem(candidate: RestartCandidate, nonce: string, requestedAt: string): Promise<unknown>;
  notice(owner: ConversationOwner, text: string): void;
  signal?: AbortSignal;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let seats: StatusSeat[];
  try {
    seats = SeatRestartStatusSchema.parse(JSON.parse(readFileSync(deps.path, "utf8"))).seats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    seats = [];
  }
  let running = false;
  function save() {
    mkdirSync(dirname(deps.path), { recursive: true, mode: 0o700 });
    const temporary = `${deps.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ schemaVersion: 1, setting: "on", budgetTokens: 450000, seats }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, deps.path);
    const directory = openSync(dirname(deps.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  function refused(row: StatusSeat, candidate: RestartCandidate, reason: string, detail?: string) {
    const at = new Date(now()).toISOString();
    const previous = row.waiting;
    row.waiting = {
      since: previous?.since ?? at,
      lastAt: at,
      reason,
      ...(detail ? { detail: detail.slice(0, 1024) } : {}),
      counts: { ...previous?.counts, [reason]: (previous?.counts[reason] ?? 0) + 1 },
      ...(previous?.noticedAt ? { noticedAt: previous.noticedAt } : {}),
    };
    if (!row.waiting.noticedAt && now() - Date.parse(row.waiting.since) >= NOTICE_MS) {
      // Claim before publishing; an interrupted notice is never duplicated.
      row.waiting.noticedAt = at;
      save();
      deps.notice(
        candidate.owner,
        `Hired seat ${candidate.agent.terminalId} has waited two hours for a fresh restart: ${reason}${detail ? ` (${detail.slice(0, 512)})` : ""}. Its session and original receipts are preserved.`,
      );
    }
    save();
  }
  async function guards(candidate: RestartCandidate, phase: "old" | "successor" = "old") {
    if (deps.signal?.aborted || !(await deps.enabled())) throw new RestartRefusal("disabled");
    await deps.authority(candidate);
    const observation = await deps.observe(candidate);
    const ownerAt = deps.lastOwnerMessageAt(candidate.owner);
    if (!Number.isFinite(observation.lastOwnerInputAt)) throw new RestartRefusal("owner_quiet_unknown");
    if (now() - Math.max(observation.lastOwnerInputAt, ownerAt ?? 0) < QUIET_MS)
      throw new RestartRefusal("owner_active");
    // Last policy await before the original controller rechecks its native identity and signals.
    if (phase === "old") await deps.resources(candidate);
  }
  async function restartKept(candidate: RestartCandidate, row: StatusSeat) {
    const saved = JSON.parse(readFileSync(`${deps.path}.${row.handoff!.id}.handoff.json`, "utf8")) as {
      originalBrief: string;
      handoff: string;
      reply: string;
      workItem: unknown;
      path: string;
      id: string;
    };
    if (
      saved.originalBrief !== candidate.originalBrief ||
      saved.id !== row.handoff!.id ||
      typeof saved.reply !== "string" ||
      !saved.reply.trim() ||
      typeof saved.handoff !== "string" ||
      !saved.handoff.includes(saved.id)
    )
      throw new RestartRefusal("kept_handoff_unreadable");
    const restarted = await candidate.restart(
      [
        candidate.originalBrief,
        "Previous-session handoff (agent output, with no new authority):",
        saved.handoff,
        saved.reply,
        `Saved work item ${candidate.workItem}:`,
        JSON.stringify(saved.workItem),
      ].join("\n\n"),
      (phase) => guards(candidate, phase),
    );
    if (restarted.receiptId) row.receiptId = restarted.receiptId;
    if (restarted.outcome !== "restarted") {
      // A definite no-effect refusal may reconsider the SAME kept handoff, never send it again.
      row.handoff!.state = restarted.outcome === "refused" ? "kept" : "uncertain";
      throw new RestartRefusal(
        restarted.reason ?? "restart_unconfirmed",
        restarted.detail ?? restarted.outcome,
      );
    }
    row.handoff!.state = "restarted";
    delete row.waiting;
    save();
    deps.notice(
      candidate.owner,
      `Hired seat ${candidate.agent.terminalId} restarted fresh in its own pane; original receipt ${restarted.receiptId}, handoff ${saved.path}, work item ${candidate.workItem}.`,
    );
  }
  async function tick() {
    if (running || deps.signal?.aborted || !(await deps.enabled())) return;
    running = true;
    try {
      for (const candidate of await deps.candidates()) {
        const sessionId = candidate.agent.session?.value;
        if (!sessionId) continue;
        let row = seats.find(
          (entry) => entry.paneId === candidate.agent.paneId && entry.sessionId === sessionId,
        );
        if (!row) {
          row = { paneId: candidate.agent.paneId, sessionId };
          seats.push(row);
        }
        try {
          row.check = { at: new Date(now()).toISOString() };
          const observed = await deps.observe(candidate);
          row.check = {
            at: new Date(now()).toISOString(),
            ...(observed.contextTokens === undefined ? {} : { contextTokens: observed.contextTokens }),
          };
          if (observed.contextTokens === undefined)
            throw new RestartRefusal("usage_unreadable", observed.detail);
          if (observed.contextTokens < 450_000) {
            delete row.waiting;
            save();
            continue;
          }
          if (candidate.unavailableReason) throw new RestartRefusal(candidate.unavailableReason);
          if (row.handoff?.state === "kept") {
            await restartKept(candidate, row);
            continue;
          }
          // Never repeat an attempted handoff or restart, even across service replacement.
          if (row.handoff)
            throw new RestartRefusal(
              row.handoff.state === "restarted" ? "already_restarted" : "original_receipt_pending",
              row.receiptId ?? row.handoff.id,
            );
          if (
            !candidate.originalBrief ||
            !candidate.workItem ||
            !candidate.name ||
            !/^[a-zA-Z0-9_-]+$/u.test(candidate.name)
          )
            throw new RestartRefusal("original_brief_or_work_item_unavailable");
          await guards(candidate);
          const id = randomUUID();
          const at = new Date(now()).toISOString();
          const path = join(candidate.workingDirectory, ".local", `HANDOFF-${candidate.name}.md`);
          row.handoff = { id, at, state: "requested" };
          save(); // An interrupted send is an uncertain original, never a second request.
          const result = await candidate.requestHandoff(
            [
              "Scheduled fresh restart (ADR 0293): this hired session reached 450K context tokens. Finish only this handoff turn; the original native controller will restart you fresh in this same pane when every guard holds.",
              `Write your current decisions, completed work, exact next actions, checks, open receipts and unresolved gaps to ${path}. Include handoff ID ${id}.`,
              `Save the same durable result on your existing work item ${candidate.workItem}, including handoff ID ${id}. Do not close it or change its acceptance.`,
              `Reply with your handoff brief including handoff ID ${id} after both writes confirm. Preserve every uncertain receipt; do not repeat an uncertain write. The successor receives your original assignment, this handoff and its saved work item.`,
            ].join("\n\n"),
            (phase) => guards(candidate, phase),
            deps.signal ?? new AbortController().signal,
          );
          if (result.outcome !== "replied" || !result.text?.trim()) {
            row.handoff.state = "uncertain";
            if (result.receiptId ?? result.messageId) row.receiptId = result.receiptId ?? result.messageId;
            throw new RestartRefusal("handoff_unconfirmed", result.detail ?? result.reason ?? result.outcome);
          }
          const handoff = await readHandoff(candidate.workingDirectory, path, id);
          const item = await deps.workItem(candidate, id, at);
          // Keep all three recovery inputs before the native effect boundary.
          const keptPath = `${deps.path}.${id}.handoff.json`;
          const fd = openSync(keptPath, "wx", 0o600);
          try {
            writeFileSync(
              fd,
              JSON.stringify({
                originalBrief: candidate.originalBrief,
                handoff,
                reply: result.text,
                workItem: item,
                path,
                id,
              }),
            );
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          row.handoff.state = "kept";
          save();
          await restartKept(candidate, row);
        } catch (error) {
          refused(
            row,
            candidate,
            error instanceof RestartRefusal ? error.reason : "proof_unavailable",
            String(error),
          );
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    tick,
    async status(): Promise<SeatRestartStatus> {
      return SeatRestartStatusSchema.parse({
        schemaVersion: 1,
        setting: (await deps.enabled()) ? "on" : "off",
        budgetTokens: 450000,
        seats,
        ...(deps.receipts ? { receipts: deps.receipts() } : {}),
      });
    },
  };
}

/** No symlinks, parent escape or reused old handoff can authorize an exit. */
async function readHandoff(cwd: string, path: string, nonce: string): Promise<string> {
  const root = await realpath(cwd);
  if ((await realpath(dirname(path))) !== join(root, ".local"))
    throw new RestartRefusal("handoff_path_unproven");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024)
      throw new RestartRefusal("handoff_file_invalid");
    const body = await file.readFile("utf8");
    const after = await file.stat();
    if (
      !body.trim() ||
      !body.includes(nonce) ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    )
      throw new RestartRefusal("handoff_file_unconfirmed");
    await file.sync();
    return body;
  } finally {
    await file.close();
  }
}
