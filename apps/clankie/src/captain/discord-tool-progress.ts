import type {
  DiscordCaptainActionInput,
  DiscordCaptainActionResult,
  DiscordToolProgressCategory,
  DiscordToolProgressPhase,
} from "@clankie/protocol";

const FIRST_CARD_DELAY_MS = 1_000;
const UPDATE_THROTTLE_MS = 1_000;
const HIDDEN_TOOLS = new Set([
  "send_text_update",
  "discord_react",
  "discord_unreact",
  "discord_create_thread",
  "discord_join_thread",
  "discord_watch_start",
  "discord_watch_stop",
]);

interface DiscordToolProgressContext {
  readonly turnId: string;
  readonly actorId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly messageId: string;
}

interface DiscordToolProgressActions {
  execute(input: DiscordCaptainActionInput): Promise<DiscordCaptainActionResult>;
}

/** Content-free projection of Pi tool lifecycle events into one Discord status card. */
export class DiscordToolProgressReporter {
  readonly #context: DiscordToolProgressContext;
  readonly #actions: DiscordToolProgressActions;
  readonly #startedAt = Date.now();
  readonly #active = new Map<string, DiscordToolProgressCategory>();
  readonly #categories = new Set<DiscordToolProgressCategory>();
  #toolCalls = 0;
  #failedToolCalls = 0;
  #progressMessageId: string | undefined;
  #sequence = 0;
  #cardPending = false;
  #firstCardTimer: ReturnType<typeof setTimeout> | undefined;
  #updateTimer: ReturnType<typeof setTimeout> | undefined;
  #lastPublishedAt = 0;
  #writes: Promise<void> = Promise.resolve();

  public constructor(context: DiscordToolProgressContext, actions: DiscordToolProgressActions) {
    this.#context = context;
    this.#actions = actions;
  }

  public toolStarted(toolCallId: string, toolName: string): void {
    if (HIDDEN_TOOLS.has(toolName)) return;
    const category = toolProgressCategory(toolName);
    this.#active.set(toolCallId, category);
    this.#categories.add(category);
    this.#toolCalls += 1;
    if (this.#progressMessageId === undefined && !this.#cardPending) {
      this.#cardPending = true;
      this.#firstCardTimer = setTimeout(() => {
        this.#firstCardTimer = undefined;
        void this.#enqueue("running");
      }, FIRST_CARD_DELAY_MS);
      return;
    }
    this.#scheduleUpdate();
  }

  public toolEnded(toolCallId: string, isError: boolean): void {
    if (!this.#active.delete(toolCallId)) return;
    if (isError) this.#failedToolCalls += 1;
    this.#scheduleUpdate();
  }

  public complete(): Promise<void> {
    return this.#finish("completed");
  }

  public fail(): Promise<void> {
    return this.#finish("failed");
  }

  public async dismiss(): Promise<void> {
    this.#cancelTimers();
    await this.#writes;
    if (this.#progressMessageId !== undefined) await this.#enqueue("dismissed");
  }

  async #finish(phase: "completed" | "failed"): Promise<void> {
    this.#cancelTimers();
    await this.#writes;
    if (this.#progressMessageId !== undefined) await this.#enqueue(phase);
  }

  #scheduleUpdate(): void {
    if (this.#progressMessageId === undefined || this.#updateTimer !== undefined) return;
    const delay = Math.max(0, UPDATE_THROTTLE_MS - (Date.now() - this.#lastPublishedAt));
    this.#updateTimer = setTimeout(() => {
      this.#updateTimer = undefined;
      void this.#enqueue("running");
    }, delay);
  }

  #cancelTimers(): void {
    if (this.#firstCardTimer !== undefined) {
      clearTimeout(this.#firstCardTimer);
      this.#cardPending = false;
    }
    if (this.#updateTimer !== undefined) clearTimeout(this.#updateTimer);
    this.#firstCardTimer = undefined;
    this.#updateTimer = undefined;
  }

  #enqueue(phase: DiscordToolProgressPhase): Promise<void> {
    const write = async (): Promise<void> => {
      const progressMessageId = this.#progressMessageId;
      if (phase !== "running" && progressMessageId === undefined) return;
      try {
        const result = await this.#actions.execute({
          action: "tool_progress",
          callId: `${this.#context.turnId}:tool-progress:${String(++this.#sequence)}`,
          actorId: this.#context.actorId,
          guildId: this.#context.guildId,
          channelId: this.#context.channelId,
          messageId: this.#context.messageId,
          ...(progressMessageId === undefined ? {} : { progressMessageId }),
          phase,
          categories: [...this.#categories],
          toolCalls: this.#toolCalls,
          activeToolCalls: this.#active.size,
          failedToolCalls: this.#failedToolCalls,
          elapsedSeconds: Math.floor((Date.now() - this.#startedAt) / 1_000),
        });
        if (result.ok && result.messageId !== undefined) this.#progressMessageId = result.messageId;
        this.#lastPublishedAt = Date.now();
      } finally {
        if (progressMessageId === undefined) this.#cardPending = false;
      }
    };
    this.#writes = this.#writes.then(write, write).catch(() => undefined);
    return this.#writes;
  }
}

export function toolProgressCategory(toolName: string): DiscordToolProgressCategory {
  const name = toolName.toLowerCase();
  if (name.includes("browser") || name === "youtube_search") return "browsing";
  if (/^(generate_|draw_)/u.test(name) || name.includes("diagram") || name.includes("tldraw")) {
    return "creating_media";
  }
  if (/^(bash|read|write|edit|grep|find|ls|herdr)/u.test(name)) return "working_locally";
  if (/^(pokeagent|music_|game|play)/u.test(name)) return "playing";
  // ponytail: name-prefix categories; add catalog metadata only if real cards are measurably misclassified.
  if (/^(mcp_|email_|linear_|github_|calendar_|slack_|spotify_)/u.test(name)) {
    return "using_connected_services";
  }
  return "using_tools";
}
