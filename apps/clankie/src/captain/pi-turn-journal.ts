import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, ImageContent, TranscriptContext } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  CaptainChannelTurnResultSchema,
  CaptainTurnMediaSchema,
  DiscordPresenceChannelTurnRequestSchema,
} from "@clankie/protocol";
import type {
  CaptainChannelTurnResult,
  CaptainTurnMedia,
  DiscordPresenceChannelTurnRequest,
} from "@clankie/protocol";
import { z } from "zod";

const Step = z.strictObject({
  kind: z.enum(["model", "tool"]),
  key: z.string(),
  replay: z.enum(["safe", "never"]),
  input: z.json(),
  output: z.json().optional(),
  media: CaptainTurnMediaSchema.optional(),
});
/**
 * A follow-up steered into the running turn (ADR 0118). `after` is the last
 * journaled step when it arrived; replay queues it again once that step is served.
 */
const Steer = z.strictObject({
  deliveryId: z.string(),
  prompt: z.string(),
  images: z.json(),
  after: z.string().optional(),
  withdrawn: z.literal(true).optional(),
});
const RecordSchema = z.strictObject({
  version: z.literal(1),
  request: DiscordPresenceChannelTurnRequestSchema,
  fingerprint: z.string(),
  grant: z.string(),
  prompt: z.string().optional(),
  tools: z.string().optional(),
  session: z.strictObject({ file: z.string(), leaf: z.string().nullable() }).optional(),
  steps: z.array(Step),
  steers: z.array(Steer).optional(),
  result: CaptainChannelTurnResultSchema.optional(),
});
type JournalRecord = z.infer<typeof RecordSchema>;
type ToolOutcome = NonNullable<Awaited<ReturnType<NonNullable<AgentSession["agent"]["afterToolCall"]>>>>;

export class PiTurnPausedError extends Error {
  constructor() {
    super("pi_turn_paused_for_service_restart");
  }
}

/** Exact observations only. Unknown tools and generic dispatchers are never replayed. */
function piToolReplay(name: string, args?: unknown): "safe" | "never" {
  if (
    name === "memory" &&
    typeof args === "object" &&
    args !== null &&
    "action" in args &&
    args.action === "search"
  )
    return "safe";
  return new Set(["read", "get_self_state", "agent_sessions", "agent_session_read", "mcp_tool_search"]).has(
    name,
  )
    ? "safe"
    : "never";
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function json(value: unknown): z.infer<ReturnType<typeof z.json>> {
  return JSON.parse(JSON.stringify(value)) as z.infer<ReturnType<typeof z.json>>;
}

/** A journaled model request carried the follow-up, so this turn's answer covers it. */
function steerConsumed(record: JournalRecord, deliveryId: string): boolean {
  const steer = record.steers?.find((entry) => entry.deliveryId === deliveryId);
  if (steer === undefined || steer.withdrawn) return false;
  const text = JSON.stringify(steer.prompt);
  return record.steps.some((step) => step.kind === "model" && JSON.stringify(step.input).includes(text));
}

/** Exclusive temporary file, fsync, rename, then fsync of the directory. */
function writeDurably(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(file, `${JSON.stringify(value)}\n`);
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

/** One delivery's private journal. Every write is durable before the next effect. */
export class PiTurnJournal {
  private modelIndex = 0;
  private readonly replayedTools = new Map<string, ToolOutcome>();
  /** Steers already queued into this process's session. */
  private readonly queuedSteers = new Set<string>();
  private releaseSteers: (after: string | undefined) => void = () => {};
  private poisoned = false;
  readonly record: JournalRecord;

  readonly path: string;
  constructor(path: string, request: DiscordPresenceChannelTurnRequest, grant: string) {
    this.path = path;
    if (existsSync(path)) {
      this.record = RecordSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (this.record.fingerprint !== digest(request) || this.record.grant !== grant)
        throw new Error("pi_turn_recovery_identity_changed");
    } else {
      this.record = { version: 1, request, fingerprint: digest(request), grant, steps: [] };
      this.save();
    }
  }

  private save(): void {
    this.assertHealthy();
    try {
      writeDurably(this.path, this.record);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  private assertHealthy(): void {
    if (this.poisoned) throw new Error("pi_turn_journal_unavailable");
  }

  manager(cwd: string): SessionManager {
    const saved = this.record.session;
    if (saved !== undefined && existsSync(saved.file)) {
      const manager = SessionManager.open(saved.file, dirname(saved.file), cwd);
      if (saved.leaf === null) manager.resetLeaf();
      else manager.branch(saved.leaf);
      return manager;
    }
    if (this.record.steps.length > 0) throw new Error("pi_turn_session_missing");
    return SessionManager.create(cwd, join(dirname(this.path), "pi"));
  }

  settle(result: CaptainChannelTurnResult): void {
    this.record.result = CaptainChannelTurnResultSchema.parse(result);
    this.save();
  }

  /** Durable before Pi sees it, so a resumed turn hears the follow-up at the same point. */
  steer(deliveryId: string, prompt: string, images: readonly ImageContent[]): void {
    const steers = (this.record.steers ??= []);
    if (steers.some((entry) => entry.deliveryId === deliveryId)) return;
    const after = this.record.steps.at(-1)?.key;
    steers.push({ deliveryId, prompt, images: json(images), ...(after === undefined ? {} : { after }) });
    this.queuedSteers.add(deliveryId);
    this.save();
  }

  /** The turn ended before reading it; the follow-up becomes its own handoff and is never replayed here. */
  withdraw(deliveryId: string): void {
    const steer = this.record.steers?.find((entry) => entry.deliveryId === deliveryId);
    if (steer === undefined || steer.withdrawn || this.consumed(deliveryId)) return;
    steer.withdrawn = true;
    this.save();
  }

  consumed(deliveryId: string): boolean {
    return steerConsumed(this.record, deliveryId);
  }

  prompt(value: string): string {
    this.record.prompt ??= value;
    this.save();
    return this.record.prompt;
  }

  /** Wrap Pi's real stream and call hooks, retaining its tool registry and extensions. */
  attach(
    session: AgentSession,
    capture: { media?: CaptainTurnMedia | undefined },
    validate?: () => Promise<void>,
  ): () => void {
    const tools = digest(
      session
        .getAllTools()
        .map(({ name, parameters, description }) => ({ name, parameters, description }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    if (this.record.tools !== undefined && this.record.tools !== tools)
      throw new Error("pi_turn_tool_registry_changed");
    this.record.tools ??= tools;
    this.record.session ??= {
      file: session.sessionManager.getSessionFile()!,
      leaf: session.sessionManager.getLeafId(),
    };
    this.save();
    this.releaseSteers = (after) => {
      for (const steer of this.record.steers ?? []) {
        if (steer.withdrawn || steer.after !== after || this.queuedSteers.has(steer.deliveryId)) continue;
        this.queuedSteers.add(steer.deliveryId);
        session.steer(steer.prompt, steer.images as unknown as ImageContent[]).catch(() => {
          this.poisoned = true;
        });
      }
    };
    const agent = session.agent;
    const stream = agent.streamFunction;
    const before = agent.beforeToolCall;
    const after = agent.afterToolCall;
    type Tool = AgentSession["agent"]["state"]["tools"][number];
    const wrapped = new Map<Tool, Tool["execute"]>();
    agent.streamFunction = async (model, context, options) => {
      this.assertHealthy();
      await validate?.();
      // A follow-up that arrived before the turn's first step; the session is streaming now.
      if (this.modelIndex === 0) this.releaseSteers(undefined);
      const key = `model:${this.modelIndex++}`;
      let step = this.record.steps.find((entry) => entry.key === key);
      if (step === undefined) {
        step = { kind: "model", key, replay: "safe", input: json({ model, context }) };
        this.record.steps.push(step);
        this.save();
      }
      const output = createAssistantMessageEventStream();
      if (step.output !== undefined) {
        const message = step.output as unknown as AssistantMessage;
        if (message.stopReason === "pending") {
          this.poisoned = true;
          throw new Error("pi_turn_model_outcome_incomplete");
        }
        if (message.stopReason === "error" || message.stopReason === "aborted")
          output.push({ type: "error", reason: message.stopReason, error: message });
        else output.push({ type: "done", reason: message.stopReason, message });
        output.end(message);
        this.releaseSteers(key);
        return output;
      }
      // An interrupted request uses the committed context, with fresh credentials/cancellation.
      const input = step.input as unknown as { model: typeof model; context: TranscriptContext };
      const source = await stream(input.model, input.context, options);
      const saved = step;
      void (async () => {
        try {
          for await (const event of source) {
            if (event.type === "done" || event.type === "error") {
              saved.output = json(event.type === "done" ? event.message : event.error);
              this.save(); // Commit the complete model result before Pi sees it or executes tools.
            }
            output.push(event);
          }
          output.end(await source.result());
        } catch (error) {
          this.poisoned = true;
          const message: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          };
          output.push({ type: "error", reason: "error", error: message });
          output.end(message);
        }
      })();
      return output;
    };
    agent.beforeToolCall = async (call, signal) => {
      this.assertHealthy();
      await validate?.();
      const blocked = await before?.(call, signal);
      if (blocked?.block) return blocked;
      const key = `tool:${call.toolCall.id}`;
      const input = json({ name: call.toolCall.name, args: call.args });
      let step = this.record.steps.find((entry) => entry.key === key);
      if (step !== undefined) {
        if (step.kind !== "tool" || digest(step.input) !== digest(input)) {
          this.poisoned = true;
          throw new Error("pi_turn_tool_replay_diverged");
        }
        let result = step.output as ToolOutcome | undefined;
        if (result === undefined && step.replay === "never") {
          result = {
            content: [
              {
                type: "text",
                text: "Interrupted by a service restart. This call possibly ran; its outcome is unknown. Do not repeat it without checking the original receipt or reading the destination.",
              },
            ],
            isError: true,
          };
          step.output = json(result);
          this.save();
        }
        if (result !== undefined) {
          capture.media = step.media;
          this.replayedTools.set(call.toolCall.id, result);
        }
      }
      // Pi 1.0 bypasses afterToolCall for a blocked call. Substitute the executor
      // instead, so the real loop still emits the saved success/error result.
      const tool = call.context.tools?.find((candidate) => candidate.name === call.toolCall.name);
      if (tool === undefined) throw new Error("pi_turn_tool_missing");
      if (!wrapped.has(tool)) {
        const execute = tool.execute;
        wrapped.set(tool, execute);
        tool.execute = async (id, args, toolSignal, update) => {
          this.assertHealthy();
          await validate?.();
          const replayed = this.replayedTools.get(id);
          try {
            return replayed === undefined
              ? await execute(id, args, toolSignal, update)
              : { ...replayed, content: replayed.content ?? [], details: replayed.details };
          } finally {
            this.releaseSteers(`tool:${id}`);
          }
        };
      }
      if (step === undefined) {
        step = { kind: "tool", key, replay: piToolReplay(call.toolCall.name, call.args), input };
        if (capture.media !== undefined) step.media = capture.media;
        this.record.steps.push(step);
        this.save(); // Intent before the actual tool, including never tools.
      }
      return blocked;
    };
    agent.afterToolCall = async (call, signal) => {
      this.assertHealthy();
      const replayed = this.replayedTools.get(call.toolCall.id);
      if (replayed !== undefined) {
        this.replayedTools.delete(call.toolCall.id);
        // The substituted executor already returned the final saved result.
        return undefined;
      }
      const override = await after?.(call, signal);
      // Match Pi 1.0's effective hook result, including dropping stale structured
      // content when a hook replaces only content (e.g. image normalization).
      const result = { ...call.result, isError: override?.isError ?? call.isError };
      if (override) {
        result.content = override.content ?? result.content;
        result.details = override.details ?? result.details;
        if (override.usage !== undefined) result.usage = override.usage;
        if (override.terminate !== undefined) result.terminate = override.terminate;
        const structured =
          override.structuredContent ?? (override.content ? undefined : result.structuredContent);
        if (structured === undefined) delete result.structuredContent;
        else result.structuredContent = structured;
      }
      const step = this.record.steps.find((entry) => entry.key === `tool:${call.toolCall.id}`);
      if (step === undefined) throw new Error("pi_turn_tool_intent_missing");
      step.output = json(result);
      if (capture.media !== undefined) step.media = capture.media;
      this.save();
      // Pi applies its own merge to the live call; do not apply it twice.
      return override;
    };
    return () => {
      this.releaseSteers = () => {};
      agent.streamFunction = stream;
      if (before) agent.beforeToolCall = before;
      else delete agent.beforeToolCall;
      if (after) agent.afterToolCall = after;
      else delete agent.afterToolCall;
      for (const [tool, execute] of wrapped) tool.execute = execute;
    };
  }
}

/** A follow-up steered into another delivery's journaled turn, and its own answer once given. */
const JoinedSchema = z.strictObject({
  parent: z.string(),
  result: CaptainChannelTurnResultSchema.optional(),
});

/**
 * Durable Pi turns for owner-only audiences (ADR 0284): one journal per delivery,
 * serialized. The room handoff decides which turns are durable; the journal covers
 * only their Pi dispatch. A follow-up that steers a running turn is journaled in
 * that turn first, so no steering escapes it.
 */
export class DurablePiTurns {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string, Promise<CaptainChannelTurnResult>>();
  private readonly runningByDelivery = new Map<string, Promise<CaptainChannelTurnResult>>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  /** This delivery's Pi dispatch began in an earlier process and never settled. */
  resumable(request: DiscordPresenceChannelTurnRequest): boolean {
    const record = this.read(request.deliveryId);
    return record !== undefined && record.fingerprint === digest(request) && record.result === undefined;
  }
  /**
   * Whether a delivery still has durable work, before its request is known: its
   * own journal has no result, or it steered a turn and was not yet answered.
   */
  unsettled(deliveryId: string): boolean {
    const record = this.read(deliveryId);
    if (record !== undefined) return record.result === undefined;
    const joined = this.joined(deliveryId);
    return joined !== undefined && joined.result === undefined;
  }
  /** Written before the steer, so a restart always finds which turn a follow-up joined. */
  link(deliveryId: string, parent: string): void {
    writeDurably(this.joinedPath(deliveryId), { parent });
  }
  joined(deliveryId: string): z.infer<typeof JoinedSchema> | undefined {
    try {
      return JoinedSchema.parse(JSON.parse(readFileSync(this.joinedPath(deliveryId), "utf8")));
    } catch {
      return undefined;
    }
  }
  /** The follow-up was answered (absorbed or failed), or it left to become its own handoff. */
  settleJoined(deliveryId: string, result?: CaptainChannelTurnResult): void {
    const joined = this.joined(deliveryId);
    if (joined === undefined) return;
    if (result === undefined) rmSync(this.joinedPath(deliveryId), { force: true });
    else writeDurably(this.joinedPath(deliveryId), { ...joined, result });
  }
  /**
   * Where a joined follow-up stands in its parent's journal: whether the parent has
   * settled, and whether a journaled model request carried the follow-up.
   */
  parentOf(deliveryId: string):
    | {
        readonly parent: string;
        readonly request: DiscordPresenceChannelTurnRequest;
        readonly result?: CaptainChannelTurnResult;
        readonly consumed: boolean;
      }
    | undefined {
    const joined = this.joined(deliveryId);
    if (joined === undefined) return undefined;
    const record = this.read(joined.parent);
    if (record?.steers?.some((steer) => steer.deliveryId === deliveryId) !== true) return undefined;
    return {
      parent: joined.parent,
      request: record.request,
      ...(record.result === undefined ? {} : { result: record.result }),
      consumed: steerConsumed(record, deliveryId),
    };
  }
  /** The parent's resumed run, when this process is running it. */
  runningFor(deliveryId: string): Promise<CaptainChannelTurnResult> | undefined {
    return this.runningByDelivery.get(deliveryId);
  }
  private joinedPath(deliveryId: string): string {
    return join(this.root, digest(deliveryId), "joined.json");
  }
  /** An unreadable journal resumes nothing; the turn's own recovery reports it. */
  private read(deliveryId: string): JournalRecord | undefined {
    try {
      return RecordSchema.parse(
        JSON.parse(readFileSync(join(this.root, digest(deliveryId), "turn.json"), "utf8")),
      );
    } catch {
      return undefined;
    }
  }
  private path(request: DiscordPresenceChannelTurnRequest): string {
    return join(this.root, digest(request.deliveryId), "turn.json");
  }
  run(
    request: DiscordPresenceChannelTurnRequest,
    grant: string,
    execute: (journal: PiTurnJournal) => Promise<CaptainChannelTurnResult>,
  ): Promise<CaptainChannelTurnResult> {
    const key = digest(request);
    const running = this.running.get(key);
    if (running !== undefined) return running;
    const result = this.tail
      // allow-swallowed-rejection -- its original caller owns the failure; later deliveries must still run.
      .catch(() => undefined)
      .then(async () => {
        const journal = new PiTurnJournal(this.path(request), request, grant);
        if (journal.record.result !== undefined) return journal.record.result;
        const result = await execute(journal);
        journal.settle(result);
        return result;
      });
    this.running.set(key, result);
    this.runningByDelivery.set(request.deliveryId, result);
    this.tail = result;
    // allow-swallowed-rejection -- only cleanup's derived promise is dropped; the original result is returned.
    void result
      .finally(() => {
        this.running.delete(key);
        if (this.runningByDelivery.get(request.deliveryId) === result)
          this.runningByDelivery.delete(request.deliveryId);
      })
      .catch(() => undefined);
    return result;
  }
}
