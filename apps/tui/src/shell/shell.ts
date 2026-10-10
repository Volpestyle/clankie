/**
 * The Clankie face shell: pi's interactive chat surface wearing Clankie's
 * chrome. The renderer is pi's fullscreen mode — a TuiAltScreen whose
 * transcript lives in a ScrollView (mouse wheel, scrollbar, drag text
 * selection, Ctrl+Shift+F search) above a dock that pins the working
 * indicator, editor, typeahead, and footer to the bottom of the terminal.
 * Messages render with pi's own components (user boxes, assistant markdown,
 * tool calls one per row), hovering a tool row highlights it, clicking a
 * tool row opens or closes it (Alt+↑/↓ then Enter from the keyboard),
 * clicking a bash block toggles its output, and clicking a herdr pane id he wrote
 * jumps the session to that pane. Clankie's banner, slash-command typeahead,
 * Ctrl+/ workbench, guided-flow modals, and inline `!` shell escape stay
 * intact. Dynamic data flows in through `FaceShellOptions` (commands,
 * onPrompt, footerData) so the clankie service stays behind
 * `@clankie/api-client`.
 */
import { agentTint, ConversationHeader, LiveAgentPicker, LiveAgentStrip } from "./live-agents.ts";
import type { LiveAgent } from "../observation/herdr-roster.ts";
import { spawn, type ChildProcess } from "node:child_process";
import {
  Container,
  isKeyRelease,
  Key,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  Spacer,
  TuiAltScreen,
  VStack,
  type Component,
  type Focusable,
  type OverlayHandle,
  type OverlayOptions,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  copyToClipboard,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ClankieBannerComponent, type BannerFields } from "../face/clankie-banner.ts";
import { isClankieLeftMouseButton, parseClankieSgrMouse } from "../face/clankie-sgr-mouse.ts";
import { ClankieToolRow } from "./tool-row.ts";
import { ClankieEditor } from "./editor.ts";
import { ClankiePendingPrompts } from "./pending-prompts.ts";
import type { PendingOperatorPrompt } from "../session/operator-conversations.ts";
import { genericToolRenderer, piToolRenderer } from "./tool-render.ts";
import {
  formatHerdrJumpResult,
  herdrPaneRefAtColumn,
  herdrJumpError,
  jumpToHerdrAgent,
  type HerdrJumpResult,
} from "../session/herdr-report.ts";
import {
  clankieCommandCompletion,
  createClankieAutocompleteProvider,
  resolveClankieCommand,
  type ClankieAutocompleteOptions,
  type ClankieAutocompleteSkill,
} from "../face/clankie-autocomplete.ts";
import {
  ClankieCommandTypeaheadPanel,
  ClankieCommandWorkbench,
  clankieCommandFilterFromText,
  clankieCommandTypeaheadFor,
  dismissClankieCommandTypeahead,
  isClankieCommandTypeaheadOpen,
  isExactClankieCommandTypeahead,
  moveClankieCommandTypeaheadSelection,
  selectedClankieCommandTypeahead,
  typeaheadSelectionDelta,
  type ClankieCommandTypeaheadState,
} from "../face/clankie-command-ui.ts";
import { runFaceBashCommand } from "../face/clankie-face-bash.ts";
import { ClankieVoiceTranscriptOverlay } from "../face/clankie-voice-transcripts.ts";
import { followVoiceTranscripts, type DiscordVoiceTranscriptClient } from "../session/voice-transcripts.ts";
import { OperatorConversationSendError } from "../session/operator-conversations.ts";
import { clankieSlashSkillSuffix, resolveClankieSlashSkill } from "../skill-catalog.ts";
import { ClankieCommandTextResultComponent, type CommandLogTone } from "./command-log.ts";
import { ClankieExternalActivityComponent } from "./external-activity.ts";
import { ClankieFreshPage } from "./fresh-page.ts";
import { createFaceThemeBundle, type FaceThemeBundle } from "./theme.ts";
import { ClankieFooterComponent, displayHomePath, type ClankieFooterData } from "./footer.ts";
import { clankieModalOverlayOptions, createSetupFlow, type SetupFlowController } from "./setup-flow.ts";
import { appendPromptHistory, readPromptHistory } from "./prompt-history.ts";

export type FaceBlockHandle = {
  setMarkdown(markdown: string): void;
};

/** A slash command: the display fields feed the typeahead/workbench/autocomplete. */
export interface FaceShellCommand {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly argumentHint?: string;
  readonly takesArgument: boolean;
  /** Explicit opt-in for read-only commands that remain available inside `/btw`. */
  readonly availableInSideConversation?: boolean;
  run(argument: string, shell: ClankieFaceShell): Promise<void> | void;
}

/** Native wheel, page, prompt-navigation and scrollbar scrolling share this boundary. */
class ConversationScrollView extends ScrollView {
  private readonly older: () => void;
  constructor(component: Component, older: () => void, options: ConstructorParameters<typeof ScrollView>[1]) {
    super(component, options);
    this.older = older;
  }

  override scrollBy(lines: number): number {
    const remaining = super.scrollBy(lines);
    if (lines < 0 && this.scrollTop <= this.viewportHeight) this.older();
    return remaining;
  }

  override scrollTo(top: number, options?: { disableFollow?: boolean }): void {
    const previous = this.scrollTop;
    super.scrollTo(top, options);
    if (top < previous && this.scrollTop <= this.viewportHeight) this.older();
  }

  override scrollToStart(): void {
    super.scrollToStart();
    this.older();
  }
}

export interface FaceShellOptions {
  /** Fetch one older conversation window when the owner scrolls towards its start. */
  readonly onLoadOlderHistory?: () => Promise<void>;
  readonly liveAgents?: () => readonly LiveAgent[];
  readonly roomHandoffs?: () => readonly import("@clankie/protocol").OperatorConversation[];
  readonly onOpenLiveAgent?: (agent: LiveAgent) => Promise<void>;
  readonly onOpenRoomHandoff?: (
    conversation: import("@clankie/protocol").OperatorConversation,
  ) => Promise<void>;
  readonly onLeaveLiveAgent?: () => Promise<void>;
  readonly onOpenAgentWorkspace?: () => Promise<void>;
  readonly expandedAgent?: () => string | undefined;
  /** The seat behind the expanded agent, when it is seated, for its tint and state. */
  readonly expandedAgentSeatId?: () => string | undefined;
  readonly allowLocalShell?: boolean;
  readonly onHerdrJump?: (target: string) => Promise<HerdrJumpResult>;
  readonly commands: readonly FaceShellCommand[];
  /** Initial working directory for the `!` shell escape and path autocomplete; {@link ClankieFaceShell.setCwd} moves it. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly bannerFields: BannerFields;
  readonly autocomplete?: ClankieAutocompleteOptions;
  readonly skills?: readonly ClankieAutocompleteSkill[];
  /** File that persists editor prompt history across sessions. */
  readonly historyPath?: string;
  /** Model, conversation title, and context usage for the compact footer. */
  readonly footerData?: () => ClankieFooterData;
  /** Exceptional footer status segments, including the open side conversation. */
  readonly statusExtras?: () => readonly string[];
  /** Captain-authenticated page of retained Discord voice transcripts (ADR 0121). */
  readonly voiceTranscripts?: DiscordVoiceTranscriptClient;
  /** Handles a plain prompt (not a slash command, not `!`). */
  readonly onPrompt?: (
    prompt: string,
    shell: ClankieFaceShell,
    signal: AbortSignal,
    delivery: "steer" | "queue",
  ) => Promise<void>;
  /** Admit input while the original prompt keeps observing the conversation. */
  readonly onPendingPrompt?: (prompt: string, delivery: "steer" | "queue") => Promise<void>;
  /**
   * Interrupts the in-flight turn server-side (Esc). Resolves false when the
   * turn could not be cancelled, in which case the shell detaches observation
   * instead so Esc never leaves the console stuck.
   */
  readonly onInterrupt?: () => Promise<boolean>;
  /** Discards the ephemeral `/btw` fork and selects its parent. */
  readonly onSideExit?: () => Promise<void>;
  /** Switches between the `/btw` fork and its parent without discarding either. */
  readonly onSideToggle?: () => Promise<void>;
  readonly onExit?: () => Promise<void> | void;
}

/** Everything the chat surface needs to put one thread's view back on screen. */
type ClankieTranscriptSnapshot = {
  readonly children: readonly Component[];
  readonly activeToolBlocks: ReadonlyMap<string, ToolExecutionComponent>;
  readonly expandableBlocks: ReadonlyMap<
    Component,
    { expanded: boolean; setExpanded(expanded: boolean): void }
  >;
  readonly liveAssistantBlock?: Container;
};

type ActivePromptTurn = {
  readonly controller: AbortController;
  loader?: Loader | undefined;
  interrupting?: boolean;
};

/** pi's IdleStatus: hold the loader's two rows so the editor doesn't jump. */
const IDLE_STATUS: Component = {
  invalidate(): void {},
  render(width: number): string[] {
    const emptyLine = " ".repeat(Math.max(1, width));
    return [emptyLine, emptyLine];
  },
};

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * pi's message components only read `content` (plus stopReason/errorMessage),
 * so a minimal fabricated envelope is enough to reuse them for Clankie's
 * conversation events.
 */
function assistantEnvelope(content: AssistantMessage["content"]): AssistantMessage {
  return { content, role: "assistant", stopReason: "stop" } as unknown as AssistantMessage;
}

function parseToolArguments(detail: string | undefined): unknown {
  if (detail === undefined) return undefined;
  try {
    return JSON.parse(detail);
  } catch {
    return detail;
  }
}

/**
 * Tees every stdin event to an observer before the TUI's own input pipeline.
 * The alt screen's viewport handler consumes mouse sequences, so click
 * detection must watch the terminal itself; the observer never consumes.
 */
function observeTerminalInput(terminal: Terminal, observe: (data: string) => void): Terminal {
  return {
    start: (onInput, onResize) =>
      terminal.start((data) => {
        observe(data);
        onInput(data);
      }, onResize),
    stop: () => terminal.stop(),
    drainInput: (maxMs?: number, idleMs?: number) => terminal.drainInput(maxMs, idleMs),
    write: (data) => terminal.write(data),
    get columns() {
      return terminal.columns;
    },
    get rows() {
      return terminal.rows;
    },
    get kittyProtocolActive() {
      return terminal.kittyProtocolActive;
    },
    moveBy: (lines) => terminal.moveBy(lines),
    hideCursor: () => terminal.hideCursor(),
    showCursor: () => terminal.showCursor(),
    clearLine: () => terminal.clearLine(),
    clearFromCursor: () => terminal.clearFromCursor(),
    clearScreen: () => terminal.clearScreen(),
    setTitle: (title) => terminal.setTitle(title),
    setProgress: (active) => terminal.setProgress(active),
  };
}

/** Walks the transcript's flat rows to the block a click landed on, and where in it. */
export function clickedTranscriptBlock(
  blocks: readonly Component[],
  width: number,
  flatRow: number,
): { readonly block: Component; readonly row: number } | undefined {
  let row = flatRow;
  for (const block of blocks) {
    const rows = block.render(width).length;
    if (row < rows) return { block, row };
    row -= rows;
  }
  return undefined;
}

export class ClankieFaceShell {
  readonly tui: TuiAltScreen;
  readonly theme: FaceThemeBundle;
  readonly setupFlow: SetupFlowController;

  private readonly options: FaceShellOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly banner: ClankieBannerComponent;
  private readonly document = new Container();
  private readonly chat = new Container();
  private readonly transcriptScrollView: ScrollView;
  private historyGeneration = 0;
  /** The TUI opens on a blank page; only the first restored history gets one. */
  private freshPageOnOpen = true;
  private freshPage: ClankieFreshPage | undefined;
  /** Holds the fresh page's blank rows after the transcript; history can arrive before start(). */
  private readonly freshPageTail = new Container();
  private historyLoading = false;
  private readonly statusContainer = new Container();
  private readonly editor: ClankieEditor;
  private readonly pendingPrompts: ClankiePendingPrompts;
  private readonly toolRows = new WeakMap<ToolExecutionComponent, ClankieToolRow>();
  /** The tool row under the mouse pointer. */
  private hoveredToolRow: ClankieToolRow | undefined;
  /** The tool row Alt+↑/↓ selected; Enter opens or closes it. */
  private selectedToolRow: ClankieToolRow | undefined;
  private readonly commandTypeaheadPanel: ClankieCommandTypeaheadPanel;
  private readonly footer: ClankieFooterComponent;
  private readonly liveAgents: LiveAgentStrip;
  private readonly conversationHeader: ConversationHeader;
  private agentNavigationBusy = false;
  private liveAgentOverlay: OverlayHandle | undefined;

  private headerVisibleState: boolean;

  private uiReady = false;
  private shutdownStarted = false;
  private currentStatusLabel = "ready";
  private commandTypeaheadState: ClankieCommandTypeaheadState | undefined;
  private commandPaletteOverlay: OverlayHandle | undefined;
  private voiceTranscriptOverlay: OverlayHandle | undefined;
  private voiceTranscriptFollow: AbortController | undefined;

  /** Follows the selected conversation's workspace, so `!` lands where he works. */
  private cwdValue: string;
  private bashMode = false;
  private bashRunning = 0;
  private activeBashChild: ChildProcess | undefined;

  private respondingState = false;
  private activeTurn: ActivePromptTurn | undefined;
  private activeLoader: Loader | undefined;
  private runningTurn: Promise<void> | undefined;
  private returningFromSideConversation = false;
  private switchingSideConversation = false;
  /** The transcript of whichever thread is off screen while `/btw` is open. */
  private stashedTranscript: ClankieTranscriptSnapshot | undefined;
  /** Which of the two threads the console shows while `/btw` is open. */
  private sideView: "side" | "parent" | undefined;

  /** Live tool executions keyed by toolCallId until their result lands. */
  private readonly activeToolBlocks = new Map<string, ToolExecutionComponent>();
  /** Blocks a click or Ctrl+O toggles between preview and full output. */
  private readonly expandableBlocks = new Map<
    Component,
    { expanded: boolean; setExpanded(expanded: boolean): void }
  >();
  private outputExpanded = false;
  /** The block holding the message he is typing, until it settles or the turn ends. */
  private liveAssistantBlock: Container | undefined;
  private clickPress: { readonly col: number; readonly row: number } | undefined;
  private clickDragged = false;

  constructor(options: FaceShellOptions) {
    this.options = options;
    this.cwdValue = options.cwd;
    this.env = options.env ?? process.env;
    this.theme = createFaceThemeBundle(process.stdout);
    // pi's components read the pi theme singleton; Clankie always wears dark.
    initTheme("dark");

    this.headerVisibleState = this.env.CLANKIE_HEADER !== "0" && this.env.CLANKIE_HEADER !== "off";

    const caps = this.theme.capabilities;
    // pi dark's selectedBg (#3a3a4a) for scrollbar thumb and search matches.
    const selectionBg = (text: string): string =>
      caps.color
        ? caps.trueColor
          ? `\x1b[48;2;58;58;74m${text}\x1b[0m`
          : `\x1b[48;5;237m${text}\x1b[0m`
        : text;
    const inverse = (text: string): string => (caps.color ? `\x1b[7m${text}\x1b[27m` : text);
    const searchMatch = (text: string): string => selectionBg(this.theme.ansi.selectedDescription(text));
    this.tui = new TuiAltScreen(
      observeTerminalInput(new ProcessTerminal(), (data) => this.observeTerminalData(data)),
      undefined,
      undefined,
      {
        copySelection: async (text) => {
          try {
            await copyToClipboard(text);
            return true;
          } catch {
            return false;
          }
        },
        openUrl: (url) => {
          spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
            detached: true,
            stdio: "ignore",
          }).unref();
        },
        searchCurrentMatchStyle: (text) => this.theme.ansi.bold(inverse(searchMatch(text))),
        searchMatchStyle: (text) => this.theme.ansi.underline(searchMatch(text)),
      },
    );
    this.tui.setClearOnShrink(true);
    this.banner = new ClankieBannerComponent(
      options.bannerFields,
      this.theme.capabilities,
      this.headerVisibleState,
      () => this.tui.terminal.rows,
    );
    this.transcriptScrollView = new ConversationScrollView(this.document, () => this.loadOlderHistory(), {
      follow: "end",
      overscroll: "chain",
      primary: true,
      scrollbar: "auto",
      scrollbarThumbStyle: selectionBg,
    });
    this.pendingPrompts = new ClankiePendingPrompts(this.theme.ansi);
    this.editor = new ClankieEditor(this.tui, this.theme.editorTheme, {
      autocompleteMaxVisible: 12,
      // Shell mode and an agent's conversation tint the caret like the border; otherwise it is his accent.
      caret: () => {
        if (this.bashMode) return this.editorBorder()("!");
        const glyph = caps.unicode ? "❯" : ">";
        return this.options.expandedAgent?.() === undefined
          ? this.theme.ansi.accent(glyph)
          : this.editorBorder()(glyph);
      },
    });
    this.commandTypeaheadPanel = new ClankieCommandTypeaheadPanel(
      options.commands,
      this.theme.commandUiTheme,
      {
        maxVisibleRows: () => this.maxCommandTypeaheadRows(),
      },
    );
    this.liveAgents = new LiveAgentStrip(() => this.options.liveAgents?.() ?? [], this.theme, {
      roomHandoffs: () => this.options.roomHandoffs?.() ?? [],
      maxRows: () => Math.max(3, Math.floor(this.tui.terminal.rows * 0.5)),
    });
    this.conversationHeader = new ConversationHeader(this.theme, () => {
      const name = this.options.expandedAgent?.();
      const title = this.options.footerData?.().title;
      return {
        ...(title === undefined ? {} : { title }),
        ...(name === undefined ? {} : { agent: { name, ...this.viewedAgent() } }),
      };
    });
    // Computed per frame: bash mode, an agent's conversation, or the quiet default.
    this.editor.borderColor = (text) => this.editorBorder()(text);
    this.footer = new ClankieFooterComponent(this.theme.ansi, () => ({
      cwd: this.cwdValue,
      extras: this.footerExtras(),
      ...this.options.footerData?.(),
    }));

    this.setupFlow = createSetupFlow({
      tui: this.tui,
      editor: this.editor,
      editorTheme: this.theme.editorTheme,
      selectListTheme: this.theme.selectListTheme,
      setStatus: (message) => this.refreshStatus(message),
      refreshStatusView: () => this.refreshStatusView(),
      refreshCommandSurface: (text) => this.refreshCommandSurface(text),
      showModalOverlay: (component, overlayOptions) => this.showModalOverlay(component, overlayOptions),
    });

    this.applyAutocompleteProvider();
    this.editor.onChange = (text) => {
      this.refreshCommandSurface(text);
    };
    this.editor.onSubmit = (submitted) => this.submitEditorInput(submitted);
  }

  private submitEditorInput(submitted: string, delivery: "steer" | "queue" = "steer"): void {
    this.refreshCommandSurface("");
    if (this.setupFlow.handleSubmit(submitted)) return;
    // Capture before submitting: anything entered while a turn is already
    // streaming is a concurrent command or prompt admission and must
    // not clobber the tracked in-flight turn.
    const concurrent = this.respondingState;
    const submission = this.submitEditorText(submitted, delivery).catch((error: unknown) => {
      this.insertMarkdown(`**Error**\n\n${formatError(error)}`);
    });
    if (concurrent) return;
    const tracked: Promise<void> = submission.finally(() => {
      if (this.runningTurn === tracked) this.runningTurn = undefined;
    });
    this.runningTurn = tracked;
  }

  // --- lifecycle ---

  start(): void {
    // pi's fullscreen layout: the transcript ScrollView takes every spare row,
    // and the dock (working status, editor, Clankie's typeahead, footer) stays
    // pinned to the bottom of the terminal.
    this.document.addChild(this.banner);
    this.document.addChild(this.chat);
    this.document.addChild(this.freshPageTail);
    for (const component of [
      this.conversationHeader,
      this.document,
      this.statusContainer,
      this.pendingPrompts,
      this.editor,
      this.commandTypeaheadPanel,
      this.liveAgents,
      this.footer,
    ]) {
      this.tui.addChild(component);
    }
    const dock = new VStack([
      { component: this.statusContainer, shrink: 1, minSize: 0 },
      { component: this.pendingPrompts, shrink: 1, minSize: 0 },
      { component: this.editor, shrink: 1, minSize: 3 },
      { component: this.commandTypeaheadPanel, shrink: 1, minSize: 0 },
      { component: this.liveAgents, shrink: 1, minSize: 0 },
      { component: this.footer, shrink: 1, minSize: 1 },
    ]);
    this.tui.setLayoutRoot(
      new VStack([
        { component: this.conversationHeader, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
        { component: this.transcriptScrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
      ]),
    );
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.routeInput(data));
    this.tui.onDebug = () => this.insertDebugSnapshot();
    this.tui.start();
    this.uiReady = true;
    this.refreshStatusView();
    void readPromptHistory(this.historyPath() ?? "").then((entries) => {
      for (const entry of entries) this.editor.addToHistory(entry);
    });
  }

  async shutdown(code = 0, options?: { readonly abortTurn?: boolean }): Promise<never> {
    if (this.shutdownStarted) return process.exit(code);
    this.shutdownStarted = true;
    if (options?.abortTurn === true) this.activeTurn?.controller.abort();
    this.closeVoiceTranscripts();
    this.stopTurnLoader();
    // pi's fullscreen exit default: leave the transcript in the terminal's
    // scrollback after the alternate screen closes.
    const transcript = this.renderTranscriptForScrollback();
    this.restoreTerminal();
    try {
      if (transcript.length > 0) process.stdout.write(`${transcript}\n`);
    } catch {
      // Best-effort.
    }
    try {
      await this.options.onExit?.();
    } catch {
      // Best-effort: exit cleanup must not block shutdown.
    }
    return process.exit(code);
  }

  private renderTranscriptForScrollback(): string {
    if (!this.uiReady) return "";
    try {
      const width = Math.max(20, this.tui.terminal.columns);
      if (this.freshPage) this.freshPage.padded = false;
      return this.document
        .render(width)
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd();
    } catch {
      return "";
    }
  }

  /** Best-effort terminal restore for the crash-safety envelope. */
  restoreTerminal(): void {
    try {
      if (this.uiReady) this.tui.stop();
    } catch {
      // Best-effort.
    }
  }

  async withTerminal<T>(run: () => Promise<T>): Promise<T> {
    this.tui.stop();
    try {
      return await run();
    } finally {
      this.tui.start();
      this.tui.requestRender(true);
    }
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  // --- transcript ---

  /** Appends a chat block, separated from the previous one like pi's chat flow. */
  private appendChatBlock(component: Component, options?: { readonly spacer?: boolean }): void {
    if (options?.spacer !== false && this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
    this.chat.addChild(component);
    this.tui.requestRender();
  }

  insertUserMessage(text: string): void {
    this.appendChatBlock(new UserMessageComponent(text, getMarkdownTheme()));
  }

  insertAssistantMarkdown(text: string): void {
    // A message he was seen typing settles in the block it streamed into, so
    // the finished text replaces the draft where it already sits (ADR 0141).
    const live = this.liveAssistantBlock;
    if (live !== undefined) {
      this.liveAssistantBlock = undefined;
      live.clear();
      live.addChild(new AssistantMessageComponent(assistantEnvelope([{ text, type: "text" }])));
      this.tui.requestRender();
      return;
    }
    // AssistantMessageComponent carries its own leading spacer.
    this.appendChatBlock(new AssistantMessageComponent(assistantEnvelope([{ text, type: "text" }])), {
      spacer: false,
    });
  }

  /**
   * Draw the message he is typing right now. The block is a real transcript
   * block from the first token, so the settled message lands in place instead
   * of appearing a second time below it.
   */
  updateLiveAssistant(text: string): void {
    let block = this.liveAssistantBlock;
    if (block === undefined) {
      block = new Container();
      this.liveAssistantBlock = block;
      this.appendChatBlock(block, { spacer: false });
    }
    block.clear();
    block.addChild(new AssistantMessageComponent(assistantEnvelope([{ text, type: "text" }])));
    this.tui.requestRender();
  }

  /**
   * Stop treating the open block as a draft. What he had typed stays on screen:
   * a draft with no settled message behind it is an interrupted or failed turn,
   * and the words he got out are the honest record of it.
   */
  clearLiveAssistant(): void {
    this.liveAssistantBlock = undefined;
  }

  insertReasoning(text: string): void {
    this.appendChatBlock(
      new AssistantMessageComponent(assistantEnvelope([{ thinking: text, type: "thinking" }])),
      { spacer: false },
    );
  }

  /** Arms a block for click / Ctrl+O expansion and applies the current default. */
  private registerExpandable(component: Component & { setExpanded(expanded: boolean): void }): void {
    component.setExpanded(this.outputExpanded);
    this.expandableBlocks.set(component, {
      expanded: this.outputExpanded,
      setExpanded: (expanded) => component.setExpanded(expanded),
    });
  }

  beginToolCall(toolCallId: string, name: string, argumentsDetail?: string): void {
    let component = this.activeToolBlocks.get(toolCallId);
    if (component === undefined) {
      component = new ToolExecutionComponent(
        name,
        toolCallId,
        parseToolArguments(argumentsDetail),
        {},
        piToolRenderer(name, this.cwdValue) ?? genericToolRenderer(name),
        this.tui,
        this.cwdValue,
      );
      this.appendToolComponent(component, name, parseToolArguments(argumentsDetail));
      this.activeToolBlocks.set(toolCallId, component);
    }
    component.markExecutionStarted();
    this.tui.requestRender();
  }

  completeToolCall(
    toolCallId: string,
    name: string,
    outcome: { readonly failed: boolean; readonly detail?: string | undefined },
  ): void {
    let component = this.activeToolBlocks.get(toolCallId);
    if (component === undefined) {
      // Restore path: a replayed completion without its started half.
      component = new ToolExecutionComponent(
        name,
        toolCallId,
        undefined,
        {},
        piToolRenderer(name, this.cwdValue) ?? genericToolRenderer(name),
        this.tui,
        this.cwdValue,
      );
      this.appendToolComponent(component, name, undefined);
      component.markExecutionStarted();
    }
    this.activeToolBlocks.delete(toolCallId);
    component.setArgsComplete();
    component.updateResult({
      content: [{ text: outcome.detail ?? "", type: "text" }],
      isError: outcome.failed,
    });
    this.toolRows.get(component)?.complete(outcome.failed, outcome.detail);
    this.tui.requestRender();
  }

  /** One row per call; consecutive calls stack without blank lines between them. */
  private appendToolComponent(component: ToolExecutionComponent, name: string, args: unknown): void {
    const row = new ClankieToolRow(component, name, args, {
      ansi: this.theme.ansi,
      unicode: this.theme.capabilities.unicode,
    });
    this.toolRows.set(component, row);
    this.registerExpandable(row);
    this.appendChatBlock(row, { spacer: !(this.chat.children.at(-1) instanceof ClankieToolRow) });
  }

  setPendingPrompts(prompts: readonly PendingOperatorPrompt[]): void {
    this.pendingPrompts.setPrompts(prompts);
    this.tui.requestRender();
  }

  insertExternalActivity(text: string): void {
    const block = new ClankieExternalActivityComponent(text);
    this.registerExpandable(block);
    this.appendChatBlock(block);
  }

  insertMarkdown(text: string): FaceBlockHandle {
    const block = new Container();
    block.addChild(new Markdown(text, 1, 0, getMarkdownTheme()));
    this.appendChatBlock(block);
    return {
      setMarkdown: (markdown: string): void => {
        block.clear();
        block.addChild(new Markdown(markdown, 1, 0, getMarkdownTheme()));
        this.tui.requestRender();
      },
    };
  }

  /** Places text in the composer for the owner to edit or send; nothing is sent. */
  getDraft(): string {
    return this.editor.getExpandedText();
  }

  setDraft(text: string): void {
    this.editor.setText(text);
    this.refreshCommandSurface(text);
    this.tui.setFocus(this.editor);
    this.requestRender();
  }

  insertCommandResult(prompt: string, message: string, tone: CommandLogTone): void {
    this.appendChatBlock(new ClankieCommandTextResultComponent(prompt, message, tone, this.theme.ansi));
  }

  clearTranscript(): void {
    this.historyGeneration += 1;
    this.historyLoading = false;
    this.setPendingPrompts([]);
    this.chat.clear();
    this.liveAssistantBlock = undefined;
    this.activeToolBlocks.clear();
    this.expandableBlocks.clear();
    this.hoveredToolRow = undefined;
    this.selectedToolRow = undefined;
    this.transcriptScrollView.scrollToEnd();
    this.tui.requestRender();
  }

  /** Render a page in one synchronous transaction; prepends keep the visible rows in place. */
  renderHistory(position: "replace" | "prepend", render: () => void): void {
    if (position === "replace") {
      this.clearTranscript();
      render();
      this.openOnFreshPage();
      this.transcriptScrollView.scrollToEnd();
      return;
    }
    const previous = this.captureTranscript();
    const scroll = this.transcriptScrollView;
    const top = scroll.scrollTop;
    const following = scroll.isFollowingEnd;
    const width = scroll.getContentWidth(this.tui.terminal.columns);
    this.chat.clear();
    this.liveAssistantBlock = undefined;
    this.activeToolBlocks.clear();
    this.expandableBlocks.clear();
    render();
    if (this.chat.children.length > 0 && previous.children.length > 0) this.chat.addChild(new Spacer(1));
    const addedRows = this.chat.render(width).length;
    for (const child of previous.children) this.chat.addChild(child);
    for (const [id, block] of previous.activeToolBlocks) this.activeToolBlocks.set(id, block);
    for (const [block, state] of previous.expandableBlocks) this.expandableBlocks.set(block, state);
    this.liveAssistantBlock = previous.liveAssistantBlock;
    // ScrollView clamps against its last layout. Update its measured extent
    // before restoring the anchor, without emitting an intermediate frame.
    scroll.updateLayout(this.document.render(width).length, scroll.viewportHeight, () =>
      this.requestRender(),
    );
    if (following) scroll.scrollToEnd();
    else scroll.scrollTo(top + addedRows, { disableFollow: true });
    this.requestRender();
  }

  /** Restored history waits above the first screen instead of filling it. */
  private openOnFreshPage(): void {
    if (!this.freshPageOnOpen) return;
    this.freshPageOnOpen = false;
    if (this.chat.children.length === 0) return;
    const page = new ClankieFreshPage({
      dim: this.theme.ansi.dim,
      viewportHeight: () => this.transcriptViewportRows(),
      after: () => {
        const index = this.chat.children.indexOf(page);
        return index < 0 ? undefined : this.chat.children.slice(index + 1);
      },
    });
    this.freshPage = page;
    this.freshPageTail.clear();
    this.freshPageTail.addChild(page.tail);
    this.appendChatBlock(page);
  }

  /**
   * The rows the transcript gets this frame. pi lays content out before it
   * tells the ScrollView its height, so its viewportHeight is a frame late
   * (zero on the first frame); measure the chrome around it instead.
   */
  private transcriptViewportRows(): number {
    const width = Math.max(1, this.tui.terminal.columns);
    const chrome = [
      this.conversationHeader,
      this.statusContainer,
      this.pendingPrompts,
      this.editor,
      this.commandTypeaheadPanel,
      this.liveAgents,
      this.footer,
    ].reduce((rows, component) => rows + component.render(width).length, 0);
    return Math.max(1, this.tui.terminal.rows - chrome);
  }

  private loadOlderHistory(): void {
    if (this.historyLoading || !this.options.onLoadOlderHistory) return;
    const generation = this.historyGeneration;
    this.historyLoading = true;
    void this.options
      .onLoadOlderHistory()
      .catch((error: unknown) => {
        if (generation === this.historyGeneration)
          this.refreshStatus(`Older history unavailable: ${formatError(error)}`);
      })
      .finally(() => {
        if (generation === this.historyGeneration) this.historyLoading = false;
      });
  }

  /** True while an ephemeral `/btw` fork exists, whichever thread is on screen. */
  get sideConversationActive(): boolean {
    return this.sideView !== undefined;
  }

  /** True only while the side conversation itself is the visible thread. */
  get sideConversationVisible(): boolean {
    return this.sideView === "side";
  }

  /** Stop drawing the active parent tail; its server-side turn keeps running and replays on return. */
  async detachActiveTurn(): Promise<void> {
    if (this.activeTurn === undefined) return;
    this.activeTurn.controller.abort();
    await this.runningTurn;
  }

  /** Stash the parent's view so the side conversation opens on the fork boundary. */
  beginSideConversation(): void {
    if (this.sideView !== undefined) throw new Error("A side conversation is already open");
    this.stashedTranscript = this.captureTranscript();
    this.sideView = "side";
    this.clearTranscript();
  }

  /** Swap the on-screen view with the stashed one, keeping both threads alive. */
  swapSideTranscript(): void {
    const stashed = this.stashedTranscript;
    if (stashed === undefined || this.sideView === undefined) return;
    this.stashedTranscript = this.captureTranscript();
    this.restoreTranscript(stashed);
    this.sideView = this.sideView === "side" ? "parent" : "side";
  }

  /** Restore the exact parent UI snapshot after its ephemeral child is discarded. */
  endSideConversation(): void {
    if (this.sideView === undefined) return;
    if (this.sideView === "side" && this.stashedTranscript !== undefined) {
      this.restoreTranscript(this.stashedTranscript);
    }
    this.stashedTranscript = undefined;
    this.sideView = undefined;
    this.returningFromSideConversation = false;
    this.switchingSideConversation = false;
    this.tui.requestRender();
  }

  private captureTranscript(): ClankieTranscriptSnapshot {
    return {
      children: [...this.chat.children],
      activeToolBlocks: new Map(this.activeToolBlocks),
      expandableBlocks: new Map(this.expandableBlocks),
      ...(this.liveAssistantBlock === undefined ? {} : { liveAssistantBlock: this.liveAssistantBlock }),
    };
  }

  private restoreTranscript(snapshot: ClankieTranscriptSnapshot): void {
    this.historyGeneration += 1;
    this.historyLoading = false;
    this.chat.clear();
    this.setHoveredToolRow(undefined);
    this.selectToolRow(undefined);
    for (const child of snapshot.children) this.chat.addChild(child);
    this.activeToolBlocks.clear();
    for (const [id, block] of snapshot.activeToolBlocks) this.activeToolBlocks.set(id, block);
    this.expandableBlocks.clear();
    for (const [block, state] of snapshot.expandableBlocks) this.expandableBlocks.set(block, state);
    this.liveAssistantBlock = snapshot.liveAssistantBlock;
    this.tui.requestRender();
  }

  /** pi's Ctrl+O: swap every tool/bash block between preview and full output. */
  private toggleOutputExpansion(): void {
    this.outputExpanded = !this.outputExpanded;
    for (const entry of this.expandableBlocks.values()) {
      entry.expanded = this.outputExpanded;
      entry.setExpanded(this.outputExpanded);
    }
    this.tui.requestRender();
  }

  // --- transcript clicks ---

  /**
   * Watches raw terminal input for a left click (press then release with no
   * drag) and toggles the tool/bash block under it. Runs beside the alt
   * screen's own mouse handling — a plain click carries no selection, so the
   * two never fight.
   */
  private observeTerminalData(data: string): void {
    const mouse = parseClankieSgrMouse(data);
    if (mouse?.kind === "move") {
      const target = this.transcriptTarget(mouse.col - 1, mouse.row - 1);
      this.setHoveredToolRow(target?.block instanceof ClankieToolRow ? target.block : undefined);
      return;
    }
    if (mouse === undefined || mouse.kind === "wheel" || !isClankieLeftMouseButton(mouse)) return;
    if (mouse.kind === "press") {
      this.clickPress = { col: mouse.col, row: mouse.row };
      this.clickDragged = false;
      return;
    }
    if (mouse.kind === "drag") {
      this.clickDragged = true;
      return;
    }
    const press = this.clickPress;
    this.clickPress = undefined;
    if (press === undefined || this.clickDragged) return;
    // The observer runs before pi reads the same release; moving content under
    // it first would turn the click into a text selection.
    setImmediate(() => this.handleTranscriptClick(mouse.col - 1, mouse.row - 1));
  }

  /** The transcript block under a zero-based screen cell, when the transcript is what is there. */
  private transcriptTarget(
    x: number,
    y: number,
  ): { readonly block: Component; readonly row: number; readonly width: number } | undefined {
    if (this.tui.hasOverlayEntries || this.setupFlow.isWaitingForInput()) return undefined;
    // The conversation header sits above the transcript viewport.
    const top = this.conversationHeader.render(Math.max(1, this.tui.terminal.columns)).length;
    const viewportHeight = this.transcriptScrollView.viewportHeight;
    const row = y - top;
    if (x < 0 || row < 0 || viewportHeight <= 0 || row >= viewportHeight) return undefined;
    const width = this.transcriptScrollView.getContentWidth(this.tui.terminal.columns);
    if (x >= width) return undefined;
    const target = clickedTranscriptBlock(
      [this.banner, ...this.chat.children],
      width,
      this.transcriptScrollView.scrollTop + row,
    );
    return target === undefined ? undefined : { ...target, width };
  }

  private handleTranscriptClick(x: number, y: number): void {
    const target = this.transcriptTarget(x, y);
    if (target === undefined) return;
    const paneRef = herdrPaneRefAtColumn(target.block.render(target.width)[target.row] ?? "", x);
    if (paneRef !== undefined) {
      this.jumpToHerdrPane(paneRef);
      return;
    }
    this.toggleBlock(target.block);
  }

  private toggleBlock(block: Component): void {
    const entry = this.expandableBlocks.get(block);
    if (entry === undefined) return;
    entry.expanded = !entry.expanded;
    entry.setExpanded(entry.expanded);
    // Opening a row near the end must not let follow-to-end push its header off screen.
    if (block instanceof ClankieToolRow) this.scrollBlockIntoView(block);
    this.tui.requestRender();
  }

  private setHoveredToolRow(row: ClankieToolRow | undefined): void {
    if (row === this.hoveredToolRow) return;
    if (this.hoveredToolRow !== this.selectedToolRow) this.hoveredToolRow?.setHighlighted(undefined);
    this.hoveredToolRow = row;
    if (row !== undefined && row !== this.selectedToolRow) row.setHighlighted("mouse");
    this.tui.requestRender();
  }

  private selectToolRow(row: ClankieToolRow | undefined): void {
    const previous = this.selectedToolRow;
    if (row === previous) return;
    this.selectedToolRow = row;
    previous?.setHighlighted(previous === this.hoveredToolRow ? "mouse" : undefined);
    row?.setHighlighted("key");
    if (row !== undefined) this.scrollBlockIntoView(row);
    this.tui.requestRender();
  }

  /** Alt+↑/↓ walk the tool rows, newest first; Enter opens or closes the selected one. */
  private routeToolRowInput(data: string): { consume: true } | undefined {
    const up = matchesKey(data, Key.alt("up"));
    if (up || matchesKey(data, Key.alt("down"))) {
      const rows = this.chat.children.filter((child) => child instanceof ClankieToolRow);
      const current = this.selectedToolRow === undefined ? rows.length : rows.indexOf(this.selectedToolRow);
      // Up stops at the oldest row; down past the newest hands the keys back to the editor.
      const next = up ? Math.max(0, current - 1) : current + 1;
      this.selectToolRow(rows[next]);
      return { consume: true };
    }
    const selected = this.selectedToolRow;
    if (selected === undefined) return undefined;
    if (matchesKey(data, Key.enter)) {
      this.toggleBlock(selected);
      return { consume: true };
    }
    if (matchesKey(data, Key.escape)) {
      this.selectToolRow(undefined);
      return { consume: true };
    }
    if (!isKeyRelease(data)) this.selectToolRow(undefined);
    return undefined;
  }

  /** Shows as much of the block as fits, its first row first; follow-to-end stays on when it already does. */
  private scrollBlockIntoView(block: Component): void {
    const scroll = this.transcriptScrollView;
    const viewport = scroll.viewportHeight;
    if (viewport <= 0) return;
    const width = scroll.getContentWidth(this.tui.terminal.columns);
    // ScrollView clamps against its last layout; measure the changed block first.
    const total = this.document.render(width).length;
    scroll.updateLayout(total, viewport, () => this.requestRender());
    let top = 0;
    for (const child of [this.banner, ...this.chat.children]) {
      if (child === block) break;
      top += child.render(width).length;
    }
    const height = Math.min(block.render(width).length, viewport);
    const shownTop = scroll.isFollowingEnd ? Math.max(0, total - viewport) : scroll.scrollTop;
    if (top < shownTop) scroll.scrollTo(top, { disableFollow: true });
    else if (top + height > shownTop + viewport)
      scroll.scrollTo(top + height - viewport, { disableFollow: true });
  }

  /**
   * Follow a pane id Clankie wrote. A working jump speaks for itself — the
   * session moves — so only a refusal reaches the transcript.
   */
  focusHerdrAgent(target: string): Promise<HerdrJumpResult> {
    return this.options.onHerdrJump?.(target) ?? jumpToHerdrAgent(target, { env: this.env });
  }

  private jumpToHerdrPane(target: string): void {
    void this.focusHerdrAgent(target).then((result) => {
      if (result.outcome === "ok") return;
      const formatted = formatHerdrJumpResult(result);
      this.insertCommandResult(`/jump ${target}`, formatted.text, formatted.tone);
    });
  }

  // --- status / footer ---

  refreshStatus(label: string): void {
    this.currentStatusLabel = label;
    this.refreshStatusView();
  }

  refreshStatusView(): void {
    if (!this.uiReady) return;
    this.tui.requestRender();
  }

  private footerExtras(): readonly string[] {
    const { ansi } = this.theme;
    const label =
      this.currentStatusLabel === "ready" ||
      this.currentStatusLabel === "streaming" ||
      this.currentStatusLabel === "conversation turn accepted" ||
      this.currentStatusLabel === "conversation turn completed"
        ? ""
        : this.currentStatusLabel;
    const setupState = this.setupFlow.isWaitingForInput() ? "setup input" : "";
    const bashState = this.bashMode
      ? `${ansi.success("shell")}${
          this.bashRunning > 0 ? ansi.dim(" running") : ansi.dim(` · ${displayHomePath(this.cwdValue)}`)
        }`
      : "";
    return [label, setupState, bashState, ...(this.options.statusExtras?.() ?? [])];
  }

  get cwd(): string {
    return this.cwdValue;
  }

  /** Repoints the `!` shell escape and path completion at another directory. */
  setCwd(cwd: string): void {
    if (cwd === this.cwdValue) return;
    this.cwdValue = cwd;
    this.applyAutocompleteProvider();
    this.refreshStatusView();
  }

  private applyAutocompleteProvider(): void {
    this.editor.setAutocompleteProvider(
      createClankieAutocompleteProvider(
        this.options.commands,
        this.cwdValue,
        this.options.autocomplete ?? {},
      ),
    );
  }

  get headerVisible(): boolean {
    return this.headerVisibleState;
  }

  /** Draw the welcome in the owner's chosen look (`appearance.leadSkin`). */
  setLeadSkin(leadSkin: string | undefined): void {
    this.banner.setLeadSkin(leadSkin);
    this.tui.requestRender();
  }

  setHeaderVisible(visible: boolean): void {
    this.headerVisibleState = visible;
    this.banner.setVisible(visible);
    this.tui.requestRender();
  }

  private maxCommandTypeaheadRows(): number {
    // Leave room for the banner, editor, status rows, and footer.
    return Math.max(0, Math.min(10, this.tui.terminal.rows - 12));
  }

  // --- turn loader ---

  startTurnLoader(message = "Working..."): void {
    this.respondingState = true;
    const { ansi } = this.theme;
    const loader = new Loader(this.tui, ansi.accent, ansi.dim, this.loaderText(message));
    this.activeLoader = loader;
    if (this.activeTurn !== undefined) {
      this.activeTurn.loader = loader;
    }
    this.statusContainer.clear();
    this.statusContainer.addChild(loader);
    loader.start();
    this.refreshStatus("streaming");
  }

  setTurnLoaderMessage(message: string): void {
    this.activeLoader?.setMessage(this.loaderText(message));
  }

  stopTurnLoader(): void {
    const loader = this.activeLoader;
    this.activeLoader = undefined;
    if (this.activeTurn !== undefined) {
      this.activeTurn.loader = undefined;
    }
    if (loader !== undefined) {
      loader.stop();
      this.statusContainer.clear();
      this.statusContainer.addChild(IDLE_STATUS);
    }
    this.respondingState = false;
    this.tui.requestRender();
  }

  private loaderText(message: string): string {
    return `${message} (enter to steer · alt+enter to queue · ${this.options.expandedAgent?.() ? "esc conversation" : "esc to interrupt"})`;
  }

  // --- input routing ---

  private routeInput(data: string): { consume?: boolean; data?: string } | undefined {
    // The agent modal owns its keys, including Esc/Ctrl+C while a turn is running.
    if (this.liveAgentOverlay?.isFocused() === true) return undefined;
    if (!this.setupFlow.isWaitingForInput() && !this.tui.hasOverlay()) {
      if (this.agentNavigationBusy) return { consume: true };
      const toolRow = this.routeToolRowInput(data);
      if (toolRow !== undefined) return toolRow;
      const agentList = this.routeAgentListInput(data);
      if (agentList !== undefined) return agentList;
      if (matchesKey(data, Key.ctrl("g")) && this.liveAgents.selectedItem()) {
        this.openLiveAgents();
        return { consume: true };
      }
      if (this.options.expandedAgent?.()) {
        if (matchesKey(data, Key.escape) && this.options.onLeaveLiveAgent) {
          this.navigateAgent(this.options.onLeaveLiveAgent);
          return { consume: true };
        }
        if (matchesKey(data, Key.ctrl("y")) && this.options.onOpenAgentWorkspace) {
          this.navigateAgent(this.options.onOpenAgentWorkspace);
          return { consume: true };
        }
      }
    }
    if (
      matchesKey(data, Key.alt("enter")) &&
      !this.setupFlow.isWaitingForInput() &&
      !this.bashMode &&
      !this.tui.hasOverlay()
    ) {
      const text = this.editor.getExpandedText();
      this.editor.setText("");
      this.submitEditorInput(text, "queue");
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("/")) || data === "\x1f") {
      if (this.setupFlow.isWaitingForInput()) return undefined;
      this.openCommandPalette();
      return { consume: true };
    }
    // Ctrl+X switches between an open `/btw` fork and its parent; the thread left
    // behind keeps running server-side and replays when it comes back on screen.
    if ((matchesKey(data, Key.ctrl("x")) || data === "\x18") && this.sideView !== undefined) {
      const toggle = this.options.onSideToggle;
      if (toggle === undefined || this.returningFromSideConversation) return { consume: true };
      if (this.switchingSideConversation) return { consume: true };
      this.switchingSideConversation = true;
      this.refreshStatus(this.sideView === "side" ? "returning to main conversation" : "switching to side");
      void toggle()
        .catch((error: unknown) => {
          this.insertCommandResult("/btw", formatError(error), "error");
          this.refreshStatus("side conversation switch failed");
        })
        .finally(() => {
          this.switchingSideConversation = false;
          this.refreshStatusView();
        });
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrlShift("v")) && !this.setupFlow.isWaitingForInput()) {
      this.toggleVoiceTranscripts();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("o")) && !this.setupFlow.isWaitingForInput()) {
      this.toggleOutputExpansion();
      return { consume: true };
    }
    // A running `!` shell command owns Ctrl-C: kill it instead of quitting the face.
    if (matchesKey(data, Key.ctrl("c")) && this.activeBashChild !== undefined) {
      this.activeBashChild.kill("SIGINT");
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.commandPaletteOverlay?.isFocused() === true) {
        this.closeCommandPalette();
        return { consume: true };
      }
      if (this.voiceTranscriptOverlay?.isFocused() === true) {
        this.closeVoiceTranscripts();
        return { consume: true };
      }
      if (this.setupFlow.isWaitingForInput()) {
        this.setupFlow.handleSubmit("/cancel");
        return { consume: true };
      }
      if (this.sideView === "side" && this.options.onSideExit !== undefined) {
        if (this.returningFromSideConversation) return { consume: true };
        this.returningFromSideConversation = true;
        this.activeTurn?.controller.abort();
        this.refreshStatus("returning to main conversation");
        void this.options.onSideExit().catch((error: unknown) => {
          this.returningFromSideConversation = false;
          this.insertCommandResult("/btw", formatError(error), "error");
          this.refreshStatus("side conversation return failed");
        });
        return { consume: true };
      }
      void this.shutdown(0, { abortTurn: true });
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && this.setupFlow.isWaitingForInput()) {
      if (this.setupFlow.hasActivePrompt()) return undefined;
      this.setupFlow.handleSubmit("/cancel");
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && this.voiceTranscriptOverlay !== undefined) {
      this.closeVoiceTranscripts();
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && this.handleActiveTurnEscape()) return { consume: true };
    const bashInput = this.handleBashModeInput(data);
    if (bashInput !== undefined) return bashInput;
    const commandInput = this.handleCommandTypeaheadInput(data);
    if (commandInput !== undefined) return commandInput;
    return undefined;
  }

  private viewedAgent(): { readonly live?: LiveAgent } {
    const seatId = this.options.expandedAgentSeatId?.();
    const live =
      seatId === undefined
        ? undefined
        : (this.options.liveAgents?.() ?? []).find((agent) => agent.seat.seatId === seatId);
    return live === undefined ? {} : { live };
  }

  private editorBorder(): (text: string) => string {
    // pi's bash-mode color is the success green.
    if (this.bashMode) return this.theme.ansi.success;
    if (this.options.expandedAgent?.() !== undefined) return agentTint(this.viewedAgent().live, this.theme);
    return this.theme.ansi.dim;
  }

  private navigateAgent(run: () => Promise<void>): void {
    this.agentNavigationBusy = true;
    void run()
      .catch((error: unknown) => {
        this.insertCommandResult("Agents", herdrJumpError(error), "error");
      })
      .finally(() => {
        this.agentNavigationBusy = false;
        this.tui.requestRender();
      });
  }

  /**
   * The dock's inline list: ↓ from an empty prompt with no completion open
   * expands it, so history and multi-line editing keep their arrows. A key
   * release never moves it (see typeaheadSelectionDelta).
   */
  private routeAgentListInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.liveAgents.focused) {
      if (
        isKeyRelease(data) ||
        !matchesKey(data, Key.down) ||
        this.editor.getText() !== "" ||
        this.editor.isShowingAutocomplete() ||
        !this.liveAgents.focus()
      )
        return undefined;
      this.tui.requestRender();
      return { consume: true };
    }
    if (isKeyRelease(data)) return { consume: true };
    const result = this.liveAgents.handleInput(data);
    this.tui.requestRender();
    if (result === "pass") return undefined;
    const agent = this.liveAgents.selected();
    const handoff = this.liveAgents.selectedHandoff();
    if (result === "open" && handoff !== undefined && this.options.onOpenRoomHandoff)
      this.navigateAgent(() => this.options.onOpenRoomHandoff!(handoff));
    if (result === "open" && agent !== undefined && this.options.onOpenLiveAgent)
      this.navigateAgent(() => this.options.onOpenLiveAgent!(agent));
    return { consume: true };
  }

  private openLiveAgents(): void {
    const picker = new LiveAgentPicker(() => this.options.liveAgents?.() ?? [], this.liveAgents, this.theme, {
      maxHeight: () => Math.floor(this.tui.terminal.rows * 0.7),
      onRender: () => this.tui.requestRender(),
      onClose: () => this.closeLiveAgents(),
      onOpen: (agent) => {
        this.closeLiveAgents();
        if (this.options.onOpenLiveAgent) this.navigateAgent(() => this.options.onOpenLiveAgent!(agent));
      },
      onOpenHandoff: (conversation) => {
        this.closeLiveAgents();
        if (this.options.onOpenRoomHandoff)
          this.navigateAgent(() => this.options.onOpenRoomHandoff!(conversation));
      },
    });
    this.liveAgentOverlay = this.showModalOverlay(picker, clankieModalOverlayOptions());
    this.liveAgentOverlay.focus();
    this.tui.requestRender();
  }

  private closeLiveAgents(): void {
    this.liveAgentOverlay?.hide();
    this.liveAgentOverlay = undefined;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  // --- command typeahead + palette ---

  refreshCommandSurface(text: string): void {
    const disabled = this.setupFlow.isWaitingForInput() || this.bashMode;
    const commandState = disabled
      ? undefined
      : clankieCommandTypeaheadFor(this.options.commands, text, this.commandTypeaheadState);
    const skillSuffix =
      commandState?.matches.length === 0
        ? clankieSlashSkillSuffix(text, this.options.skills ?? [])
        : undefined;
    this.editor.setGhostText(skillSuffix);
    this.commandTypeaheadState = skillSuffix === undefined ? commandState : undefined;
    this.commandTypeaheadPanel.setText(text, this.commandTypeaheadState, disabled);
    this.tui.requestRender();
  }

  private setCommandTypeaheadState(state: ClankieCommandTypeaheadState | undefined): void {
    this.commandTypeaheadState = state;
    this.commandTypeaheadPanel.setText(this.editor.getText(), state, this.setupFlow.isWaitingForInput());
    this.tui.requestRender();
  }

  private handleCommandTypeaheadInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.setupFlow.isWaitingForInput() || this.commandPaletteOverlay?.isFocused() === true)
      return undefined;
    const state = this.commandTypeaheadState;
    if (state === undefined || state.dismissed) return undefined;
    const selected = selectedClankieCommandTypeahead(state);
    const hasSelection = selected !== undefined;
    const listOpen = isClankieCommandTypeaheadOpen(state);
    const exact = isExactClankieCommandTypeahead(state);

    if (listOpen) {
      const delta = typeaheadSelectionDelta(data);
      if (delta !== undefined) {
        this.setCommandTypeaheadState(moveClankieCommandTypeaheadSelection(state, delta));
        return { consume: true };
      }
    }
    if ((listOpen || exact || state.matches.length === 0) && matchesKey(data, Key.escape)) {
      this.setCommandTypeaheadState(dismissClankieCommandTypeahead(state));
      return { consume: true };
    }
    if (hasSelection && (matchesKey(data, Key.tab) || data === "\t")) {
      const text = clankieCommandCompletion(selected);
      this.editor.setText(text);
      this.refreshCommandSurface(text);
      return { consume: true };
    }
    if (hasSelection && listOpen && (matchesKey(data, Key.enter) || data === "\r")) {
      const text = clankieCommandCompletion(selected).trimEnd();
      this.editor.setText(text);
      this.refreshCommandSurface(text);
      return undefined;
    }

    return undefined;
  }

  openCommandPalette(): void {
    this.closeCommandPalette();
    const workbench = new ClankieCommandWorkbench(
      this.options.commands,
      {
        onCancel: () => this.closeCommandPalette(),
        onRender: () => this.tui.requestRender(),
        onSubmit: (text): void => {
          this.closeCommandPalette();
          this.editor.setText(text);
          this.refreshCommandSurface(text);
          this.tui.setFocus(this.editor);
        },
      },
      this.theme.commandUiTheme,
      clankieCommandFilterFromText(this.editor.getText()),
    );
    this.commandPaletteOverlay = this.showModalOverlay(workbench, {
      anchor: "bottom-center",
      maxHeight: "70%",
      margin: { bottom: 3, left: 2, right: 2 },
      width: "92%",
    });
    this.commandPaletteOverlay.focus();
    this.tui.requestRender();
  }

  closeCommandPalette(): void {
    const handle = this.commandPaletteOverlay;
    this.commandPaletteOverlay = undefined;
    if (handle !== undefined) handle.hide();
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  /** Opens the live Discord voice-transcript overlay, or focuses it if already open. */
  openVoiceTranscripts(): boolean {
    if (this.options.voiceTranscripts === undefined) return false;
    if (this.voiceTranscriptOverlay !== undefined) {
      this.voiceTranscriptOverlay.focus();
      this.tui.requestRender();
      return true;
    }
    this.closeCommandPalette();
    const overlay = new ClankieVoiceTranscriptOverlay(
      {
        onClose: () => this.closeVoiceTranscripts(),
        onRender: () => this.tui.requestRender(),
      },
      this.theme.commandUiTheme,
    );
    this.voiceTranscriptOverlay = this.showModalOverlay(overlay, {
      anchor: "center",
      maxHeight: "80%",
      margin: { bottom: 2, left: 2, right: 2, top: 2 },
      minWidth: 48,
      width: "88%",
    });
    const controller = new AbortController();
    this.voiceTranscriptFollow = controller;
    void followVoiceTranscripts({
      client: this.options.voiceTranscripts,
      signal: controller.signal,
      onSnapshot: (snapshot) => overlay.setSnapshot(snapshot),
      onNotice: (message) => overlay.setNotice(message),
    }).catch((error: unknown) => {
      overlay.setNotice(error instanceof Error ? error.message : String(error));
    });
    this.voiceTranscriptOverlay.focus();
    this.tui.requestRender();
    return true;
  }

  closeVoiceTranscripts(): void {
    this.voiceTranscriptFollow?.abort();
    this.voiceTranscriptFollow = undefined;
    const handle = this.voiceTranscriptOverlay;
    this.voiceTranscriptOverlay = undefined;
    if (handle !== undefined) handle.hide();
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  /** Shows a focused panel over the conversation; the returned close hands focus back to the composer. */
  openPanel(component: Component & Focusable): () => void {
    this.closeCommandPalette();
    const handle = this.showModalOverlay(component, {
      anchor: "center",
      maxHeight: "80%",
      margin: { bottom: 2, left: 2, right: 2, top: 2 },
      minWidth: 48,
      width: "88%",
    });
    handle.focus();
    this.tui.requestRender();
    return () => {
      handle.hide();
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    };
  }

  private toggleVoiceTranscripts(): void {
    if (this.voiceTranscriptOverlay !== undefined) {
      this.closeVoiceTranscripts();
      return;
    }
    if (!this.openVoiceTranscripts()) {
      this.insertCommandResult("/vt", "Clankie's voice transcript listing is unavailable.", "error");
    }
  }

  // --- overlays ---

  /** Shows a live, focused panel; the returned close hands focus back to the editor once. */
  openLivePanel(component: Component, onClose?: () => void): () => void {
    this.closeCommandPalette();
    const handle = this.showModalOverlay(component, {
      anchor: "center",
      maxHeight: "80%",
      margin: { bottom: 2, left: 2, right: 2, top: 2 },
      minWidth: 48,
      width: "88%",
    });
    handle.focus();
    this.tui.requestRender();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      handle.hide();
      onClose?.();
      this.tui.setFocus(this.editor);
      this.tui.requestRender();
    };
  }

  showModalOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
    return this.tui.showOverlay(component, options);
  }

  // --- prompt submission ---

  private async submitEditorText(rawPrompt: string, delivery: "steer" | "queue" = "steer"): Promise<void> {
    const prompt = rawPrompt.trim();
    if (prompt.length === 0) return;
    // Inline shell escape: either bash mode is active or the line is `!`-prefixed
    // (typed fast or recalled from history). Runs locally in cwd, independent of
    // any in-flight turn, and stays in bash mode for the next command.
    if (this.bashMode || prompt.startsWith("!")) {
      if (this.options.allowLocalShell === false) {
        this.insertMarkdown("Shell commands are local-only. Use the hosted terminal in the paired app.");
        return;
      }
      const command = (prompt.startsWith("!") ? prompt.slice(1) : prompt).trim();
      if (command.length === 0) return;
      this.rememberPrompt(`!${command}`);
      await this.handleBashPrompt(command);
      return;
    }
    // Local slash commands stay usable while a turn streams. Prompts and skills
    // use the same server admission path, including while he is working.
    if (prompt.startsWith("/")) {
      this.rememberPrompt(prompt);
      await this.handleSlashPrompt(prompt, delivery);
      return;
    }
    this.rememberPrompt(prompt);
    await this.submitUserPrompt(prompt, delivery);
  }

  private async handleSlashPrompt(prompt: string, delivery: "steer" | "queue"): Promise<void> {
    const withoutSlash = prompt.slice(1);
    const token = (withoutSlash.split(/\s+/u)[0] ?? "").toLowerCase();
    const command = resolveClankieCommand(this.options.commands, token)?.command;
    if (command === undefined) {
      if (resolveClankieSlashSkill(prompt, this.options.skills ?? []) !== undefined) {
        if (this.sideView === "side") {
          this.insertCommandResult(prompt, "Skills are unavailable inside /btw.", "error");
          return;
        }
        await this.submitUserPrompt(prompt, delivery);
        return;
      }
      this.insertCommandResult(prompt, `Unknown command /${token}. Run /help for the command list.`, "error");
      return;
    }
    const argument = withoutSlash.slice(token.length).trim();
    if (this.sideView === "side" && command.availableInSideConversation !== true) {
      this.insertCommandResult(prompt, `/${command.name} is unavailable inside /btw.`, "error");
      return;
    }
    if (argument.length > 0 && !command.takesArgument) {
      this.insertCommandResult(prompt, `/${command.name} does not take an argument.`, "error");
      return;
    }
    try {
      await command.run(argument, this);
    } catch (error) {
      this.insertCommandResult(prompt, formatError(error), "error");
    }
  }

  async submitUserPrompt(prompt: string, delivery: "steer" | "queue" = "steer"): Promise<void> {
    if (this.respondingState) {
      try {
        if (this.options.onPendingPrompt === undefined)
          throw new Error("This connection cannot accept input while working");
        await this.options.onPendingPrompt(prompt, delivery);
      } catch (error) {
        this.restoreFailedPrompt(prompt, error);
        this.insertMarkdown(`**Error**\n\n${formatError(error)}`);
      }
      return;
    }
    const onPrompt = this.options.onPrompt;
    if (onPrompt === undefined) {
      this.insertMarkdown("**Notice**\n\nNo Clankie session is connected; prompts go nowhere yet.");
      return;
    }
    const controller = new AbortController();
    this.insertUserMessage(prompt);
    const turn: ActivePromptTurn = { controller };
    this.activeTurn = turn;
    this.startTurnLoader();
    try {
      await onPrompt(prompt, this, controller.signal, delivery);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (error instanceof OperatorConversationSendError) this.restoreFailedPrompt(prompt, error);
        this.insertMarkdown(`**Error**\n\n${formatError(error)}`);
      }
    } finally {
      this.stopTurnLoader();
      if (this.activeTurn === turn) this.activeTurn = undefined;
      this.refreshStatus("ready");
    }
  }

  private restoreFailedPrompt(prompt: string, error: unknown): void {
    // Keep newer input intact; confirmed turns never return to the editor.
    if (this.editor.getText().length === 0) {
      this.editor.setText(prompt);
      this.refreshCommandSurface(prompt);
    } else {
      const label =
        error instanceof OperatorConversationSendError && error.delivery === "unconfirmed"
          ? "Unconfirmed prompt"
          : "Unsent prompt";
      this.insertMarkdown(`**${label}**\n\n${prompt}`);
    }
  }

  private handleActiveTurnEscape(): boolean {
    const turn = this.activeTurn;
    if (turn === undefined || turn.controller.signal.aborted) return false;

    const onInterrupt = this.options.onInterrupt;
    // No interrupt path, or a second Esc while one is pending: detach —
    // stop observing and free the console while the turn continues.
    if (onInterrupt === undefined || turn.interrupting === true) {
      turn.loader?.setMessage("Detaching — Clankie continues...");
      this.refreshStatus("detaching — Clankie continues");
      turn.controller.abort();
      this.tui.requestRender();
      return true;
    }
    turn.interrupting = true;
    turn.loader?.setMessage("Interrupting...");
    this.refreshStatus("interrupting");
    void onInterrupt().then((cancelled) => {
      if (this.activeTurn !== turn || turn.controller.signal.aborted) return;
      if (cancelled) {
        // The same observer may go on to a queued turn, which stays interruptible.
        turn.interrupting = false;
        return;
      }
      // The service could not cancel this run; fall back to detaching.
      turn.loader?.setMessage("Detaching — Clankie continues...");
      this.refreshStatus("detaching — Clankie continues");
      turn.controller.abort();
      this.tui.requestRender();
    });
    this.tui.requestRender();
    return true;
  }

  private rememberPrompt(prompt: string): void {
    this.editor.addToHistory(prompt);
    const historyPath = this.historyPath();
    if (historyPath !== undefined) void appendPromptHistory(historyPath, prompt);
  }

  private historyPath(): string | undefined {
    return this.options.historyPath;
  }

  // --- bash mode ---

  /**
   * Toggle the inline shell escape. In bash mode the editor border switches to
   * the accent color, the command typeahead is suppressed, and a submitted line
   * runs as a host shell command instead of a captain prompt. Pressing `!` on an
   * empty editor enters; Esc or backspace-on-empty exits.
   */
  private setBashMode(on: boolean): void {
    if (this.bashMode === on) return;
    this.bashMode = on;
    this.refreshCommandSurface(this.editor.getText());
    this.refreshStatusView();
    this.tui.requestRender();
  }

  private handleBashModeInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (this.setupFlow.isWaitingForInput()) return undefined;
    if (!this.bashMode && matchesKey(data, "!") && this.editor.getText().length === 0) {
      this.setBashMode(true);
      return { consume: true };
    }
    if (this.bashMode && matchesKey(data, Key.escape)) {
      this.setBashMode(false);
      return { consume: true };
    }
    if (this.bashMode && matchesKey(data, Key.backspace) && this.editor.getText().length === 0) {
      this.setBashMode(false);
      return { consume: true };
    }
    return undefined;
  }

  private async handleBashPrompt(command: string): Promise<void> {
    // pi's bash execution block: `$ command` header, streaming preview, loader.
    const block = new BashExecutionComponent(command, this.tui);
    this.registerExpandable(block);
    this.appendChatBlock(block);
    this.bashRunning += 1;
    this.refreshStatusView();
    try {
      const result = await runFaceBashCommand(command, {
        cwd: this.cwdValue,
        env: this.env,
        onOutput: (chunk) => {
          block.appendOutput(chunk);
        },
        onSpawn: (child) => {
          this.activeBashChild = child;
        },
      });
      if (result.timedOut) block.appendOutput("\n[timed out]");
      block.setComplete(result.code, result.code === 130);
    } finally {
      this.activeBashChild = undefined;
      this.bashRunning = Math.max(0, this.bashRunning - 1);
      this.refreshStatusView();
      this.tui.requestRender();
    }
  }

  private insertDebugSnapshot(): void {
    this.insertMarkdown(
      [
        "**Notice**",
        "",
        `terminal ${this.tui.terminal.columns}x${this.tui.terminal.rows} · chat blocks ${this.chat.children.length}`,
        `header=${this.headerVisibleState ? "on" : "off"} · status=${this.currentStatusLabel}`,
      ].join("\n"),
    );
  }
}
