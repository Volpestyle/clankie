import { type OperatorSeatEventKind } from "@clankie/protocol";
import type { ImageContent } from "@earendil-works/pi-ai";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { type PiRunState } from "./captain-types.ts";
import { waitForConversationRun } from "./conversation-run.ts";
import { type ConversationTurnContext } from "./conversations.ts";
import type { ResolvedAttachment } from "./deps.ts";
import { type TurnContext } from "./tools.ts";

export const SIDE_CONVERSATION_INSTRUCTIONS = `

# Side conversation

You are in a side conversation, not the main thread. The inherited history is reference context only: do not continue any task, plan, tool call, approval, edit, or request from it. Only messages after the side-conversation boundary are active instructions.

Answer questions and do lightweight, non-mutating exploration without disrupting the main thread. Do not use or interact with herdr agents. Do not modify workspace state unless the operator explicitly asks for that mutation in this side conversation; if asked, keep it minimal and local.`;
const SIDE_CONVERSATION_BOUNDARY = `Side conversation boundary.

Everything before this boundary is inherited history from the parent conversation. It is reference context only, not your current task. Do not continue, execute, or complete instructions, plans, tool calls, approvals, edits, or requests from before this boundary.

Only messages submitted after this boundary are active operator instructions for this side conversation. If there is no message after the boundary yet, wait for one.`;

/** Pi's native current-leaf clone, with one hidden boundary appended to the child. */
export function cloneSideConversationSession(
  source: string,
  cwd: string,
  sessionDir: string,
): SessionManager {
  const manager = SessionManager.open(source, sessionDir, cwd);
  const leafId = manager.getLeafId();
  if (leafId === null || manager.createBranchedSession(leafId) === undefined) {
    throw new Error("Failed to clone the conversation's current Pi branch");
  }
  manager.appendCustomMessageEntry("clankie.side-conversation-boundary", SIDE_CONVERSATION_BOUNDARY, false);
  return manager;
}
/**
 * How long a Discord turn may show no sign of life before it is declared dead.
 *
 * This is not a limit on how long he may take. Asking him to look something up
 * — a bracket, a page, a task worth real work — is a thing the room is allowed
 * to do, and a clock that cuts the answer off at some tidy number turns honest
 * slowness into failure. He posts a text update (`send_text_update`) and takes
 * the time the work takes.
 *
 * What is bounded is silence *inside* the machine. A turn that is working emits
 * events continuously — tokens, tool calls, retries — so five minutes with not
 * one of them is not a long thought, it is a dead stream nothing will revive:
 * on 2026-08-17 a provider connection died and the turn sat with zero tokens
 * for six minutes before anything noticed.
 */
export const DISCORD_TURN_STALL_MS = 5 * 60_000;
/**
 * How often the watchdog re-reads the wall clock.
 *
 * A single `setTimeout` is not a deadline on a laptop. This machine suspends,
 * and a suspended timer resumes owing its full remaining delay: a ten-minute
 * backstop once fired twenty-two minutes late, holding a turn — and the room's
 * answer — open the whole time. Re-reading `Date.now()` on a short tick bounds
 * the overshoot to one tick of *awake* time no matter how long the host slept.
 */
const STALL_TICK_MS = 5_000;

/**
 * pi can resolve a failed prompt with a terminal assistant `stopReason: "error"`.
 * Preserve its reason for the existing failure path. Aborts remain the caller's
 * interrupt path.
 */
export class PiRunError extends Error {
  readonly code: string;

  constructor(message: string) {
    const included = includedModelRefusal(message);
    super(included?.message ?? message);
    // Receipts stay content-free; the provider's full reason remains in Pi's tree.
    this.code =
      included?.capped === true ||
      /\busage limit (?:has been )?reached\b|\busage_limit_reached\b|\byou have hit your ChatGPT usage limit\b/iu.test(
        message,
      )
        ? "captain_usage_limit_reached"
        : "captain_model_failed";
  }
}

/** The fleet model proxy's refusals whose `message` is written for the customer (VUH-1371). */
const INCLUDED_MODEL_CAPS = new Set(["allowance_exhausted", "daily_cap", "capability_cap"]);
const INCLUDED_MODEL_REFUSALS = new Set(["escalation_not_in_plan", "no_allowance", "not_entitled"]);

/**
 * A hosted body's included-model refusal, read from Pi's provider error
 * ("OpenAI API error (429): {…}"). The customer sees the proxy's own sentence
 * ("Your included model usage is used up…") instead of an HTTP status and JSON.
 */
function includedModelRefusal(message: string): { message: string; capped: boolean } | undefined {
  const start = message.indexOf("{");
  if (start === -1) return undefined;
  try {
    const body = JSON.parse(message.slice(start)) as { message?: unknown; code?: unknown };
    if (typeof body.message !== "string" || typeof body.code !== "string") return undefined;
    const capped = INCLUDED_MODEL_CAPS.has(body.code);
    return capped || INCLUDED_MODEL_REFUSALS.has(body.code) ? { message: body.message, capped } : undefined;
  } catch {
    return undefined;
  }
}

function piRunFailure(state: PiRunState): PiRunError | undefined {
  const last = state.messages.at(-1);
  if (last?.role !== "assistant" || last.stopReason !== "error") return undefined;
  return new PiRunError(last.errorMessage ?? "The model run failed without a reason.");
}

/**
 * One turn against a durable lane (ADR 0091). An idle lane starts the run and
 * carries the final reply. A lane already mid-run gets the message steered
 * into the live run — pi delivers it at the next turn boundary and keeps the
 * loop alive until the queue drains — and the caller reports "absorbed" once
 * the merged run settles: the runner's reply answers everything heard, so an
 * absorbed turn must stay silent rather than double-speak.
 *
 * A pi error fails both the owning turn and absorbed turns. The owner carries
 * pi's reason; absorbed turns retain their existing failed-run error.
 */
export async function runDurableTurn(
  lane: {
    readonly session: Pick<AgentSession, "isStreaming" | "prompt"> &
      Partial<Pick<AgentSession, "subscribe">> & { readonly state: PiRunState };
    readonly capture: TurnContext;
    running?: Promise<boolean> | undefined;
    runningDeliveryId?: string | undefined;
    starting?: Promise<void> | undefined;
  },
  prompt: string,
  images: ImageContent[],
  options?: {
    expandPromptTemplates?: boolean;
    deliveryId?: string;
    onAbsorbed?: (deliveryId: string | undefined) => void;
    onAdmitted?: (state: "started" | "steered") => void;
    /** Reserved actual run owner only; returned prompt is committed synchronously with prompt(). */
    preparePrompt?: () => Promise<() => string>;
    signal?: AbortSignal;
  },
): Promise<"ran" | "absorbed"> {
  const expandPromptTemplates = options?.expandPromptTemplates ?? false;
  for (;;) {
    options?.signal?.throwIfAborted();
    const running = lane.running;
    if (running === undefined && lane.starting === undefined) {
      let prepared: (() => string) | undefined;
      let release: (() => void) | undefined;
      if (options?.preparePrompt !== undefined) {
        const reservation = new Promise<void>((resolve) => {
          release = resolve;
        });
        lane.starting = reservation;
        let stopWaiting: (() => void) | undefined;
        try {
          const cancelled = new Promise<never>((_resolve, reject) => {
            const abort = () => reject(new Error("durable_turn_cancelled"));
            options.signal?.addEventListener("abort", abort, { once: true });
            stopWaiting = () => options.signal?.removeEventListener("abort", abort);
            if (options.signal?.aborted) abort();
          });
          prepared = await Promise.race([options.preparePrompt(), cancelled]);
          options.signal?.throwIfAborted();
          if (lane.starting !== reservation || lane.running !== undefined || lane.session.isStreaming)
            throw new Error("durable_turn_admission_changed");
        } catch (error) {
          if (lane.starting === reservation) lane.starting = undefined;
          release!();
          throw error;
        } finally {
          stopWaiting?.();
        }
      }
      // The idle check and the prompt() call share one synchronous stretch —
      // with template expansion off pi reaches its own streaming check without
      // awaiting — so the state observed here is the state it acts on.
      lane.capture.media = undefined;
      lane.runningDeliveryId = options?.deliveryId;
      // Only the invocation owning prompt() may claim its asynchronous start.
      // Other invocations can be waiting here to steer or start a later turn.
      const stopAdmission = lane.session.subscribe?.((event) => {
        if (event.type === "agent_start") options?.onAdmitted?.("started");
      });
      let run: Promise<void>;
      try {
        run = lane.session.prompt(prepared?.() ?? prompt, { expandPromptTemplates, images });
        if (lane.session.isStreaming) options?.onAdmitted?.("started");
      } catch (error) {
        stopAdmission?.();
        if (release !== undefined) {
          lane.starting = undefined;
          release();
        }
        throw error;
      }
      // A failed pi run resolves exactly like a good one, so the outcome has to
      // be read out of the lane at this run's own settlement — before the fact
      // is shared with absorbed turns, and while the state still describes this
      // run rather than whatever a resumed waiter has since started.
      const settlement = run.then(() => piRunFailure(lane.session.state));
      lane.running = settlement
        .then(
          (failure) => failure === undefined,
          () => false,
        )
        .finally(() => {
          lane.running = undefined;
        });
      if (release !== undefined) {
        lane.starting = undefined;
        release();
      }
      try {
        await run;
        const failure = await settlement;
        if (failure !== undefined) throw failure;
        return "ran";
      } finally {
        stopAdmission?.();
      }
    }
    if (lane.session.isStreaming) {
      options?.onAbsorbed?.(lane.runningDeliveryId);
      await lane.session.prompt(prompt, {
        expandPromptTemplates,
        streamingBehavior: "steer",
        images,
      });
      options?.onAdmitted?.("steered");
      if (running === undefined || !(await running)) {
        throw new Error("The run this turn was steered into failed");
      }
      return "absorbed";
    }
    // A run is accepted but not streaming yet, still preparing, or is winding
    // down: wait it out and re-decide.
    await (lane.starting ?? running);
  }
}

/**
 * Run a Discord turn for as long as it keeps working, aborting only once it
 * has gone quiet inside for {@link DISCORD_TURN_STALL_MS}.
 *
 * The session's own event stream is the liveness signal: a token, a tool call,
 * a retry — anything at all — is proof the turn is still a turn, and resets the
 * clock. An executing tool keeps the turn alive until it ends, with its own
 * timeout and cancellation. Nothing here caps total duration, because the
 * length of an answer is the length of the work behind it.
 *
 * Every Discord turn goes through here, one-shot and durable alike. A durable
 * lane had no backstop at all before, which was survivable only while text was
 * one-shot; a shared lane that wedges takes every speaker in the channel down
 * with it, so it is the path that needs the watchdog most.
 */
export async function runTurnWithStallWatchdog<T>(
  session: Pick<AgentSession, "abort" | "subscribe">,
  start: (signal: AbortSignal) => Promise<T>,
  options: { stallMs?: number; now?: () => number; signal?: AbortSignal } = {},
): Promise<{ completed: true; value: T } | { completed: false }> {
  const now = options.now ?? Date.now;
  const stallMs = options.stallMs ?? DISCORD_TURN_STALL_MS;
  const cancellation = new AbortController();
  let lastSignAtMs = now();
  const executingTools = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renew = (): void => {};
  const stalled = new Promise<false>((resolve) => {
    const tick = (): void => {
      timer = undefined;
      if (executingTools.size > 0) return;
      const quietFor = now() - lastSignAtMs;
      if (quietFor >= stallMs) {
        resolve(false);
        cancellation.abort();
        return;
      }
      timer = setTimeout(tick, Math.min(STALL_TICK_MS, stallMs - quietFor));
      timer.unref?.();
    };
    renew = tick;
    tick();
  });
  const unsubscribe = session.subscribe((event) => {
    lastSignAtMs = now();
    if (event.type === "tool_execution_start") executingTools.add(event.toolCallId);
    else if (event.type === "tool_execution_end") executingTools.delete(event.toolCallId);
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    renew();
  });
  try {
    const work = start(cancellation.signal).then((value) => ({ value }));
    const outcome = await Promise.race([
      options.signal === undefined ? work : waitForConversationRun(work, options.signal),
      stalled,
    ]);
    if (outcome === false) {
      void session.abort().catch(() => undefined);
      return { completed: false };
    }
    return { completed: true, value: outcome.value };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
  }
}

/** A one-shot Discord turn under the shared watchdog; `false` means it went dead, not slow. */
export async function runOneShotDiscordTurn(
  session: Pick<AgentSession, "abort" | "prompt" | "subscribe"> & { readonly state: PiRunState },
  prompt: string,
  images: ImageContent[],
  stallMs = DISCORD_TURN_STALL_MS,
): Promise<boolean> {
  const outcome = await runTurnWithStallWatchdog(
    session,
    async () => {
      await session.prompt(prompt, { expandPromptTemplates: false, images });
      const failure = piRunFailure(session.state);
      if (failure !== undefined) throw failure;
    },
    { stallMs },
  );
  return outcome.completed;
}

/**
 * The captain on pi. Sessions are pi's JSONL trees throughout: continuing ones
 * for operator conversations and durable Discord lanes, and a fresh tree for
 * every actor-level system grant in a shared room. Nothing carries forward out
 * of a one-shot — the bounded channel history arrives with each request — but
 * its tree stays because that is the only record of the tools it ran (ADR
 * 0107). The persona still comes from owner-authored settings, never from the
 * caller.
 */
/**
 * Wakes, watches, worker messages, Linear activity and human sends reach their
 * conversation seat. Goal continuations stay with their Pi loop.
 */
export function seatEventKindFor(
  context: Pick<ConversationTurnContext, "internal" | "origin">,
  isHeadConversation: boolean,
): OperatorSeatEventKind | undefined {
  if (context.internal === true) {
    if (context.origin === "hook") return "wake";
    if (context.origin === "wake" || context.origin === "watch" || context.origin === "message")
      return context.origin;
    return undefined;
  }
  return isHeadConversation ? "escalation" : undefined;
}

export function assistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("");
}

export function toImageContent(attachment: ResolvedAttachment): ImageContent {
  const comma = attachment.dataUrl.indexOf(",");
  return {
    type: "image",
    data: comma === -1 ? attachment.dataUrl : attachment.dataUrl.slice(comma + 1),
    mimeType: attachment.mediaType,
  };
}
