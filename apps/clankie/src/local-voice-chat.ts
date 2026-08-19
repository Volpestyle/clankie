import { Buffer } from "node:buffer";
import {
  LocalVoiceChatClientEventSchema,
  LocalVoiceChatServerEventSchema,
  createOperatorConversationServiceClient,
  type LocalVoiceChatServerEvent,
  type OperatorConversationServiceClient,
} from "@clankie/protocol";
import {
  ASK_CLANKIE_TOOL_NAME,
  type RealtimeFunctionCall,
  type TranscriptVoiceRealtimePorts,
  type VoiceConversationPort,
  type VoiceTranscriptionPort,
} from "@clankie/discord-presence-core";
import type { CaptainPort } from "./captain/port.ts";

const OUTPUT_BACKPRESSURE_BYTES = 512 * 1024;
const SURFACE_CLIENT_ID = "clankie-menu-bar-voice";
const HANDOFF_FAILURE = "I couldn't reach my captain just now. Give me a moment and ask again.";

export interface LocalVoiceSocket {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

export interface LocalVoiceChatOptions {
  readonly realtime: TranscriptVoiceRealtimePorts;
  readonly captain: CaptainPort;
  readonly instructions: string;
  readonly briefing: string;
  readonly clock?: () => Date;
}

/** One private, authenticated loopback voice call. Raw PCM is never retained. */
export class LocalVoiceChatSession {
  private readonly options: LocalVoiceChatOptions;
  private readonly operator: OperatorConversationServiceClient;
  private readonly abort = new AbortController();
  private readonly clock: () => Date;
  private transcription: VoiceTranscriptionPort | undefined;
  private conversation: VoiceConversationPort | undefined;
  private socket: LocalVoiceSocket | undefined;
  private operatorConversationId: string | undefined;
  private toolQueue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(options: LocalVoiceChatOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => new Date());
    this.operator = createOperatorConversationServiceClient(
      (request) => options.captain.serveOperatorConversation(request),
      { tailIdleMs: 100 },
    );
  }

  public static async open(options: LocalVoiceChatOptions): Promise<LocalVoiceChatSession> {
    const session = new LocalVoiceChatSession(options);
    await session.start();
    return session;
  }

  public attach(socket: LocalVoiceSocket): void {
    if (this.closed) {
      socket.close(1011, "voice_session_closed");
      return;
    }
    this.socket = socket;
    this.emit({ schemaVersion: 1, type: "status", state: "listening" });
  }

  public receiveAudio(bytes: Uint8Array): void {
    if (this.closed || this.transcription?.isOpen !== true) return;
    this.transcription.appendAudio(Buffer.from(bytes));
  }

  public receiveText(text: string): void {
    const parsed = LocalVoiceChatClientEventSchema.safeParse(safeJson(text));
    if (!parsed.success || this.transcription?.isOpen !== true) {
      this.emitError("Invalid local voice event");
      return;
    }
    this.transcription.commitAudio();
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    this.transcription?.close();
    this.conversation?.close();
    this.transcription = undefined;
    this.conversation = undefined;
    this.socket = undefined;
  }

  private async start(): Promise<void> {
    try {
      const [transcription, conversation] = await Promise.all([
        this.options.realtime.openTranscription({
          onTranscript: (event) => {
            const text = event.text.trim();
            if (text.length === 0) return;
            this.emitTranscript("operator", text, event.final);
            if (!event.final) return;
            const current = this.conversation;
            if (current?.isOpen !== true) return;
            current.createTextItem(`Operator: ${text}`);
            current.createResponse();
            this.emit({ schemaVersion: 1, type: "status", state: "thinking" });
          },
          onClose: (reason) => {
            if (reason !== "closed") this.fail("Local voice transcription ended");
          },
          onError: (message) => this.emitError(message),
        }),
        this.options.realtime.openConversation({
          instructions: this.options.instructions,
          onAudioDelta: (pcm) => this.sendAudio(pcm),
          onTranscript: (event) => {
            const text = event.text.trim();
            if (text.length > 0) this.emitTranscript("clankie", text, event.final);
          },
          onFunctionCall: (call) => this.enqueueFunctionCall(call),
          onResponseDone: () => {
            this.emit({ schemaVersion: 1, type: "response_done" });
            this.emit({ schemaVersion: 1, type: "status", state: "listening" });
          },
          onClose: (reason) => {
            if (reason !== "closed") this.fail("Local voice conversation ended");
          },
          onError: (message) => this.emitError(message),
        }),
      ]);
      this.transcription = transcription;
      this.conversation = conversation;
      if (this.options.briefing.trim().length > 0) conversation.createTextItem(this.options.briefing);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  private sendAudio(pcm: Buffer): void {
    try {
      const socket = this.socket;
      if (socket === undefined) return;
      if (socket.bufferedAmount > OUTPUT_BACKPRESSURE_BYTES) {
        this.fail("Local voice playback fell behind");
        return;
      }
      this.emit({ schemaVersion: 1, type: "status", state: "speaking" });
      socket.send(Uint8Array.from(pcm));
    } finally {
      pcm.fill(0);
    }
  }

  private enqueueFunctionCall(call: RealtimeFunctionCall): void {
    this.toolQueue = this.toolQueue
      .then(async () => {
        const conversation = this.conversation;
        if (conversation?.isOpen !== true) return;
        if (call.name !== ASK_CLANKIE_TOOL_NAME) {
          conversation.submitFunctionResult(
            call.callId,
            "Use ask_clankie for that from this private local voice chat.",
          );
          return;
        }
        const request = askClankieRequest(call.argumentsJson);
        const answer = request === undefined ? HANDOFF_FAILURE : await this.askCaptain(request);
        if (conversation.isOpen) conversation.submitFunctionResult(call.callId, answer);
      })
      .catch(() => {
        const conversation = this.conversation;
        if (conversation?.isOpen === true) conversation.submitFunctionResult(call.callId, HANDOFF_FAILURE);
      });
  }

  private async askCaptain(message: string): Promise<string> {
    const conversationId = await this.operatorConversation();
    const conversation = await this.operator.get(conversationId);
    if (conversation === undefined) return HANDOFF_FAILURE;
    const accepted = await this.operator.send({
      schemaVersion: 1,
      kind: "message",
      conversationId,
      surfaceClientId: SURFACE_CLIENT_ID,
      expectedRevision: conversation.revision,
      message,
    });
    if (accepted.status !== "accepted") return HANDOFF_FAILURE;
    let reply = "";
    for await (const item of this.operator.tail(
      {
        schemaVersion: 1,
        conversationId,
        surfaceClientId: SURFACE_CLIENT_ID,
        cursor: accepted.safeCursor,
      },
      this.abort.signal,
    )) {
      if (item.kind === "recovery") return HANDOFF_FAILURE;
      const event = item.event;
      if (event.type === "message" && event.role === "captain" && !event.streaming) reply = event.text;
      if (event.type === "input_requested") {
        return "I need you to continue that request in the authenticated operator console.";
      }
      if (event.type === "turn" && event.runId === accepted.runId && event.phase !== "accepted") {
        return event.phase === "completed" && reply.trim().length > 0 ? reply : HANDOFF_FAILURE;
      }
    }
    return HANDOFF_FAILURE;
  }

  private async operatorConversation(): Promise<string> {
    if (this.operatorConversationId !== undefined) return this.operatorConversationId;
    const created = await this.operator.create({
      scope: { kind: "global" },
      title: `Voice chat · ${this.clock().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`,
    });
    this.operatorConversationId = created.conversationId;
    return created.conversationId;
  }

  private emitTranscript(speaker: "operator" | "clankie", text: string, final: boolean): void {
    this.emit({
      schemaVersion: 1,
      type: "transcript",
      speaker,
      text,
      final,
      occurredAt: this.clock().toISOString(),
    });
  }

  private emitError(message: string): void {
    this.emit({ schemaVersion: 1, type: "error", message: message.slice(0, 512) || "Local voice error" });
  }

  private fail(message: string): void {
    this.emitError(message);
    this.socket?.close(1011, "voice_session_failed");
    this.close();
  }

  private emit(event: LocalVoiceChatServerEvent): void {
    const socket = this.socket;
    if (socket === undefined) return;
    socket.send(JSON.stringify(LocalVoiceChatServerEventSchema.parse(event)));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function askClankieRequest(argumentsJson: string): string | undefined {
  const parsed = safeJson(argumentsJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const request = (parsed as Record<string, unknown>).request;
  if (typeof request !== "string") return undefined;
  const trimmed = request.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
