import type { HandleMessageStreamEvent } from "eve/client";
import type { ClankieFaceShell, FaceBlockHandle } from "../shell/shell.ts";

export type StepUsage = NonNullable<
  Extract<HandleMessageStreamEvent, { type: "step.completed" }>["data"]["usage"]
>;

const STREAM_RENDER_THROTTLE_MS = 50;
const COLLAPSED = { clickToggle: true, collapsed: true } as const;
const ANSI_ESCAPE_RE = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))`,
  "gu",
);

function stripControlCharacters(text: string): string {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      (code >= 127 && code <= 159)
      ? ""
      : character;
  }).join("");
}

function sanitize(text: string): string {
  return stripControlCharacters(text.replace(/\r\n?/gu, "\n").replace(ANSI_ESCAPE_RE, ""));
}

function json(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}\n… truncated`;
}

function actionName(
  action: Extract<HandleMessageStreamEvent, { type: "actions.requested" }>["data"]["actions"][number],
): string {
  switch (action.kind) {
    case "tool-call":
      return action.toolName;
    case "load-skill":
      return typeof action.input.skill === "string" ? action.input.skill : "load_skill";
    case "subagent-call":
      return action.subagentName;
    case "remote-agent-call":
      return action.remoteAgentName;
  }
}

function resultName(
  result: Extract<HandleMessageStreamEvent, { type: "action.result" }>["data"]["result"],
): string {
  switch (result.kind) {
    case "tool-result":
      return result.toolName;
    case "load-skill-result":
      return result.name ?? "load_skill";
    case "subagent-result":
      return result.subagentName;
  }
}

export class EveFaceRenderer {
  private readonly shell: ClankieFaceShell;
  private readonly prefixes = new Map<string, string>();
  private readonly actionBlocks = new Map<string, FaceBlockHandle>();
  private assistantBlock: FaceBlockHandle | undefined;
  private assistantText = "";
  private reasoningBlock: FaceBlockHandle | undefined;
  private reasoningText = "";
  private pendingAssistant: string | undefined;
  private pendingReasoning: string | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private submittedPrompt: string | undefined;
  private usage: StepUsage | undefined;

  public constructor(shell: ClankieFaceShell) {
    this.shell = shell;
  }

  public get lastUsage(): StepUsage | undefined {
    return this.usage;
  }

  public expectSubmittedPrompt(prompt: string): void {
    this.submittedPrompt = prompt.trim();
  }

  public resetSession(): void {
    this.prefixes.clear();
    this.usage = undefined;
    this.resetTurn();
  }

  public resetTurn(): void {
    this.flush();
    this.assistantBlock = undefined;
    this.assistantText = "";
    this.reasoningBlock = undefined;
    this.reasoningText = "";
    this.actionBlocks.clear();
  }

  public render(event: HandleMessageStreamEvent): void {
    switch (event.type) {
      case "session.started":
        this.resetSession();
        break;
      case "turn.started":
        this.resetTurn();
        break;
      case "message.received": {
        const message = event.data.message.trim();
        if (this.submittedPrompt === message) this.submittedPrompt = undefined;
        else if (message.length > 0) this.shell.insertMarkdown(`**You**\n\n${sanitize(message)}`);
        break;
      }
      case "step.started":
        this.closeStreamingBlocks();
        this.shell.setTurnLoaderMessage(`Step ${event.data.stepIndex + 1} running...`);
        break;
      case "reasoning.appended":
        this.appendReasoning(
          event.data.turnId,
          event.data.stepIndex,
          event.data.reasoningSoFar,
          event.data.reasoningDelta,
        );
        break;
      case "reasoning.completed":
        this.flush();
        break;
      case "message.appended":
        this.appendAssistant(
          event.data.turnId,
          event.data.stepIndex,
          event.data.messageSoFar,
          event.data.messageDelta,
        );
        break;
      case "message.completed":
        this.flush();
        break;
      case "actions.requested":
        this.closeStreamingBlocks();
        for (const action of event.data.actions) {
          const name = actionName(action);
          this.actionBlocks.set(
            action.callId,
            this.shell.insertMarkdown(
              `**Tool: ${sanitize(name)} - running**\n\ncall: ${sanitize(action.callId)}\n\n\`\`\`json\n${sanitize(json(action.input))}\n\`\`\``,
              COLLAPSED,
            ),
          );
        }
        break;
      case "action.result": {
        this.closeStreamingBlocks();
        const name = resultName(event.data.result);
        const failed = event.data.status === "failed" || event.data.result.isError === true;
        const markdown = `**Tool: ${sanitize(name)} - ${failed ? "failed" : "completed"}**\n\ncall: ${sanitize(event.data.result.callId)}\nstatus: ${sanitize(event.data.status)}\n\n\`\`\`json\n${sanitize(json(event.data.result.output))}\n\`\`\``;
        const block = this.actionBlocks.get(event.data.result.callId);
        if (block === undefined) this.shell.insertMarkdown(markdown, COLLAPSED);
        else block.setMarkdown(markdown);
        break;
      }
      case "input.requested":
        this.closeStreamingBlocks();
        for (const request of event.data.requests) {
          const options = request.options?.map((option) => `- ${option.id}: ${option.label}`).join("\n");
          this.shell.insertMarkdown(
            `**Input requested**\n\n${sanitize(request.prompt)}${options === undefined ? "" : `\n\n${sanitize(options)}`}`,
          );
        }
        break;
      case "authorization.required":
        this.closeStreamingBlocks();
        this.shell.insertMarkdown(`**Authorization required**\n\n${sanitize(event.data.description)}`);
        break;
      case "authorization.completed":
        this.closeStreamingBlocks();
        this.shell.insertMarkdown(`**Authorization ${event.data.outcome}**\n\n${sanitize(event.data.name)}`);
        break;
      case "subagent.called":
        this.closeStreamingBlocks();
        this.shell.insertMarkdown(
          `**Subagent: ${sanitize(event.data.name)} - running**\n\nchild session: ${sanitize(event.data.childSessionId)}`,
          COLLAPSED,
        );
        break;
      case "subagent.completed":
        this.closeStreamingBlocks();
        this.shell.insertMarkdown(
          `**Subagent: ${sanitize(event.data.subagentName)} - completed**\n\n${sanitize(event.data.output)}`,
          COLLAPSED,
        );
        break;
      case "step.completed":
        this.flush();
        this.usage = event.data.usage;
        break;
      case "step.failed":
      case "turn.failed":
      case "session.failed":
        this.closeStreamingBlocks();
        this.shell.insertMarkdown(
          `**${event.type.replace(".", " ")}**\n\n${sanitize(event.data.code)}: ${sanitize(event.data.message)}`,
        );
        break;
      case "compaction.requested":
        this.closeStreamingBlocks();
        this.shell.insertMarkdown(`**Compaction requested**\n\n${sanitize(event.data.modelId)}`);
        break;
      case "compaction.completed":
        this.closeStreamingBlocks();
        this.shell.insertMarkdown(
          "**Compaction completed**\n\nOlder context was summarized; recent turns are preserved.",
        );
        break;
      case "result.completed":
        this.closeStreamingBlocks();
        this.shell.insertMarkdown(
          `**Result completed**\n\n\`\`\`json\n${sanitize(json(event.data.result))}\n\`\`\``,
        );
        break;
      case "session.waiting":
      case "session.completed":
      case "turn.completed":
        this.flush();
        break;
      case "subagent.started":
      case "subagent.event":
        break;
    }
    this.shell.requestRender();
  }

  private appendAssistant(turnId: string, stepIndex: number, soFar: string, delta: string): void {
    const suffix = this.suffix(`message:${turnId}:${stepIndex}`, soFar, delta);
    if (suffix.length === 0) return;
    this.assistantText += sanitize(suffix);
    const markdown = `**Clankie**\n\n${this.assistantText}`;
    if (this.assistantBlock === undefined) this.assistantBlock = this.shell.insertMarkdown(markdown);
    else {
      this.pendingAssistant = markdown;
      this.scheduleFlush();
    }
  }

  private appendReasoning(turnId: string, stepIndex: number, soFar: string, delta: string): void {
    const suffix = this.suffix(`reasoning:${turnId}:${stepIndex}`, soFar, delta);
    if (suffix.length === 0) return;
    this.reasoningText += sanitize(suffix);
    const markdown = `**Reasoning**\n\n${this.reasoningText}`;
    if (this.reasoningBlock === undefined) this.reasoningBlock = this.shell.insertMarkdown(markdown);
    else {
      this.pendingReasoning = markdown;
      this.scheduleFlush();
    }
  }

  private suffix(key: string, soFar: string, delta: string): string {
    const previous = this.prefixes.get(key) ?? "";
    if (soFar.length <= previous.length && previous.startsWith(soFar)) return "";
    if (soFar.startsWith(previous)) {
      this.prefixes.set(key, soFar);
      return soFar.slice(previous.length);
    }
    if (soFar.length > previous.length) this.prefixes.set(key, soFar);
    return delta;
  }

  private closeStreamingBlocks(): void {
    this.flush();
    this.assistantBlock = undefined;
    this.assistantText = "";
    this.reasoningBlock = undefined;
    this.reasoningText = "";
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, STREAM_RENDER_THROTTLE_MS);
  }

  private flush(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pendingAssistant !== undefined && this.assistantBlock !== undefined) {
      this.assistantBlock.setMarkdown(this.pendingAssistant);
    }
    if (this.pendingReasoning !== undefined && this.reasoningBlock !== undefined) {
      this.reasoningBlock.setMarkdown(this.pendingReasoning);
    }
    this.pendingAssistant = undefined;
    this.pendingReasoning = undefined;
  }
}

export function formatTokenFlow(
  usage: StepUsage | undefined,
  contextWindowTokens: number | undefined,
): string {
  if (usage === undefined) return contextWindowTokens === undefined ? "" : "ctx 0%";
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const context =
    contextWindowTokens === undefined || contextWindowTokens <= 0
      ? ""
      : ` ctx ${Math.round((input / contextWindowTokens) * 100)}%`;
  return `↑ ${compact(input)} ↓ ${compact(output)}${context}`;
}

function compact(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}K`;
  return String(tokens);
}
