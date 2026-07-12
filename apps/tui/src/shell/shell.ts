/**
 * The Clankie face shell: assembles the ported v1 face components (banner,
 * transcript viewport, status bar, slash-command typeahead, editor) into the
 * fullscreen differential-render layout, and owns the central input router,
 * overlay/selection plumbing, guided-flow engine, turn loader, and inline `!`
 * shell escape. Extracted from v1's `scripts/clankie.ts` monolith (clankie
 * snapshot 04734df9) with the eve brain coupling removed: mission data flows
 * in through `FaceShellOptions` (commands, onPrompt, statusExtras) so the
 * control plane stays behind `@clankie/api-client`.
 */
import type { ChildProcess } from "node:child_process";
import {
  Editor,
  Key,
  Loader,
  matchesKey,
  ProcessTerminal,
  TUI,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
} from "@earendil-works/pi-tui";
import { ClankieBannerComponent, type BannerFields } from "../face/clankie-banner.ts";
import {
  AGENT_SPINNER_CYCLE_NAME,
  DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS,
  resolveAgentSpinner,
  type AgentSpinnerSelection,
  type ResolvedAgentSpinner,
} from "../face/agent-spinners.ts";
import {
  resolveClankieChromeMouseTargetFromBands,
  resolveClankieCommandRows,
  resolveClankieOverlayFrame,
  resolveClankieOverlayMouseTarget,
  resolveClankieTranscriptMouseTargetFromBands,
  resolveClankieTranscriptRows,
  type ClankieFaceBandRows,
  type ClankieOverlayMouseTarget,
} from "../face/clankie-face-layout.ts";
import {
  ClankieChromeSelectableComponent,
  ClankieChromeSelection,
} from "../face/clankie-chrome-selection.ts";
import {
  isClankieLeftMouseButton,
  parseClankieSgrMouse,
  type ClankieSgrMouseEvent,
} from "../face/clankie-sgr-mouse.ts";
import { writeClankieClipboard } from "../face/clankie-clipboard.ts";
import {
  createClankieAutocompleteProvider,
  type ClankieAutocompleteOptions,
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
  type ClankieCommandTypeaheadState,
} from "../face/clankie-command-ui.ts";
import { clankieCommandCompletion } from "../face/clankie-autocomplete.ts";
import {
  ClankieTranscriptViewport,
  type ClankieTranscriptBlockHandle,
  type ClankieTranscriptBlockOptions,
  type TranscriptUnderfilledAlignment,
} from "../face/clankie-transcript-viewport.ts";
import { shouldRouteClankieTranscriptGlobalInput } from "../face/clankie-transcript-key-routing.ts";
import { ClankieTranscriptMarkdownBlock } from "../face/clankie-transcript-block.ts";
import { ClankieBashResultComponent, runFaceBashCommand } from "../face/clankie-face-bash.ts";
import {
  ClankieCommandResultComponent,
  ClankieCommandTextResultComponent,
  type CommandLogTone,
} from "./command-log.ts";
import {
  CLANKIE_TUI_SPINNER_ENV,
  CLANKIE_TUI_SPINNER_RATE_MS_ENV,
  layoutSettingsFromEnv,
  parseAgentSpinnerCycleRateMs,
  type InputPlacement,
  type LayoutSettings,
  type StatusPlacement,
} from "./face-settings.ts";
import { createFaceThemeBundle, type FaceThemeBundle } from "./theme.ts";
import { ClankieStatusBarComponent } from "./status-bar.ts";
import { createSetupFlow, type SetupFlowController } from "./setup-flow.ts";
import { appendPromptHistory, readPromptHistory } from "./prompt-history.ts";

// Mode 1002 reports drag motion while a button is held (1000 only reports
// press/release), which the transcript needs to track a selection gesture.
const CLANKIE_MOUSE_TRACKING_ENABLE = "\x1b[?1002h\x1b[?1006h";
const CLANKIE_MOUSE_TRACKING_DISABLE = "\x1b[?1002l\x1b[?1006l";
const MIN_TRANSCRIPT_ROWS = 4;

export type FaceBlockHandle = {
  remove(): void;
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
  /** Working directory for the inline `!` shell escape and path autocomplete. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly bannerFields: BannerFields;
  readonly autocomplete?: ClankieAutocompleteOptions;
  /** File that persists editor prompt history across sessions. */
  readonly historyPath?: string;
  /** Extra status bar segments (model, mission, …) appended after shell state. */
  readonly statusExtras?: () => readonly string[];
  /** Handles a plain prompt (not a slash command, not `!`). */
  readonly onPrompt?: (prompt: string, shell: ClankieFaceShell, signal: AbortSignal) => Promise<void>;
  /** Live durable turns detach on Escape because aborting observation does not cancel server work. */
  readonly interruptMode?: "cancel" | "detach";
  readonly onExit?: () => Promise<void> | void;
}

type ActivePromptTurn = {
  readonly controller: AbortController;
  readonly prompt: string;
  loader?: Loader | undefined;
  loaderBlock?: ClankieTranscriptBlockHandle | undefined;
  promptRestoreEligible: boolean;
  userBlock?: FaceBlockHandle | undefined;
};

type SelectableOverlayEntry = {
  hidden: boolean;
  readonly component: ClankieChromeSelectableComponent;
  readonly options?: OverlayOptions;
};

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function displayHomePath(path: string): string {
  const home = process.env.HOME;
  if (home !== undefined && home.length > 0 && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

export class ClankieFaceShell {
  readonly tui: TUI;
  readonly theme: FaceThemeBundle;
  readonly setupFlow: SetupFlowController;

  private readonly options: FaceShellOptions;
  private readonly env: NodeJS.ProcessEnv;
  private readonly banner: ClankieBannerComponent;
  private readonly status = new ClankieStatusBarComponent();
  private readonly editor: Editor;
  private readonly commandTypeaheadPanel: ClankieCommandTypeaheadPanel;
  private readonly transcriptViewport: ClankieTranscriptViewport;
  private readonly chromeSelection = new ClankieChromeSelection();
  private readonly selectableBanner: ClankieChromeSelectableComponent;
  private readonly selectableStatus: ClankieChromeSelectableComponent;
  private readonly selectableTypeahead: ClankieChromeSelectableComponent;
  private readonly selectableOverlays: SelectableOverlayEntry[] = [];

  private layoutSettingsState: LayoutSettings;
  private headerVisibleState: boolean;
  private agentSpinner: ResolvedAgentSpinner;
  private agentSpinnerCycleRateMs: number;

  private uiReady = false;
  private shutdownStarted = false;
  private currentStatusLabel = "ready";
  private commandTypeaheadState: ClankieCommandTypeaheadState | undefined;
  private commandPaletteOverlay: OverlayHandle | undefined;
  private chromeSelectionActive = false;
  private transcriptSelectionActive = false;
  private transcriptSelectionDragged = false;
  private transcriptScrollbarDragActive = false;
  private transcriptClickTarget: { readonly col: number; readonly row: number } | undefined;

  private bashMode = false;
  private bashRunning = 0;
  private activeBashChild: ChildProcess | undefined;

  private respondingState = false;
  private activeTurn: ActivePromptTurn | undefined;
  private activeLoader: Loader | undefined;
  private activeLoaderBlock: ClankieTranscriptBlockHandle | undefined;
  private runningTurn: Promise<void> | undefined;

  constructor(options: FaceShellOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.theme = createFaceThemeBundle(process.stdout);
    const { ansi } = this.theme;

    this.layoutSettingsState = layoutSettingsFromEnv(this.env);
    this.headerVisibleState = this.env.CLANKIE_HEADER !== "0" && this.env.CLANKIE_HEADER !== "off";
    this.agentSpinnerCycleRateMs =
      parseAgentSpinnerCycleRateMs(
        this.env[CLANKIE_TUI_SPINNER_RATE_MS_ENV],
        DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS,
      ) ?? DEFAULT_AGENT_SPINNER_CYCLE_DWELL_MS;
    this.agentSpinner = resolveAgentSpinner(this.env[CLANKIE_TUI_SPINNER_ENV], {
      cycleDwellMs: this.agentSpinnerCycleRateMs,
      unicode: this.theme.capabilities.unicode,
    });

    this.tui = new TUI(new ProcessTerminal());
    this.tui.setClearOnShrink(true);
    this.banner = new ClankieBannerComponent(
      options.bannerFields,
      this.theme.capabilities,
      this.headerVisibleState,
    );
    this.editor = new Editor(this.tui, this.theme.editorTheme, { autocompleteMaxVisible: 12 });
    this.commandTypeaheadPanel = new ClankieCommandTypeaheadPanel(
      options.commands,
      this.theme.commandUiTheme,
      {
        maxVisibleRows: () => this.maxCommandTypeaheadRows(),
      },
    );
    this.selectableBanner = new ClankieChromeSelectableComponent(this.banner, "banner", this.chromeSelection);
    this.selectableStatus = new ClankieChromeSelectableComponent(this.status, "status", this.chromeSelection);
    this.selectableTypeahead = new ClankieChromeSelectableComponent(
      this.commandTypeaheadPanel,
      "typeahead",
      this.chromeSelection,
    );
    this.transcriptViewport = new ClankieTranscriptViewport(
      (width) => this.maxTranscriptRows(width),
      {
        dim: ansi.dim,
        scrollbarThumb: ansi.selectedDescription,
        scrollbarTrack: ansi.dim,
        selected: ansi.cyan,
      },
      {
        blockSpacing: 1,
        scrollbar: true,
        underfilledAlignment: this.transcriptUnderfilledAlignment(),
        unicode: this.theme.capabilities.unicode,
      },
    );

    this.setupFlow = createSetupFlow({
      tui: this.tui,
      editor: this.editor,
      selectListTheme: this.theme.selectListTheme,
      setStatus: (message) => this.refreshStatus(message),
      refreshStatusView: () => this.refreshStatusView(),
      refreshCommandSurface: (text) => this.refreshCommandSurface(text),
      showSelectableOverlay: (component, overlayOptions) =>
        this.showSelectableOverlay(component, overlayOptions),
    });

    this.editor.setAutocompleteProvider(
      createClankieAutocompleteProvider(options.commands, options.cwd, options.autocomplete ?? {}),
    );
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
    this.applyFaceLayout();
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => this.routeInput(data));
    this.tui.onDebug = () => this.insertDebugSnapshot();
    this.tui.start();
    this.tui.terminal.write(CLANKIE_MOUSE_TRACKING_ENABLE);
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
    this.restoreTerminal();
    try {
      await this.options.onExit?.();
    } catch {
      // Best-effort: exit cleanup must not block shutdown.
    }
    return process.exit(code);
  }

  /** Best-effort terminal restore for the crash-safety envelope. */
  restoreTerminal(): void {
    try {
      this.tui.terminal.write(CLANKIE_MOUSE_TRACKING_DISABLE);
    } catch {
      // Best-effort.
    }
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

  insertTranscript(
    component: Component,
    options?: ClankieTranscriptBlockOptions,
  ): ClankieTranscriptBlockHandle {
    return this.transcriptViewport.addChild(component, options);
  }

  insertMarkdown(text: string, options?: ClankieTranscriptBlockOptions): FaceBlockHandle {
    const { ansi, markdownTheme } = this.theme;
    const component = new ClankieTranscriptMarkdownBlock(text, {
      bold: ansi.bold,
      cyan: ansi.cyan,
      dim: ansi.dim,
      green: ansi.green,
      loadingGlyph: () => this.currentAgentSpinnerFrame().trimEnd() || "◜",
      markdown: markdownTheme,
      red: ansi.red,
      yellow: ansi.yellow,
    });
    const block = this.insertTranscript(component, options);
    this.tui.requestRender();
    return {
      remove: (): void => {
        block.remove();
        this.tui.requestRender();
      },
      setMarkdown: (markdown: string): void => {
        component.setMarkdown(markdown);
        this.tui.requestRender();
      },
    };
  }

  insertCommandResult(prompt: string, message: string, tone: CommandLogTone): void {
    this.insertTranscript(new ClankieCommandTextResultComponent(prompt, message, tone, this.theme.ansi));
    this.tui.requestRender();
  }

  insertCommandComponent(prompt: string, component: Component, tone: CommandLogTone): void {
    this.insertTranscript(new ClankieCommandResultComponent(prompt, tone, component, this.theme.ansi));
    this.tui.requestRender();
  }

  clearTranscript(): void {
    this.transcriptViewport.clear();
    this.tui.requestRender();
  }

  // --- status / banner ---

  refreshStatus(label: string): void {
    this.currentStatusLabel = label;
    this.refreshStatusView();
  }

  refreshStatusView(): void {
    if (!this.uiReady) return;
    this.status.setText(this.formatStatusText(this.currentStatusLabel));
    this.tui.requestRender();
  }

  setBannerFields(fields: BannerFields): void {
    this.banner.setFields(fields);
    this.tui.requestRender();
  }

  get headerVisible(): boolean {
    return this.headerVisibleState;
  }

  setHeaderVisible(visible: boolean): void {
    this.headerVisibleState = visible;
    this.banner.setVisible(visible);
    this.refreshStatusView();
    this.tui.requestRender();
  }

  // --- layout ---

  get layoutSettings(): LayoutSettings {
    return this.layoutSettingsState;
  }

  setLayoutSettings(settings: Partial<LayoutSettings>): void {
    this.layoutSettingsState = {
      inputPlacement: settings.inputPlacement ?? this.layoutSettingsState.inputPlacement,
      statusPlacement: settings.statusPlacement ?? this.layoutSettingsState.statusPlacement,
    };
    this.applyFaceLayout();
    this.refreshStatusView();
  }

  applyFaceLayout(): void {
    this.transcriptViewport.setUnderfilledAlignment(this.transcriptUnderfilledAlignment());
    this.syncBannerChromePadding();
    for (const component of this.rootFaceComponents()) this.tui.removeChild(component);
    for (const component of this.orderedFaceComponents()) this.tui.addChild(component);
    this.tui.setFocus(this.editor);
    if (this.uiReady) this.tui.requestRender();
  }

  private orderedFaceComponents(): Component[] {
    const statusAboveInput = this.layoutSettingsState.statusPlacement === "above-input";
    if (this.layoutSettingsState.inputPlacement === "top") {
      const topControls = statusAboveInput
        ? [this.selectableStatus, this.editor, this.selectableTypeahead]
        : [this.editor, this.selectableStatus, this.selectableTypeahead];
      return [this.selectableBanner, ...topControls, this.transcriptViewport];
    }
    const bottomControls = statusAboveInput
      ? [this.selectableTypeahead, this.selectableStatus, this.editor]
      : [this.selectableTypeahead, this.editor, this.selectableStatus];
    return [this.selectableBanner, this.transcriptViewport, ...bottomControls];
  }

  private rootFaceComponents(): Component[] {
    return [
      this.selectableBanner,
      this.transcriptViewport,
      this.selectableStatus,
      this.selectableTypeahead,
      this.editor,
    ];
  }

  private transcriptUnderfilledAlignment(): TranscriptUnderfilledAlignment {
    return this.layoutSettingsState.inputPlacement === "top" ? "top" : "bottom";
  }

  private syncBannerChromePadding(): void {
    const compactBelowHeader =
      this.layoutSettingsState.inputPlacement === "top" &&
      this.layoutSettingsState.statusPlacement === "above-input";
    this.banner.setVerticalPadding({ bottom: compactBelowHeader ? 0 : 1, top: 1 });
  }

  private layoutBandRows(width: number): ClankieFaceBandRows[] {
    return this.orderedFaceComponents().map((component) => {
      if (component === this.selectableBanner)
        return { band: "banner", rows: this.banner.render(width).length };
      if (component === this.transcriptViewport)
        return { band: "transcript", rows: this.maxTranscriptRows(width) };
      if (component === this.selectableStatus)
        return { band: "status", rows: this.status.render(width).length };
      if (component === this.selectableTypeahead)
        return { band: "typeahead", rows: this.commandTypeaheadPanel.render(width).length };
      return { band: "editor", rows: this.editor.render(width).length };
    });
  }

  private maxTranscriptRows(width: number): number {
    const reservedRows =
      this.banner.render(width).length +
      this.status.render(width).length +
      this.commandTypeaheadPanel.render(width).length +
      this.editor.render(width).length;
    return resolveClankieTranscriptRows({
      minRows: MIN_TRANSCRIPT_ROWS,
      reservedRows,
      terminalRows: this.tui.terminal.rows,
    });
  }

  private maxCommandTypeaheadRows(width = this.tui.terminal.columns): number {
    const reservedRows =
      this.banner.render(width).length +
      this.status.render(width).length +
      this.editor.render(width).length +
      MIN_TRANSCRIPT_ROWS;
    return resolveClankieCommandRows({
      maxRows: 10,
      reservedRows,
      terminalRows: this.tui.terminal.rows,
    });
  }

  // --- spinner ---

  get spinner(): ResolvedAgentSpinner {
    return this.agentSpinner;
  }

  get spinnerCycleRateMs(): number {
    return this.agentSpinnerCycleRateMs;
  }

  setSpinner(selection: AgentSpinnerSelection | undefined): void {
    this.agentSpinner = resolveAgentSpinner(selection ?? AGENT_SPINNER_CYCLE_NAME, {
      cycleDwellMs: this.agentSpinnerCycleRateMs,
      unicode: this.theme.capabilities.unicode,
    });
    this.tui.requestRender();
  }

  setSpinnerCycleRateMs(rateMs: number): void {
    this.agentSpinnerCycleRateMs = rateMs;
    this.setSpinner(this.agentSpinner.name as AgentSpinnerSelection);
  }

  private currentAgentSpinnerFrame(): string {
    const index = Math.floor(Date.now() / this.agentSpinner.intervalMs) % this.agentSpinner.frames.length;
    return this.agentSpinner.frames[index] ?? "";
  }

  private loaderIndicator(): { frames: string[]; intervalMs: number } {
    return {
      frames: this.agentSpinner.frames.map((frame) => this.theme.ansi.cyan(frame)),
      intervalMs: this.agentSpinner.intervalMs,
    };
  }

  // --- turn loader ---

  get isResponding(): boolean {
    return this.respondingState;
  }

  startTurnLoader(message = "Thinking..."): void {
    this.respondingState = true;
    const loader = new Loader(
      this.tui,
      this.theme.ansi.cyan,
      this.theme.ansi.dim,
      message,
      this.loaderIndicator(),
    );
    this.activeLoader = loader;
    const loaderBlock = this.insertTranscript(loader, { collapsible: false, pin: "bottom" });
    this.activeLoaderBlock = loaderBlock;
    if (this.activeTurn !== undefined) {
      this.activeTurn.loader = loader;
      this.activeTurn.loaderBlock = loaderBlock;
    }
    loader.start();
    this.refreshStatus("streaming");
  }

  setTurnLoaderMessage(message: string): void {
    this.activeLoader?.setMessage(message);
  }

  stopTurnLoader(): void {
    const loader = this.activeLoader;
    this.activeLoader = undefined;
    const block = this.activeLoaderBlock;
    this.activeLoaderBlock = undefined;
    loader?.stop();
    if (this.activeTurn !== undefined) {
      this.activeTurn.loader = undefined;
      this.activeTurn.loaderBlock = undefined;
    }
    block?.remove();
    this.respondingState = false;
  }

  // --- input routing ---

  private routeInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (
      (matchesKey(data, Key.ctrl("t")) || data === "\x14") &&
      !this.setupFlow.isWaitingForInput() &&
      this.commandPaletteOverlay?.isFocused() !== true
    ) {
      this.toggleTranscriptFocus();
      return { consume: true };
    }
    // Drag selection and selection copy/clear work regardless of which pane holds
    // key focus, so they run before the focus-specific branches below.
    const mouse = parseClankieSgrMouse(data);
    if (mouse !== undefined && mouse.kind !== "wheel") {
      this.handleSelectionMouse(mouse);
      return { consume: true };
    }
    if (
      matchesKey(data, Key.ctrl("c")) &&
      (this.transcriptViewport.hasSelection() || this.chromeSelection.hasSelection())
    ) {
      if (this.transcriptViewport.hasSelection()) {
        void this.copyTranscriptSelection();
        this.transcriptViewport.clearSelection();
      } else {
        void this.copyChromeSelection();
        this.chromeSelection.clear();
      }
      this.tui.requestRender();
      return { consume: true };
    }
    if (
      matchesKey(data, Key.escape) &&
      (this.transcriptViewport.hasSelection() || this.chromeSelection.hasSelection())
    ) {
      this.transcriptViewport.clearSelection();
      this.chromeSelection.clear();
      this.tui.requestRender();
      return { consume: true };
    }
    if (this.transcriptViewport.focused) {
      if (matchesKey(data, Key.escape)) {
        this.tui.setFocus(this.editor);
        this.refreshStatusView();
        return { consume: true };
      }
      if (isTranscriptNavigationInput(data)) {
        this.transcriptViewport.handleInput(data);
        this.tui.requestRender();
        return { consume: true };
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("/")) || data === "\x1f") {
      if (this.setupFlow.isWaitingForInput()) return undefined;
      this.openCommandPalette();
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
      this.setupFlow.handleSubmit("/cancel");
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && this.handleActiveTurnEscape()) return { consume: true };
    const bashInput = this.handleBashModeInput(data);
    if (bashInput !== undefined) return bashInput;
    const commandInput = this.handleCommandTypeaheadInput(data);
    if (commandInput !== undefined) return commandInput;
    const transcriptInput = this.handleTranscriptViewportGlobalInput(data);
    if (transcriptInput !== undefined) return transcriptInput;
    if (mouse !== undefined) return { consume: true };
    return undefined;
  }

  private toggleTranscriptFocus(): void {
    if (this.transcriptViewport.focused) this.tui.setFocus(this.editor);
    else this.tui.setFocus(this.transcriptViewport);
    this.refreshStatusView();
    this.tui.requestRender();
  }

  private handleTranscriptViewportGlobalInput(data: string): { consume: true } | undefined {
    if (
      !shouldRouteClankieTranscriptGlobalInput(data, {
        commandPaletteFocused: this.commandPaletteOverlay?.isFocused() === true,
        editorAutocompleteOpen: this.editor.isShowingAutocomplete(),
        editorText: this.editor.getText(),
        setupWaiting: this.setupFlow.isWaitingForInput(),
        transcriptFocused: this.transcriptViewport.focused,
      })
    ) {
      return undefined;
    }
    if (!this.transcriptViewport.handleGlobalInput(data)) return undefined;
    this.tui.requestRender();
    return { consume: true };
  }

  // --- command typeahead + palette ---

  refreshCommandSurface(text: string): void {
    const disabled = this.setupFlow.isWaitingForInput() || this.bashMode;
    this.commandTypeaheadState = disabled
      ? undefined
      : clankieCommandTypeaheadFor(this.options.commands, text, this.commandTypeaheadState);
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

    if (listOpen && matchesKey(data, Key.up)) {
      this.setCommandTypeaheadState(moveClankieCommandTypeaheadSelection(state, -1));
      return { consume: true };
    }
    if (listOpen && matchesKey(data, Key.down)) {
      this.setCommandTypeaheadState(moveClankieCommandTypeaheadSelection(state, 1));
      return { consume: true };
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
    this.commandPaletteOverlay = this.showSelectableOverlay(workbench, {
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

  // --- overlays / selection ---

  showSelectableOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
    const selectable = new ClankieChromeSelectableComponent(component, "modal", this.chromeSelection);
    const entry: SelectableOverlayEntry = {
      component: selectable,
      hidden: false,
      ...(options === undefined ? {} : { options }),
    };
    this.selectableOverlays.push(entry);
    const handle = this.tui.showOverlay(selectable, options);
    let registered = true;
    const unregister = (): void => {
      if (!registered) return;
      registered = false;
      const index = this.selectableOverlays.indexOf(entry);
      if (index >= 0) this.selectableOverlays.splice(index, 1);
      this.chromeSelection.clearBand("modal");
      this.chromeSelectionActive = false;
    };
    return {
      hide: (): void => {
        unregister();
        handle.hide();
      },
      setHidden: (hidden: boolean): void => {
        entry.hidden = hidden;
        if (hidden) {
          this.chromeSelection.clearBand("modal");
          this.chromeSelectionActive = false;
        }
        handle.setHidden(hidden);
      },
      isHidden: (): boolean => handle.isHidden(),
      focus: (): void => {
        handle.focus();
      },
      unfocus: (options_): void => {
        handle.unfocus(options_);
      },
      isFocused: (): boolean => handle.isFocused(),
    };
  }

  private handleSelectionMouse(mouse: ClankieSgrMouseEvent): void {
    if (!isClankieLeftMouseButton(mouse)) return;
    if (mouse.kind === "press") {
      const modal = this.modalMouseTarget(mouse);
      if (modal !== null) {
        this.transcriptViewport.clearSelection();
        this.transcriptSelectionActive = false;
        this.transcriptSelectionDragged = false;
        this.transcriptClickTarget = undefined;
        this.chromeSelection.press("modal", modal.row, modal.col);
        this.chromeSelectionActive = true;
      } else {
        const transcript = this.transcriptMouseTarget(mouse);
        if (transcript.inside && transcript.col === this.transcriptViewport.scrollbarHitColumn()) {
          this.chromeSelection.clear();
          this.chromeSelectionActive = false;
          this.transcriptViewport.clearSelection();
          this.transcriptSelectionActive = false;
          this.transcriptScrollbarDragActive = true;
          this.transcriptViewport.scrollToTrackRow(transcript.row);
        } else if (transcript.inside) {
          this.chromeSelection.clear();
          this.chromeSelectionActive = false;
          this.transcriptViewport.selectionPress(transcript.row, transcript.col);
          this.transcriptSelectionActive = true;
          this.transcriptSelectionDragged = false;
          this.transcriptClickTarget = { col: transcript.col, row: transcript.row };
        } else {
          this.transcriptViewport.clearSelection();
          this.transcriptSelectionActive = false;
          this.transcriptSelectionDragged = false;
          this.transcriptClickTarget = undefined;
          const chrome = this.chromeMouseTarget(mouse);
          if (chrome !== null) {
            this.chromeSelection.press(chrome.band, chrome.row, chrome.col);
            this.chromeSelectionActive = true;
          } else {
            this.chromeSelection.clear();
            this.chromeSelectionActive = false;
          }
        }
      }
      this.tui.requestRender();
      return;
    }
    if (mouse.kind === "drag") {
      if (this.transcriptScrollbarDragActive) {
        this.transcriptViewport.scrollToTrackRow(this.transcriptMouseTarget(mouse).row);
        this.tui.requestRender();
        return;
      }
      if (this.transcriptSelectionActive) {
        this.transcriptSelectionDragged = true;
        const transcript = this.transcriptMouseTarget(mouse);
        this.transcriptViewport.selectionDrag(transcript.row, transcript.col);
        this.tui.requestRender();
        return;
      }
      if (this.chromeSelectionActive) {
        const modal = this.modalMouseTarget(mouse);
        if (modal !== null) {
          this.chromeSelection.drag("modal", modal.row, modal.col);
        } else {
          const chrome = this.chromeMouseTarget(mouse);
          if (chrome !== null) this.chromeSelection.drag(chrome.band, chrome.row, chrome.col);
        }
        this.tui.requestRender();
      }
      return;
    }
    // release
    if (this.transcriptScrollbarDragActive) {
      this.transcriptScrollbarDragActive = false;
      return;
    }
    if (this.transcriptSelectionActive) {
      this.transcriptSelectionActive = false;
      if (this.transcriptViewport.hasSelection()) {
        void this.copyTranscriptSelection();
      } else if (!this.transcriptSelectionDragged && this.transcriptClickTarget !== undefined) {
        const release = this.transcriptMouseTarget(mouse);
        if (
          !release.inside ||
          release.row !== this.transcriptClickTarget.row ||
          !this.transcriptViewport.toggleCollapsedAt(this.transcriptClickTarget.row)
        ) {
          this.transcriptViewport.clearSelection();
        }
      } else {
        this.transcriptViewport.clearSelection();
      }
      this.transcriptSelectionDragged = false;
      this.transcriptClickTarget = undefined;
      this.tui.requestRender();
      return;
    }
    if (this.chromeSelectionActive) {
      this.chromeSelectionActive = false;
      if (this.chromeSelection.hasSelection()) void this.copyChromeSelection();
      else this.chromeSelection.clear();
      this.tui.requestRender();
    }
  }

  private modalMouseTarget(mouse: ClankieSgrMouseEvent): ClankieOverlayMouseTarget | null {
    const terminalColumns = this.tui.terminal.columns;
    const terminalRows = this.tui.terminal.rows;
    for (let index = this.selectableOverlays.length - 1; index >= 0; index--) {
      const overlay = this.selectableOverlays[index];
      if (
        overlay === undefined ||
        overlay.hidden ||
        overlay.options?.visible?.(terminalColumns, terminalRows) === false
      )
        continue;
      const overlayOptions = overlay.options === undefined ? {} : { options: overlay.options };
      const frame = resolveClankieOverlayFrame({
        ...overlayOptions,
        overlayRows: 0,
        terminalColumns,
        terminalRows,
      });
      const overlayRows = overlay.component.render(frame.width).length;
      const target = resolveClankieOverlayMouseTarget({
        mouseCol: mouse.col,
        mouseRow: mouse.row,
        ...overlayOptions,
        overlayRows,
        terminalColumns,
        terminalRows,
      });
      if (target !== null) return target;
    }
    return null;
  }

  private chromeMouseTarget(
    mouse: ClankieSgrMouseEvent,
  ): ReturnType<typeof resolveClankieChromeMouseTargetFromBands> {
    const width = this.tui.terminal.columns;
    return resolveClankieChromeMouseTargetFromBands({
      bands: this.layoutBandRows(width),
      mouseCol: mouse.col,
      mouseRow: mouse.row,
      terminalRows: this.tui.terminal.rows,
    });
  }

  private transcriptMouseTarget(
    mouse: ClankieSgrMouseEvent,
  ): ReturnType<typeof resolveClankieTranscriptMouseTargetFromBands> {
    const width = this.tui.terminal.columns;
    return resolveClankieTranscriptMouseTargetFromBands({
      bands: this.layoutBandRows(width),
      mouseCol: mouse.col,
      mouseRow: mouse.row,
      terminalRows: this.tui.terminal.rows,
    });
  }

  private async copyTranscriptSelection(): Promise<void> {
    const text = this.transcriptViewport.getSelectedText();
    if (text.length === 0) return;
    try {
      await writeClankieClipboard(text, (chunk) => this.tui.terminal.write(chunk));
    } catch {
      return;
    }
  }

  private async copyChromeSelection(): Promise<void> {
    const text = this.chromeSelection.getSelectedText();
    if (text.length === 0) return;
    try {
      await writeClankieClipboard(text, (chunk) => this.tui.terminal.write(chunk));
    } catch {
      return;
    }
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
    // isResponding. A second plain prompt would collide with the active turn, so
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
    const command = this.options.commands.find(
      (candidate) => candidate.name === token || candidate.aliases.includes(token),
    );
    if (command === undefined) {
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
      this.insertMarkdown("**Notice**\n\nNo captain session is connected; prompts go nowhere yet.");
      return;
    }
    const controller = new AbortController();
    const userBlock = this.insertMarkdown(`**You**\n\n${prompt}`);
    const turn: ActivePromptTurn = { controller, prompt, promptRestoreEligible: true, userBlock };
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

    if (this.options.interruptMode === "detach") {
      turn.promptRestoreEligible = false;
      turn.loader?.setMessage("Detaching — captain continues...");
      this.refreshStatus("detaching — captain continues");
      turn.controller.abort();
      this.tui.requestRender();
      return true;
    }

    const canRestorePrompt = turn.promptRestoreEligible && this.editor.getText().trim().length === 0;
    if (canRestorePrompt) {
      turn.userBlock?.remove();
      turn.loader?.stop();
      turn.loaderBlock?.remove();
      if (this.activeLoader === turn.loader) this.activeLoader = undefined;
      if (this.activeLoaderBlock === turn.loaderBlock) this.activeLoaderBlock = undefined;
      this.editor.setText(turn.prompt);
      this.tui.setFocus(this.editor);
      this.refreshCommandSurface(turn.prompt);
      this.refreshStatus("interrupted - edit prompt");
    } else {
      turn.loader?.setMessage("Interrupting...");
      this.refreshStatus("interrupting");
    }
    turn.controller.abort();
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
    this.editor.borderColor = on ? this.theme.ansi.accent : this.theme.ansi.dim;
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
    const { ansi } = this.theme;
    const loader = new Loader(this.tui, ansi.accent, ansi.dim, `Running ${command}`, this.loaderIndicator());
    const loaderBlock = this.insertTranscript(loader, { collapsible: false, pin: "bottom" });
    loader.start();
    this.bashRunning += 1;
    this.refreshStatusView();
    this.tui.requestRender();
    try {
      const result = await runFaceBashCommand(command, {
        cwd: this.options.cwd,
        env: this.env,
        onSpawn: (child) => {
          this.activeBashChild = child;
        },
      });
      this.insertTranscript(new ClankieBashResultComponent(command, result, ansi));
    } finally {
      this.activeBashChild = undefined;
      this.bashRunning = Math.max(0, this.bashRunning - 1);
      loader.stop();
      loaderBlock.remove();
      this.refreshStatusView();
      this.tui.requestRender();
    }
  }

  // --- status text ---

  private formatStatusText(label: string): string {
    const { ansi } = this.theme;
    const primary = ansi.dim(label);
    const responseState =
      this.respondingState && label !== "ready" && label !== "streaming" ? "responding" : "";
    const setupState = this.setupFlow.isWaitingForInput() ? "setup input" : "";
    const focusState = this.transcriptViewport.focused ? "transcript nav" : "";
    const bashState = this.bashMode
      ? `${ansi.accent("shell")}${
          this.bashRunning > 0 ? ansi.dim(" running") : ansi.dim(` · ${displayHomePath(this.options.cwd)}`)
        }`
      : "";
    const extras = this.options.statusExtras?.() ?? [];
    const parts = [
      primary,
      ...(responseState.length === 0 ? [] : [ansi.dim(responseState)]),
      setupState,
      focusState,
      bashState,
      ...extras,
    ]
      .filter((part) => part.length > 0)
      .map((part) => (part.includes("\x1b[") ? part : ansi.dim(part)));
    if (!this.headerVisibleState) parts.unshift(ansi.bold(ansi.accent("clankie")));
    const statusLine = parts.join("  ·  ");
    if (
      this.layoutSettingsState.inputPlacement === "bottom" &&
      this.layoutSettingsState.statusPlacement === "above-input"
    )
      return `\n${statusLine}`;
    if (
      this.layoutSettingsState.inputPlacement === "top" &&
      this.layoutSettingsState.statusPlacement === "below-input"
    )
      return `${statusLine}\n`;
    return statusLine;
  }

  private insertDebugSnapshot(): void {
    const width = this.tui.terminal.columns;
    const bands = this.layoutBandRows(width)
      .map((band) => `${band.band}=${band.rows}`)
      .join(" ");
    this.insertMarkdown(
      [
        "**Notice**",
        "",
        `terminal ${width}x${this.tui.terminal.rows} · bands ${bands}`,
        `layout input=${this.layoutSettingsState.inputPlacement} status=${this.layoutSettingsState.statusPlacement} header=${this.headerVisibleState ? "on" : "off"}`,
        `spinner ${this.agentSpinner.name} @ ${this.agentSpinnerCycleRateMs}ms`,
      ].join("\n"),
    );
  }
}

function isTranscriptNavigationInput(data: string): boolean {
  return (
    matchesKey(data, Key.up) ||
    matchesKey(data, Key.down) ||
    matchesKey(data, Key.pageUp) ||
    matchesKey(data, Key.pageDown) ||
    matchesKey(data, Key.home) ||
    matchesKey(data, Key.end) ||
    matchesKey(data, Key.enter) ||
    matchesKey(data, Key.space) ||
    data === "\r" ||
    data === " "
  );
}

export type { InputPlacement, LayoutSettings, StatusPlacement };
