/** Text-only voice brain. The existing external voice port owns ElevenLabs and the floor. */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createLanguageModel } from "@clankie/model-provider";
import {
  jsonSchema,
  streamText,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type ToolCallPart,
} from "ai";
import type { ExternalVoiceRealtimeHandlers, ExternalVoiceRealtimePort } from "./external-voice.ts";
import {
  DEFAULT_REALTIME_SESSION_LIFETIME_MS,
  MAX_REALTIME_IMAGE_CHARACTERS,
  MAX_REALTIME_INSTRUCTIONS_CHARACTERS,
  MAX_REALTIME_RESPONSE_TEXT_CHARACTERS,
  MAX_REALTIME_TEXT_ITEM_CHARACTERS,
  VOICE_CONVERSATION_TOOLS,
  type RealtimeTimers,
  type RealtimeSessionCloseReason,
} from "./realtime-session.ts";

export interface AnthropicVoiceConversationOptions extends ExternalVoiceRealtimeHandlers {
  readonly apiKey: string;
  readonly model: string;
  readonly instructions: string;
  readonly fetchImpl?: typeof fetch;
  /** Revalidate the host after asynchronous admission and immediately before provider egress. */
  readonly guard?: () => Promise<void>;
  readonly current?: () => boolean;
  readonly timers?: RealtimeTimers;
  readonly maxLifetimeMs?: number;
  /** Serialized retained messages, including images and tool results; instructions have their own bound. */
  readonly contextCharacterLimit?: number;
  readonly retentionRatio?: number;
}

// Adaptive reasoning shares the output budget with spoken text and tool inputs.
const MAX_OUTPUT_TOKENS = 4_096;
export const DEFAULT_ANTHROPIC_VOICE_MODEL = "claude-sonnet-5-5";
const DEFAULT_CONTEXT_CHARACTERS = 48_000;
const MAX_CONTEXT_CHARACTERS = 512_000;
const MAX_TOOL_CALLS = 16;
const MAX_REMEMBERED_CALL_IDS = 4_096;
const globalTimers: RealtimeTimers = {
  setTimeout: (handler, delay) => setTimeout(handler, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface HistoryGroup {
  messages: ModelMessage[];
  /** A tool-use message and all its results are one indivisible retention group. */
  calls: Map<string, { name: string; output: string | undefined; dispatched: boolean }>;
}

interface Response {
  readonly id: string;
  readonly controller: AbortController;
  readonly shouldStart: (() => boolean) | undefined;
  group?: HistoryGroup;
  text: string;
  terminal: boolean;
  running: boolean;
  committed: boolean;
  newGroup: boolean;
  historyStartLength: number;
}

class AnthropicVoiceConversation implements ExternalVoiceRealtimePort {
  private readonly options: AnthropicVoiceConversationOptions;
  private readonly tools: ToolSet;
  private readonly timers: RealtimeTimers;
  private readonly lifetimeHandle: unknown;
  private readonly contextLimit: number;
  private readonly retentionRatio: number;
  private readonly history: HistoryGroup[] = [];
  private readonly incoming: ModelMessage[] = [];
  private readonly seenCallIds = new Set<string>();
  private active: Response | undefined;
  private closed = false;

  public constructor(options: AnthropicVoiceConversationOptions) {
    this.options = options;
    boundedText(options.instructions, MAX_REALTIME_INSTRUCTIONS_CHARACTERS, "instructions");
    if (!options.apiKey.trim() || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(options.model)) {
      throw new Error("Anthropic voice requires an API key and native model id");
    }
    this.contextLimit = boundedInteger(
      options.contextCharacterLimit ?? DEFAULT_CONTEXT_CHARACTERS,
      256,
      MAX_CONTEXT_CHARACTERS,
    );
    this.retentionRatio = options.retentionRatio ?? 0.7;
    if (!Number.isFinite(this.retentionRatio) || this.retentionRatio <= 0 || this.retentionRatio > 1) {
      throw new Error("Anthropic voice retention ratio must be greater than zero and at most one");
    }
    // Eager credential-policy validation is local. Each request then gets its own fenced fetch closure.
    this.createModel();
    this.tools = Object.fromEntries(
      VOICE_CONVERSATION_TOOLS.map((definition) => [
        definition.name,
        {
          description: definition.description,
          inputSchema: jsonSchema(JSON.parse(JSON.stringify(definition.parameters)) as JSONSchema7),
          // No execute callback: only the authenticated voice session can admit an action.
        },
      ]),
    );
    this.timers = options.timers ?? globalTimers;
    this.lifetimeHandle = this.timers.setTimeout(
      () => this.closeWith("lifetime"),
      boundedInteger(options.maxLifetimeMs ?? DEFAULT_REALTIME_SESSION_LIFETIME_MS, 10_000, 4 * 60 * 60_000),
    );
  }

  public get isOpen(): boolean {
    return !this.closed;
  }

  public appendAudio(pcm: Buffer): void {
    pcm.fill(0);
    throw new Error("Anthropic voice accepts transcribed text, not audio");
  }

  public createTextItem(text: string): void {
    this.assertOpen();
    boundedText(text, MAX_REALTIME_TEXT_ITEM_CHARACTERS, "text item");
    this.addIncoming({ role: "user", content: text });
  }

  public createImageItem(pngBase64: string, mimeType: "image/png" = "image/png"): void {
    this.assertOpen();
    if (
      mimeType !== "image/png" ||
      !pngBase64 ||
      pngBase64.length > MAX_REALTIME_IMAGE_CHARACTERS ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(pngBase64)
    ) {
      throw new Error("Anthropic voice image must be bounded base64 PNG data");
    }
    this.addIncoming({ role: "user", content: [{ type: "file", data: pngBase64, mediaType: mimeType }] });
  }

  public createResponse(context?: string, shouldStart?: () => boolean): void {
    this.assertOpen();
    if (this.active !== undefined) throw new Error("Anthropic voice response is already pending");
    if (shouldStart?.() === false || this.closed) return;
    if (context !== undefined) this.createTextItem(context);
    const response: Response = {
      id: `voice_${randomUUID()}`,
      controller: new AbortController(),
      shouldStart,
      text: "",
      terminal: false,
      running: false,
      committed: false,
      newGroup: true,
      historyStartLength: 0,
    };
    this.active = response;
    // Bind the media owner's pending before any fetch or asynchronous tool-result wait.
    this.options.onResponseStarted({ requestEventId: response.id, responseId: response.id });
    this.startIfReady(response);
  }

  public cancelResponse(requestEventId: string): void {
    const response = this.active;
    if (response?.id !== requestEventId) return;
    response.controller.abort();
    if (response.committed && response.group !== undefined && this.refuseSignedHistoryEdit()) return;
    // Keep only text already delivered. Undispatched tool calls never enter history or authority callbacks.
    if (!response.committed && response.group !== undefined && response.text)
      response.group.messages.push({ role: "assistant", content: response.text });
    if (response.committed && response.group !== undefined) this.discardUndispatchedCalls(response.group);
    this.done(response, "cancelled");
  }

  public submitFunctionResult(callId: string, output: string, shouldRespond?: false | (() => boolean)): void {
    this.assertOpen();
    const group = this.history.find((candidate) => candidate.calls.has(callId));
    const call = group?.calls.get(callId);
    if (group === undefined || call === undefined || !call.dispatched || call.output !== undefined) {
      throw new Error("Anthropic voice function result has no pending call");
    }
    try {
      boundedText(output, MAX_REALTIME_TEXT_ITEM_CHARACTERS, "function result");
      call.output = output;
      this.makeRoom();
      this.finishResults(group);
      this.makeRoom();
    } catch {
      // The authority path does not retry a completed tool. Leaving its result pending would wedge every turn.
      if (!this.closed) {
        this.options.onError("Anthropic voice function result exceeded the context limit");
        this.closeWith("error");
      }
      throw new Error("Anthropic voice function result exceeded the context limit");
    }
    if (this.active !== undefined) this.startIfReady(this.active);
    else if (shouldRespond !== false) this.createResponse(undefined, shouldRespond);
  }

  public settleFunctionCallSilently(callId: string, resume?: false): void {
    if (resume === false) {
      this.assertOpen();
      const call = this.history.find((group) => group.calls.has(callId))?.calls.get(callId);
      if (call === undefined || !call.dispatched || call.output !== undefined)
        throw new Error("Anthropic voice function result has no pending call");
      // A revoked actor must not unblock a waiting paid response or edit signed provider history.
      this.options.onError("Anthropic voice tool admission is no longer current");
      this.closeWith("error");
      return;
    }
    this.submitFunctionResult(callId, "", false);
  }

  public close(): void {
    this.closeWith("closed");
  }

  private addIncoming(message: ModelMessage): void {
    this.incoming.push(message);
    try {
      this.makeRoom();
    } catch {
      this.incoming.pop();
      throw new Error("Anthropic voice context limit exceeded");
    }
  }

  private contextSize(): number {
    return (
      JSON.stringify(this.incoming).length +
      this.history.reduce(
        (size, group) =>
          size +
          JSON.stringify([...group.messages, ...(group.calls.size ? [this.toolResults(group)] : [])]).length,
        0,
      )
    );
  }

  private toolResults(group: HistoryGroup): ModelMessage {
    return {
      role: "tool",
      content: [...group.calls].map(([id, result]) => ({
        type: "tool-result" as const,
        toolCallId: id,
        toolName: result.name,
        output: { type: "text" as const, value: result.output ?? "" },
      })),
    };
  }

  private finishResults(group: HistoryGroup): void {
    if (group.calls.size !== 0 && [...group.calls.values()].every((call) => call.output !== undefined)) {
      group.messages.push(this.toolResults(group));
      group.calls.clear();
    }
  }

  private discardUndispatchedCalls(group: HistoryGroup): void {
    const discarded = new Set([...group.calls].filter(([, call]) => !call.dispatched).map(([id]) => id));
    if (discarded.size === 0) return;
    if (this.refuseSignedHistoryEdit()) return;
    for (const id of discarded) group.calls.delete(id);
    for (const message of group.messages) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        message.content = message.content.filter(
          (part) => part.type !== "tool-call" || !discarded.has(part.toolCallId),
        );
      }
    }
    group.messages = group.messages.filter(
      (message) => !Array.isArray(message.content) || message.content.length !== 0,
    );
    this.finishResults(group);
  }

  private refuseSignedHistoryEdit(): boolean {
    if (
      !this.history.some((group) =>
        group.messages.some(
          (message) =>
            message.role === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "reasoning"),
        ),
      )
    )
      return false;
    this.options.onError("Anthropic voice signed history cannot be changed; start a new call");
    this.closeWith("error");
    return true;
  }

  private discardFailedResponse(response: Response): void {
    if (response.group === undefined) return;
    if (this.refuseSignedHistoryEdit()) return;
    if (response.committed) this.discardUndispatchedCalls(response.group);
    else if (response.newGroup) this.history.splice(this.history.indexOf(response.group), 1);
    else response.group.messages.length = response.historyStartLength;
  }

  private makeRoom(): void {
    if (this.contextSize() <= this.contextLimit) return;
    // Sonnet 5.5 signs thinking against the exact preceding messages. Dropping an earlier
    // exchange would invalidate every retained signature; rotate the brain instead.
    if (this.refuseSignedHistoryEdit()) throw new Error("Anthropic voice context limit exceeded");
    const target = Math.floor(this.contextLimit * this.retentionRatio);
    // Never evict an active request or half of a tool exchange, even to accommodate newer room data.
    while (this.contextSize() > target) {
      const first = this.history[0];
      if (first === undefined || first === this.active?.group || first.calls.size !== 0) break;
      this.history.shift();
    }
    if (this.contextSize() > this.contextLimit) throw new Error("Anthropic voice context limit exceeded");
  }

  private startIfReady(response: Response): void {
    if (!this.current(response) || response.running || this.history.some((group) => group.calls.size !== 0))
      return;
    if (!this.admitted(response)) return;
    response.running = true;
    // A tool continuation with no new user data belongs to the same complete exchange.
    // Pruning must never leave its assistant reply as an orphaned first message.
    const previous = this.history.at(-1);
    const group: HistoryGroup =
      this.incoming.length === 0 && previous !== undefined
        ? previous
        : { messages: this.incoming.splice(0), calls: new Map() };
    response.newGroup = group !== previous;
    response.historyStartLength = group.messages.length;
    response.group = group;
    if (response.newGroup) this.history.push(group);
    try {
      this.makeRoom();
      void this.generate(
        response,
        this.history.flatMap((candidate) => candidate.messages),
      );
    } catch {
      if (!this.current(response)) return;
      this.options.onError("Anthropic voice context limit exceeded");
      this.abandon(response);
    }
  }

  private createModel(response?: Response): LanguageModel {
    return createLanguageModel({
      provider: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: [], models: {} },
      modelId: this.options.model,
      credential: { type: "api", key: this.options.apiKey },
      env: {},
      fetchImpl: async (input, init) => {
        await this.options.guard?.();
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        if (
          response === undefined ||
          !this.current(response) ||
          this.options.current?.() === false ||
          response.shouldStart?.() === false ||
          signal?.aborted
        ) {
          response?.controller.abort();
          throw new Error("Anthropic voice admission is no longer current");
        }
        return (this.options.fetchImpl ?? globalThis.fetch)(input, init);
      },
    });
  }

  private async generate(response: Response, messages: ModelMessage[]): Promise<void> {
    const calls: ToolCallPart[] = [];
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let toolInputCharacters = 0;
    let serializedToolCharacters = 0;
    let toolStarts = 0;
    let hiddenCharacters = 0;
    let hadReasoning = false;
    let finished = false;
    try {
      const result = streamText({
        model: this.createModel(response),
        system: this.options.instructions,
        messages,
        tools: this.tools,
        maxRetries: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        providerOptions: {
          anthropic: { thinking: { type: "adaptive", display: "omitted" }, effort: "high" },
        },
        abortSignal: response.controller.signal,
        onError: () => {
          /* Provider errors can echo keys or room data; the terminal catch emits a static error. */
        },
      });
      for await (const part of result.fullStream) {
        if (!this.admitted(response)) return;
        if (part.type === "error" || part.type === "tool-error" || part.type === "abort")
          throw new Error("provider failed");
        if ("providerMetadata" in part && part.providerMetadata !== undefined)
          hiddenCharacters += JSON.stringify(part.providerMetadata).length;
        if (part.type === "reasoning-delta") {
          hadReasoning = true;
          hiddenCharacters += part.text.length;
        } else if (part.type === "reasoning-start") hadReasoning = true;
        if (hiddenCharacters > this.contextLimit) throw new Error("provider reasoning bound");
        if (part.type === "text-delta") {
          response.text += part.text;
          if (response.text.length > MAX_REALTIME_RESPONSE_TEXT_CHARACTERS) throw new Error("response bound");
          this.options.onTextDelta(part.text, response.id);
        } else if (part.type === "tool-input-start") {
          if (
            ++toolStarts > MAX_TOOL_CALLS ||
            !Object.hasOwn(this.tools, part.toolName) ||
            part.id.length > 256
          ) {
            throw new Error("invalid tool start");
          }
        } else if (part.type === "tool-input-delta") {
          toolInputCharacters += part.delta.length;
          if (toolInputCharacters > MAX_REALTIME_TEXT_ITEM_CHARACTERS)
            throw new Error("tool arguments bound");
        } else if (part.type === "tool-call") {
          if (
            part.invalid ||
            part.providerExecuted ||
            !Object.hasOwn(this.tools, part.toolName) ||
            calls.length >= MAX_TOOL_CALLS ||
            !part.toolCallId ||
            part.toolCallId.length > 256 ||
            this.seenCallIds.has(part.toolCallId) ||
            calls.some((call) => call.toolCallId === part.toolCallId)
          )
            throw new Error("invalid tool call");
          const input = JSON.stringify(part.input);
          boundedText(input, MAX_REALTIME_TEXT_ITEM_CHARACTERS, "tool arguments");
          serializedToolCharacters += input.length;
          if (serializedToolCharacters > MAX_REALTIME_TEXT_ITEM_CHARACTERS)
            throw new Error("tool arguments bound");
          calls.push({
            type: "tool-call",
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
        } else if (part.type === "finish") {
          finished = true;
          inputTokens = part.totalUsage.inputTokens;
          outputTokens = part.totalUsage.outputTokens;
          if (part.finishReason === "error" || part.finishReason === "other")
            throw new Error("provider failed");
          if (part.finishReason === "length" || part.finishReason === "content-filter")
            throw new Error("provider output incomplete");
        }
      }
      if (!this.admitted(response)) return;
      if (!finished) throw new Error("provider ended before completion");
      const responseMessages = await result.responseMessages;
      // SDK metadata completion is another asynchronous boundary before history or authority dispatch.
      if (!this.admitted(response)) return;
      if (hadReasoning && !response.text && calls.length === 0)
        throw new Error("provider produced only reasoning");
      if (JSON.stringify(responseMessages).length > this.contextLimit)
        throw new Error("provider history bound");
      for (const message of responseMessages) {
        if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (part.type !== "reasoning") continue;
          const signature = part.providerOptions?.anthropic?.signature;
          const redactedData = part.providerOptions?.anthropic?.redactedData;
          if (
            !(typeof signature === "string" && signature.length > 0) &&
            !(typeof redactedData === "string" && redactedData.length > 0)
          )
            throw new Error("provider reasoning has no replayable signature");
        }
      }
      const group = response.group!;
      // SDK7 supplies the canonical ordering and opaque Anthropic thinking signatures/redaction.
      // Rebuilding text/tool messages loses information required by the next native request.
      group.messages.push(...responseMessages);
      for (const call of calls) {
        group.calls.set(call.toolCallId, { name: call.toolName, output: undefined, dispatched: false });
      }
      this.makeRoom();
      response.committed = true;
      if (this.seenCallIds.size + calls.length > MAX_REMEMBERED_CALL_IDS)
        throw new Error("tool identity bound");
      // Register the entire batch before callbacks: concurrent synchronous results stay adjacent.
      for (const call of calls) this.seenCallIds.add(call.toolCallId);
      for (const call of calls) {
        if (!this.admitted(response)) return;
        group.calls.get(call.toolCallId)!.dispatched = true;
        this.options.onFunctionCall({
          callId: call.toolCallId,
          name: call.toolName,
          argumentsJson: JSON.stringify(call.input),
        });
      }
      if (this.admitted(response)) this.done(response, "completed", inputTokens, outputTokens);
    } catch {
      if (!this.current(response)) return;
      response.controller.abort();
      // A failed incomplete exchange is never fed back or automatically retried.
      this.discardFailedResponse(response);
      if (!this.current(response)) return;
      this.options.onError("Anthropic voice response failed");
      this.abandon(response);
    }
  }

  private current(response: Response): boolean {
    return !this.closed && this.active === response && !response.terminal;
  }

  private admitted(response: Response): boolean {
    if (!this.current(response)) return false;
    if (this.options.current?.() !== false && response.shouldStart?.() !== false) return true;
    response.controller.abort();
    this.discardFailedResponse(response);
    if (!this.current(response)) return false;
    this.options.onError("Anthropic voice admission is no longer current");
    this.abandon(response);
    return false;
  }

  private done(response: Response, status: string, inputTokens?: number, outputTokens?: number): void {
    if (!this.current(response)) return;
    response.terminal = true;
    this.active = undefined;
    this.options.onResponseDone({
      requestEventId: response.id,
      responseId: response.id,
      status,
      audioBytes: 0,
      textCharacters: response.text.length,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    });
  }

  private abandon(response: Response): void {
    if (!this.current(response)) return;
    response.terminal = true;
    this.active = undefined;
    this.options.onResponseAbandoned({ requestEventId: response.id, responseId: response.id });
  }

  private closeWith(reason: RealtimeSessionCloseReason): void {
    if (this.closed) return;
    const active = this.active;
    this.closed = true;
    this.active = undefined;
    if (active !== undefined) {
      active.controller.abort();
      active.terminal = true;
    }
    this.timers.clearTimeout(this.lifetimeHandle);
    this.history.length = 0;
    this.incoming.length = 0;
    this.seenCallIds.clear();
    // Close the external wrapper before its abandonment callback can admit queued speech.
    this.options.onClose(reason);
    if (active !== undefined)
      this.options.onResponseAbandoned({ requestEventId: active.id, responseId: active.id });
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Anthropic voice session is closed");
  }
}

function boundedText(value: string, maximum: number, field: string): void {
  if (typeof value !== "string" || value.length > maximum)
    throw new Error(`Anthropic voice ${field} exceeded its character limit`);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error("Anthropic voice limit is outside its supported range");
  return value;
}

export async function openAnthropicVoiceConversation(
  options: AnthropicVoiceConversationOptions,
): Promise<ExternalVoiceRealtimePort> {
  return new AnthropicVoiceConversation(options);
}
