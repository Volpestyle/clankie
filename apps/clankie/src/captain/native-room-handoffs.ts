import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename } from "node:path";
import {
  AgentSessionRequestError,
  readNativeSubagentSession,
  resolveHerdrSeatTranscriptPath,
  type HerdrAgentSession,
  type HerdrSeatTranscript,
} from "@clankie/agent-transcript";
import { z } from "zod";
import type { ConversationOwner } from "./conversation-owner.ts";
import type { LaneTool, LaneToolBank, LaneToolResult } from "./port.ts";
import type { SeatOutbox } from "./seat-outbox.ts";

/** This exact plugin agent has a structural MCP-only tool allowlist. */
export const CLAUDE_ROOM_AGENT_TYPE = "clankie:room";
const PROOF_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface NativeRoomParent {
  readonly host: string;
  readonly conversationId: string;
  readonly harness: "claude" | "codex";
  readonly parentSessionId: string;
  readonly session: HerdrAgentSession;
  readonly outbox: SeatOutbox;
  readonly recipientBinding?: string;
  /** Rechecks the selected native occupant, not just the pane label. */
  readonly assertCurrent: () => Promise<void>;
}

export interface NativeRoomStarted {
  readonly host: string;
  readonly harness: "claude" | "codex";
  readonly parentSessionId: string;
  readonly nativeChildSessionId: string;
}

export interface NativeRoomHandoffInput {
  readonly handoffId: string;
  readonly brief: string;
  readonly conversationId: string;
  readonly owner: ConversationOwner;
  readonly routeMode: "social" | "machine";
  readonly signal: AbortSignal;
  /** The original actor, destination, and room grant are checked before each effect. */
  readonly guard: () => Promise<void>;
  readonly roomToolBank: () => Promise<LaneToolBank>;
  readonly onStarted: (started: NativeRoomStarted) => void;
  readonly onTranscript?: (transcript: HerdrSeatTranscript) => void;
}

export interface NativeRoomHandoffResult {
  readonly outcome: "completed" | "waiting_user" | "unavailable" | "uncertain" | "canceled";
  readonly text?: string;
  readonly prompt?: string;
  readonly approvalRequired?: boolean;
  readonly detail?: string;
  readonly nativeChildSessionId?: string;
}

/** Undefined is permitted only before native admission, including ambient Codex. */
export type NativeRoomHandoffExecutor = (
  input: NativeRoomHandoffInput,
) => Promise<NativeRoomHandoffResult | undefined>;

interface Task {
  readonly id: string;
  readonly capability: string;
  readonly marker: string;
  readonly parent: NativeRoomParent;
  readonly input: NativeRoomHandoffInput;
  readonly finish: (result: NativeRoomHandoffResult) => void;
  readonly completed: Promise<NativeRoomHandoffResult>;
  parentIdentity?: string;
  child?: NativeRoomStarted;
  result?: NativeRoomHandoffResult;
  closed: boolean;
}

class NativeRoomMetadataPendingError extends Error {}

const identity = z.object({ taskId: z.string().uuid(), capability: z.string().length(64) });
const catalogInput = identity.strict();
const callInput = identity
  .extend({ name: z.string().min(1).max(256), arguments: z.record(z.string(), z.unknown()) })
  .strict();
const completeInput = identity
  .extend({
    text: z.string().min(1).max(65_536).optional(),
    outcome: z.enum(["completed", "waiting_user"]).optional(),
    prompt: z.string().min(1).max(65_536).optional(),
    approvalRequired: z.boolean().optional(),
  })
  .strict();
const textResult = (value: unknown): LaneToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

/** A task grants only its captured room bank; the native parent retains its own authority. */
export class NativeRoomHandoffs {
  private readonly tasks = new Map<string, Task>();
  private readonly timeoutMs: number;
  private readonly options: {
    readonly selectParent: (input: NativeRoomHandoffInput) => Promise<NativeRoomParent | undefined>;
    readonly timeoutMs?: number;
  };

  public constructor(options: {
    readonly selectParent: (input: NativeRoomHandoffInput) => Promise<NativeRoomParent | undefined>;
    readonly timeoutMs?: number;
  }) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public readonly execute: NativeRoomHandoffExecutor = async (input) => {
    input.signal.throwIfAborted();
    if (input.owner.conversationId !== input.conversationId)
      throw new Error("Native task owner does not match the original room.");
    await input.guard();
    const parent = await this.options.selectParent(input);
    if (parent === undefined || (parent.harness === "codex" && input.routeMode !== "machine"))
      return undefined;
    await parent.assertCurrent();
    await input.guard();
    const id = randomUUID();
    const capability = randomBytes(32).toString("hex");
    let resolveCompleted!: Task["finish"];
    const completed = new Promise<NativeRoomHandoffResult>((resolve) => {
      resolveCompleted = resolve;
    });
    const task: Task = {
      id,
      capability,
      marker: `clankie-room-task:${id}`,
      parent,
      input,
      finish: (result) => {
        if (task.result !== undefined) return;
        task.result = result;
        resolveCompleted(result);
      },
      completed,
      closed: false,
    };
    this.tasks.set(id, task);
    const invalidated = new AbortController();
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeout, invalidated.signal]);
    const stop = (): void => {
      task.finish({
        outcome: input.signal.aborted ? "canceled" : "uncertain",
        detail:
          "Native task did not confirm completion. Its child may still be active; never repeat the handoff.",
        ...(task.child === undefined ? {} : { nativeChildSessionId: task.child.nativeChildSessionId }),
      });
      task.closed = true;
    };
    signal.addEventListener("abort", stop, { once: true });
    // Observe native ancestry while the parent works. Tool calls also refresh this
    // proof: an Agent background result can legitimately appear after child start.
    let observing = false;
    const observe = setInterval(() => {
      if (observing || task.closed) return;
      observing = true;
      void this.authorize(task)
        .catch((error: unknown) => {
          if (error instanceof NativeRoomMetadataPendingError || task.closed) return;
          task.finish({
            outcome: "unavailable",
            detail: error instanceof Error ? error.message : String(error),
            ...(task.child === undefined ? {} : { nativeChildSessionId: task.child.nativeChildSessionId }),
          });
          task.closed = true;
          invalidated.abort();
        })
        .finally(() => {
          observing = false;
        });
    }, 1_000);
    observe.unref();
    try {
      const delivery = await parent.outbox.deliver({
        delivery: "queue",
        kind: "escalation",
        conversationId: input.conversationId,
        source: "room-task",
        wantsReply: false,
        signal,
        ...(parent.recipientBinding === undefined ? {} : { recipientBinding: parent.recipientBinding }),
        content: this.brief(task),
      });
      if (delivery.outcome !== "delivered" && delivery.outcome !== "replied")
        return (
          task.result ?? {
            outcome:
              delivery.outcome === "unbound"
                ? "unavailable"
                : delivery.outcome === "aborted"
                  ? "canceled"
                  : "uncertain",
            detail:
              delivery.outcome === "unconfirmed"
                ? delivery.detail
                : "The selected native parent did not confirm this handoff. Do not retry through another executor.",
          }
        );
      return await completed;
    } catch (error) {
      return { outcome: "uncertain", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      task.closed = true;
      clearInterval(observe);
      signal.removeEventListener("abort", stop);
      // A closed task never lends authority after its owning execution ended.
      this.tasks.delete(id);
    }
  };

  public tools(parentConversationId?: string): readonly LaneTool[] {
    const wrap = (
      name: string,
      description: string,
      schema: z.ZodType,
      call: (args: Record<string, unknown>) => Promise<LaneToolResult>,
    ): LaneTool => ({
      name,
      description,
      inputSchema: z.toJSONSchema(schema) as Record<string, unknown>,
      call: async (args) => {
        try {
          return await call(args);
        } catch (error) {
          return { ...textResult(error instanceof Error ? error.message : String(error)), isError: true };
        }
      },
    });
    return [
      wrap(
        "room_task_tools",
        "Read the original room's permitted tools for an authenticated native child task. If native metadata is not ready, retry this read only; never spawn again.",
        catalogInput,
        async (args) => {
          const task = this.task(catalogInput.parse(args), parentConversationId);
          await this.authorize(task);
          const bank = await task.input.roomToolBank();
          await this.authorize(task);
          return textResult({
            taskId: task.id,
            brief: task.input.brief,
            lane: bank.lane,
            nativeChildSessionId: task.child!.nativeChildSessionId,
            tools: bank.tools
              .filter((tool) => !tool.name.startsWith("room_task_"))
              .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          });
        },
      ),
      wrap(
        "room_task_call",
        "Call one tool with this native task's original room authority. Tool arguments never choose an actor, destination, or operator lane.",
        callInput,
        async (args) => {
          const input = callInput.parse(args);
          const task = this.task(input, parentConversationId);
          await this.authorize(task);
          const bank = await task.input.roomToolBank();
          const tool = bank.tools.find(
            (item) => item.name === input.name && !item.name.startsWith("room_task_"),
          );
          if (tool === undefined)
            throw new Error("Tool is unavailable in this task's original room authority.");
          await this.authorize(task);
          return await tool.call(input.arguments);
        },
      ),
      wrap(
        "room_task_complete",
        "Finish this authenticated native room child with text, or outcome waiting_user plus prompt and approvalRequired. The service uses the original room reply route; never call the parent's reply tool for this task.",
        completeInput,
        async (args) => {
          const input = completeInput.parse(args);
          if (input.outcome === "waiting_user" ? input.prompt === undefined : input.text === undefined)
            throw new Error("Completion needs text, or waiting_user with an explicit prompt.");
          const task = this.task(input, parentConversationId);
          await this.authorize(task);
          task.finish(
            input.outcome === "waiting_user"
              ? {
                  outcome: "waiting_user",
                  prompt: input.prompt!,
                  ...(input.approvalRequired === undefined
                    ? {}
                    : { approvalRequired: input.approvalRequired }),
                  nativeChildSessionId: task.child!.nativeChildSessionId,
                }
              : {
                  outcome: "completed",
                  text: input.text!,
                  nativeChildSessionId: task.child!.nativeChildSessionId,
                },
          );
          task.closed = true;
          return textResult({
            outcome: input.outcome ?? "completed",
            taskId: task.id,
            nativeChildSessionId: task.child!.nativeChildSessionId,
          });
        },
      ),
    ];
  }

  private task(input: z.infer<typeof identity>, parentConversationId?: string): Task {
    const task = this.tasks.get(input.taskId);
    if (
      task === undefined ||
      task.closed ||
      task.parent.conversationId !== parentConversationId ||
      !timingSafeEqual(Buffer.from(task.capability), Buffer.from(input.capability))
    )
      throw new Error("Native room task grant is invalid or expired.");
    return task;
  }

  private async authorize(task: Task): Promise<void> {
    if (task.closed) throw new Error("Native room task is closed.");
    task.input.signal.throwIfAborted();
    await task.parent.assertCurrent();
    await task.input.guard();
    const child = await proveNativeRoomChild(task.parent, task.marker, task.parentIdentity);
    task.parentIdentity = child.parentIdentity;
    if (task.child !== undefined && task.child.nativeChildSessionId !== child.nativeChildSessionId)
      throw new Error("Native task child identity changed.");
    await task.parent.assertCurrent();
    await task.input.guard();
    if (task.closed) throw new Error("Native room task is closed.");
    if (task.child === undefined) {
      task.child = {
        host: task.parent.host,
        harness: task.parent.harness,
        parentSessionId: task.parent.parentSessionId,
        nativeChildSessionId: child.nativeChildSessionId,
      };
      task.input.onStarted(task.child);
    }
    task.input.onTranscript?.(child.transcript);
  }

  private brief(task: Task): string {
    const instruction =
      task.parent.harness === "claude"
        ? `Use your native Agent tool with subagent_type exactly ${CLAUDE_ROOM_AGENT_TYPE}, run_in_background true, and the task payload as its prompt. Do not execute the room request in this parent. The restricted agent has only room_task_tools, room_task_call, and room_task_complete.`
        : "Use your native spawn_agent tool for a fresh child with the task payload as its message. This room already has a machine grant; the child inherits this native seat's machine tools. Do not execute the room request in this parent.";
    return `<clankie-native-room-task>\n${instruction}\nAfter spawning, return and release this parent turn immediately. Do not wait for the child or fetch its output; the service receives completion independently. Native admission is not completion. Spawn once; metadata-only retries must never spawn another child. The child reads its original request through room_task_tools, acts through room_task_call, and finishes through room_task_complete. Never use reply for this task.\n${JSON.stringify({ taskId: task.id, capability: task.capability, marker: task.marker, handoffId: task.input.handoffId })}\n</clankie-native-room-task>`;
  }
}

/** Bounded native bytes establish both the restricted Agent call and actual child ancestry. */
async function proveNativeRoomChild(
  parent: NativeRoomParent,
  marker: string,
  expectedIdentity?: string,
): Promise<{ parentIdentity: string; nativeChildSessionId: string; transcript: HerdrSeatTranscript }> {
  const path = resolveHerdrSeatTranscriptPath(parent.harness, parent.session);
  if (path === undefined)
    throw new NativeRoomMetadataPendingError("Native parent transcript is not ready; retry metadata only.");
  const expectedName =
    parent.harness === "claude" ? `${parent.parentSessionId}.jsonl` : `-${parent.parentSessionId}.jsonl`;
  if (
    !(parent.harness === "claude" ? basename(path) === expectedName : basename(path).endsWith(expectedName))
  )
    throw new Error("Native parent transcript does not match the selected seat.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  let parentIdentity: string;
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error("Native parent transcript is not a regular file.");
    parentIdentity = `${stats.dev}:${stats.ino}`;
    if (expectedIdentity !== undefined && expectedIdentity !== parentIdentity)
      throw new Error("Native parent transcript changed.");
    const from = Math.max(0, stats.size - PROOF_BYTES);
    bytes = Buffer.alloc(Math.min(stats.size, PROOF_BYTES));
    bytes = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, from));
    if (from > 0) bytes = bytes.subarray(bytes.indexOf(0x0a) + 1);
  } finally {
    closeSync(fd);
  }
  const records = bytes
    .toString("utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return record(parsed) === undefined ? [] : [record(parsed)!];
      } catch {
        return [];
      }
    });
  const candidates = new Map<string, string | undefined>();
  for (const entry of records) {
    if (parent.harness === "claude") {
      if (entry.isSidechain === true) continue;
      const content = record(entry.message)?.content;
      if (!Array.isArray(content)) continue;
      for (const raw of content) {
        const item = record(raw);
        const input = record(item?.input);
        if (
          entry.type === "assistant" &&
          item?.type === "tool_use" &&
          ["Agent", "Task"].includes(String(item.name)) &&
          typeof item.id === "string" &&
          typeof input?.prompt === "string" &&
          input.prompt.includes(marker)
        ) {
          if (input.subagent_type !== CLAUDE_ROOM_AGENT_TYPE)
            throw new Error("Native room child used an unrestricted Claude agent type.");
          candidates.set(item.id, undefined);
        }
        if (
          entry.type === "user" &&
          item?.type === "tool_result" &&
          typeof item.tool_use_id === "string" &&
          candidates.has(item.tool_use_id)
        ) {
          const childId = record(entry.toolUseResult)?.agentId;
          if (typeof childId === "string") candidates.set(item.tool_use_id, childId);
        }
      }
    } else {
      const payload = record(entry.payload);
      if (entry.type !== "response_item") continue;
      if (
        payload?.type === "function_call" &&
        payload.name === "spawn_agent" &&
        typeof payload.call_id === "string"
      ) {
        const input =
          typeof payload.arguments === "string" ? jsonRecord(payload.arguments) : record(payload.arguments);
        if (typeof input?.message === "string" && input.message.includes(marker))
          candidates.set(payload.call_id, undefined);
      }
      if (
        payload?.type === "function_call_output" &&
        typeof payload.call_id === "string" &&
        candidates.has(payload.call_id)
      ) {
        const output =
          typeof payload.output === "string" ? jsonRecord(payload.output) : record(payload.output);
        if (typeof output?.agent_id === "string") candidates.set(payload.call_id, output.agent_id);
      }
    }
  }
  if (candidates.size !== 1)
    throw candidates.size === 0
      ? new NativeRoomMetadataPendingError(
          "Native child metadata is not ready; retry this read only, never respawn.",
        )
      : new Error("Native room task has ambiguous children; never repeat the handoff.");
  const [callId, childId] = [...candidates.entries()][0]!;
  if (childId === undefined)
    throw new NativeRoomMetadataPendingError(
      "Native child identity is not published yet; retry metadata only, never respawn.",
    );
  const page = await readNativeSubagentSession(
    parent.harness,
    parent.session,
    parent.harness === "claude" ? callId : childId,
    { tail: 100 },
  ).catch((error: unknown) => {
    if (error instanceof AgentSessionRequestError && error.status === 404)
      throw new NativeRoomMetadataPendingError(error.message);
    throw error;
  });
  return {
    parentIdentity,
    nativeChildSessionId: childId,
    transcript: {
      sessionKey: `${parent.harness}:${parent.parentSessionId}:${childId}`,
      entries: page.entries.filter((entry) => entry.type !== "viewed_image"),
    },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function jsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}
