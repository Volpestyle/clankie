/**
 * The Clankie face shell: pi's interactive chat surface wearing Clankie's
 * chrome. The renderer is pi's fullscreen mode — a TuiAltScreen whose
 * transcript lives in a ScrollView (mouse wheel, scrollbar, drag text
 * selection, Ctrl+Shift+F search) above a dock that pins the working
 * indicator, editor, typeahead, and footer to the bottom of the terminal.
 * Messages render with pi's own components (user boxes, assistant markdown,
 * bordered tool executions), and clicking a tool or bash block toggles its
 * output between preview and full. Clankie's banner, slash-command typeahead,
 * Ctrl+/ workbench, guided-flow modals, and inline `!` shell escape stay
 * intact. Dynamic data flows in through `FaceShellOptions` (commands,
 * onPrompt, footerData) so the clankie service stays behind
 * `@clankie/api-client`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  Container,
  Editor,
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
import { ClankieCommandTextResultComponent, type CommandLogTone } from "./command-log.ts";
import { createFaceThemeBundle, type FaceThemeBundle } from "./theme.ts";
import { ClankieFooterComponent, displayHomePath, type ClankieFooterData } from "./footer.ts";
import { createSetupFlow, type SetupFlowController } from "./setup-flow.ts";
import { appendPromptHistory, readPromptHistory } from "./prompt-history.ts";
import { clankieSlashSkillSuffix, resolveClankieSlashSkill } from "../skill-catalog.ts";

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
  run(argument: string, shell: ClankieFaceShell): Promise<void> | void;
}

export interface FaceShellOptions {
  readonly commands: readonly FaceShellCommand[];
  /** Initial working directory for the `!` shell escape and path autocomplete; {@link ClankieFaceShell.setCwd} moves it. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly bannerFields: BannerFields;
  readonly autocomplete?: ClankieAutocompleteOptions;
  readonly skills?: readonly ClankieAutocompleteSkill[];
  /** File that persists editor prompt history across sessions. */
  readonly historyPath?: string;
  /** Model, conversation title, and context usage for the pi-style footer. */
  readonly footerData?: () => ClankieFooterData;
  /** Extra footer status segments (presence, activity, …) on the last footer line. */
  readonly statusExtras?: () => readonly string[];
  /** Handles a plain prompt (not a slash command, not `!`). */
  readonly onPrompt?: (prompt: string, shell: ClankieFaceShell, signal: AbortSignal) => Promise<void>;
  /**
   * Interrupts the in-flight turn server-side (Esc). Resolves false when the
   * turn could not be cancelled, in which case the shell detaches observation
   * instead so Esc never leaves the console stuck.
   */
  readonly onInterrupt?: () => Promise<boolean>;
  readonly onExit?: () => Promise<void> | void;
}

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

/** Walks the transcript's flat rows to the block a click landed on. */
export function clickedTranscriptBlock(
  blocks: readonly Component[],
  width: number,
  flatRow: number,
): Component | undefined {
  let row = flatRow;
  for (const block of blocks) {
    const rows = block.render(width).length;
    if (row < rows) return block;
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
  private readonly statusContainer = new Container();
  private readonly editor: Editor;
  private readonly commandTypeaheadPanel: ClankieCommandTypeaheadPanel;
  private readonly footer: ClankieFooterComponent;

  private headerVisibleState: boolean;

  private uiReady = false;
  private shutdownStarted = false;
  private currentStatusLabel = "ready";
  private commandTypeaheadState: ClankieCommandTypeaheadState | undefined;
  private commandPaletteOverlay: OverlayHandle | undefined;

  /** Follows the selected conversation's workspace, so `!` lands where he works. */
  private cwdValue: string;
  private bashMode = false;
  private bashRunning = 0;
  private activeBashChild: ChildProcess | undefined;

  private respondingState = false;
  private activeTurn: ActivePromptTurn | undefined;
  private activeLoader: Loader | undefined;
  private runningTurn: Promise<void> | undefined;

  /** Live tool executions keyed by toolCallId until their result lands. */
  private readonly activeToolBlocks = new Map<string, ToolExecutionComponent>();
  /** Blocks a click or Ctrl+O toggles between preview and full output. */
  private readonly expandableBlocks = new Map<
    Component,
    { expanded: boolean; setExpanded(expanded: boolean): void }
  >();
  private outputExpanded = false;
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
    );
    this.transcriptScrollView = new ScrollView(this.document, {
      follow: "end",
      overscroll: "chain",
      primary: true,
      scrollbar: "auto",
      scrollbarStyle: selectionBg,
    });
    this.editor = new Editor(this.tui, this.theme.editorTheme, { autocompleteMaxVisible: 12 });
    this.commandTypeaheadPanel = new ClankieCommandTypeaheadPanel(
      options.commands,
      this.theme.commandUiTheme,
      {
        maxVisibleRows: () => this.maxCommandTypeaheadRows(),
      },
    );
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
    this.editor.onSubmit = (submitted) => {
      this.refreshCommandSurface("");
      if (this.setupFlow.handleSubmit(submitted)) return;
      // Capture before submitting: anything entered while a turn is already
      // streaming is a concurrent slash command (or a deferred prompt) and must
      // not clobber the tracked in-flight turn.
      const concurrent = this.respondingState;
      const submission = this.submitEditorText(submitted).catch((error: unknown) => {
        this.insertMarkdown(`**Error**\n\n${formatError(error)}`);
      });
      if (concurrent) return;
      const tracked: Promise<void> = submission.finally(() => {
        if (this.runningTurn === tracked) this.runningTurn = undefined;
      });
      this.runningTurn = tracked;
    };
  }

  // --- lifecycle ---

  start(): void {
    // pi's fullscreen layout: the transcript ScrollView takes every spare row,
    // and the dock (working status, editor, Clankie's typeahead, footer) stays
    // pinned to the bottom of the terminal.
    this.document.addChild(this.banner);
    this.document.addChild(this.chat);
    for (const component of [
      this.document,
      this.statusContainer,
      this.editor,
      this.commandTypeaheadPanel,
      this.footer,
    ]) {
      this.tui.addChild(component);
    }
    const dock = new VStack([
      { component: this.statusContainer, shrink: 1, minSize: 0 },
      { component: this.editor, shrink: 1, minSize: 3 },
      { component: this.commandTypeaheadPanel, shrink: 1, minSize: 0 },
      { component: this.footer, shrink: 1, minSize: 1 },
    ]);
    this.tui.setLayoutRoot(
      new VStack([
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
    // AssistantMessageComponent carries its own leading spacer.
    this.appendChatBlock(new AssistantMessageComponent(assistantEnvelope([{ text, type: "text" }])), {
      spacer: false,
    });
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
        undefined,
        this.tui,
        this.cwdValue,
      );
      this.registerExpandable(component);
      this.activeToolBlocks.set(toolCallId, component);
      this.chat.addChild(component);
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
        undefined,
        this.tui,
        this.cwdValue,
      );
      this.registerExpandable(component);
      this.chat.addChild(component);
      component.markExecutionStarted();
    }
    this.activeToolBlocks.delete(toolCallId);
    component.setArgsComplete();
    component.updateResult({
      content: [{ text: outcome.detail ?? "", type: "text" }],
      isError: outcome.failed,
    });
    this.tui.requestRender();
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

  insertCommandResult(prompt: string, message: string, tone: CommandLogTone): void {
    this.appendChatBlock(new ClankieCommandTextResultComponent(prompt, message, tone, this.theme.ansi));
  }

  clearTranscript(): void {
    this.chat.clear();
    this.activeToolBlocks.clear();
    this.expandableBlocks.clear();
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
    this.handleTranscriptClick(mouse.col - 1, mouse.row - 1);
  }

  private handleTranscriptClick(x: number, y: number): void {
    if (this.tui.hasOverlayEntries || this.setupFlow.isWaitingForInput()) return;
    const viewportHeight = this.transcriptScrollView.viewportHeight;
    if (x < 0 || y < 0 || viewportHeight <= 0 || y >= viewportHeight) return;
    const width = this.transcriptScrollView.getContentWidth(this.tui.terminal.columns);
    if (x >= width) return;
    const target = clickedTranscriptBlock(
      [this.banner, ...this.chat.children],
      width,
      this.transcriptScrollView.scrollTop + y,
    );
    if (target === undefined) return;
    const entry = this.expandableBlocks.get(target);
    if (entry === undefined) return;
    entry.expanded = !entry.expanded;
    entry.setExpanded(entry.expanded);
    this.tui.requestRender();
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
      this.currentStatusLabel === "ready" || this.currentStatusLabel === "streaming"
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
    return `${message} (esc to interrupt)`;
  }

  // --- input routing ---

  private routeInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (matchesKey(data, Key.ctrl("/")) || data === "\x1f") {
      if (this.setupFlow.isWaitingForInput()) return undefined;
      this.openCommandPalette();
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
      if (this.setupFlow.isWaitingForInput()) {
        this.setupFlow.handleSubmit("/cancel");
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
    if (matchesKey(data, Key.escape) && this.handleActiveTurnEscape()) return { consume: true };
    const bashInput = this.handleBashModeInput(data);
    if (bashInput !== undefined) return bashInput;
    const commandInput = this.handleCommandTypeaheadInput(data);
    if (commandInput !== undefined) return commandInput;
    return undefined;
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

  // --- overlays ---

  showModalOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
    return this.tui.showOverlay(component, options);
  }

  // --- prompt submission ---

  private async submitEditorText(rawPrompt: string): Promise<void> {
    const prompt = rawPrompt.trim();
    if (prompt.length === 0) return;
    // Inline shell escape: either bash mode is active or the line is `!`-prefixed
    // (typed fast or recalled from history). Runs locally in cwd, independent of
    // any in-flight turn, and stays in bash mode for the next command.
    if (this.bashMode || prompt.startsWith("!")) {
      const command = (prompt.startsWith("!") ? prompt.slice(1) : prompt).trim();
      if (command.length === 0) return;
      this.rememberPrompt(`!${command}`);
      await this.handleBashPrompt(command);
      return;
    }
    // Slash commands stay usable while a turn streams, so they are never gated on
    // respondingState. A second plain prompt would collide with the active turn, so
    // restore the text rather than dropping what the user typed.
    if (prompt.startsWith("/")) {
      this.rememberPrompt(prompt);
      await this.handleSlashPrompt(prompt);
      return;
    }
    if (this.respondingState) {
      this.editor.setText(rawPrompt);
      this.refreshCommandSurface(rawPrompt);
      return;
    }
    this.rememberPrompt(prompt);
    await this.submitPrompt(prompt);
  }

  private async handleSlashPrompt(prompt: string): Promise<void> {
    const withoutSlash = prompt.slice(1);
    const token = (withoutSlash.split(/\s+/u)[0] ?? "").toLowerCase();
    const command = resolveClankieCommand(this.options.commands, token)?.command;
    if (command === undefined) {
      if (resolveClankieSlashSkill(prompt, this.options.skills ?? []) !== undefined) {
        if (this.respondingState) {
          this.editor.setText(prompt);
          this.refreshCommandSurface(prompt);
          return;
        }
        await this.submitPrompt(prompt);
        return;
      }
      this.insertCommandResult(prompt, `Unknown command /${token}. Run /help for the command list.`, "error");
      return;
    }
    const argument = withoutSlash.slice(token.length).trim();
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

  private async submitPrompt(prompt: string): Promise<void> {
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
      await onPrompt(prompt, this, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) this.insertMarkdown(`**Error**\n\n${formatError(error)}`);
    } finally {
      this.stopTurnLoader();
      if (this.activeTurn === turn) this.activeTurn = undefined;
      this.refreshStatus("ready");
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
      if (cancelled || this.activeTurn !== turn || turn.controller.signal.aborted) return;
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
    // pi's bash-mode color is the success green.
    this.editor.borderColor = on ? this.theme.ansi.success : this.theme.ansi.dim;
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
