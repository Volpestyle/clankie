/**
 * The guided-flow ("wizard") engine of the face: every configurator speaks this
 * small vocabulary — `begin`/`end`, `renderLine`/`renderOutput`/`setStatus`,
 * `readText`, `readSecret`, `readSelect`, `waitForInterrupt` — and the shell renders each
 * read as a centered modal overlay (InteractiveTextPrompt /
 * InteractiveSelectPrompt). Ported from v1 (clankie snapshot 04734df9,
 * scripts/clankie.ts createSetupFlow); the interface is deliberately
 * renderer-agnostic so a remote surface can serialize the same flows later.
 */
import type {
  OverlayHandle,
  OverlayOptions,
  SelectListTheme,
  TUI,
  Component,
  Editor,
} from "@earendil-works/pi-tui";
import {
  InteractiveSelectPrompt,
  InteractiveTextPrompt,
  type InteractivePromptOption,
} from "../face/clankie-interactive-flow.ts";

export type FlowLineTone = "error" | "info" | "success" | "warning";

export interface MenuOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly description?: string;
}

export type SetupFlow = {
  begin(title: string): void;
  end(options?: { readonly preserveDiagnostics?: boolean }): void;
  renderOutput(text: string): void;
  renderLine(text: string, tone?: FlowLineTone): void;
  setStatus(status: string | undefined): void;
  readText(options: {
    readonly message: string;
    readonly defaultValue?: string;
    readonly placeholder?: string;
    readonly allowBack?: boolean;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  readSecret(options: {
    readonly message: string;
    readonly allowBack?: boolean;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  readSelect(options: {
    readonly kind: "multi" | "single";
    readonly message: string;
    readonly options: readonly MenuOption[];
    readonly statusActions?: readonly MenuOption[];
    readonly initialValue?: string;
    readonly initialValues?: readonly string[];
    readonly currentValue?: string;
    readonly currentValues?: readonly string[];
    readonly required?: boolean;
    readonly allowBack?: boolean;
  }): Promise<string[] | undefined>;
  waitForInterrupt(): {
    readonly promise: Promise<void>;
    dispose(): void;
  };
};

export type SetupFlowController = SetupFlow & {
  cancelActivePrompt(reason?: string): void;
  handleSubmit(text: string): boolean;
  isWaitingForInput(): boolean;
};

/** Everything the flow engine needs from the shell that owns the screen. */
export interface SetupFlowContext {
  readonly tui: TUI;
  readonly editor: Editor;
  readonly selectListTheme: SelectListTheme;
  setStatus(message: string): void;
  refreshStatusView(): void;
  refreshCommandSurface(text: string): void;
  showSelectableOverlay(component: Component, options?: OverlayOptions): OverlayHandle;
}

export function setupOverlayOptions(anchor: "center" | "bottom-center"): OverlayOptions {
  return {
    anchor,
    margin: { bottom: 3, left: 2, right: 2, top: 2 },
    maxHeight: "70%",
    minWidth: 48,
    width: "88%",
  };
}

function toInteractivePromptOption(option: MenuOption): InteractivePromptOption {
  return {
    description: option.description,
    hint: option.hint,
    label: option.label,
    value: option.value,
  };
}

function firstMeaningfulLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (line === undefined) return undefined;
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

function titleCaseTone(tone: FlowLineTone): string {
  return `${tone.slice(0, 1).toUpperCase()}${tone.slice(1)}`;
}

export function createSetupFlow(context: SetupFlowContext): SetupFlowController {
  let cancelActivePrompt: (() => void) | undefined;
  const interruptResolvers = new Set<() => void>();

  function cancelPrompt(reason = "cancelled"): void {
    cancelActivePrompt?.();
    for (const resolve of interruptResolvers) resolve();
    interruptResolvers.clear();
    context.refreshStatusView();
    context.refreshCommandSurface(context.editor.getText());
    context.setStatus(reason);
  }

  function handleSubmit(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed !== "/cancel") return false;
    cancelPrompt();
    return true;
  }

  async function readTextOverlay(
    options: Parameters<SetupFlow["readText"]>[0] & { readonly sensitive?: boolean },
    error: string | undefined,
    defaultValue: string | undefined,
  ): Promise<string | undefined> {
    return await new Promise<string | undefined>((resolve) => {
      let settled = false;
      let handle: OverlayHandle | undefined;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        if (cancelActivePrompt === cancel) cancelActivePrompt = undefined;
        handle?.hide();
        context.tui.setFocus(context.editor);
        context.refreshStatusView();
        context.refreshCommandSurface(context.editor.getText());
        context.tui.requestRender();
        resolve(value);
      };
      const cancel = (): void => finish(undefined);
      cancelActivePrompt = cancel;
      context.refreshStatusView();
      context.refreshCommandSurface(context.editor.getText());
      const prompt = new InteractiveTextPrompt({
        allowBack: options.allowBack,
        defaultValue,
        error,
        message: options.message,
        onCancel: cancel,
        onRender: () => context.tui.requestRender(),
        onSubmit: (value) => finish(value),
        placeholder: options.placeholder,
        sensitive: options.sensitive,
      });
      handle = context.showSelectableOverlay(prompt, setupOverlayOptions("center"));
      handle.focus();
      context.tui.requestRender();
    });
  }

  async function readSelectOverlay(
    options: Parameters<SetupFlow["readSelect"]>[0],
  ): Promise<string[] | undefined> {
    return await new Promise<string[] | undefined>((resolve) => {
      let settled = false;
      let handle: OverlayHandle | undefined;
      const finish = (values: readonly string[] | undefined): void => {
        if (settled) return;
        settled = true;
        if (cancelActivePrompt === cancel) cancelActivePrompt = undefined;
        handle?.hide();
        context.tui.setFocus(context.editor);
        context.refreshStatusView();
        context.refreshCommandSurface(context.editor.getText());
        context.tui.requestRender();
        resolve(values === undefined ? undefined : [...values]);
      };
      const cancel = (): void => finish(undefined);
      cancelActivePrompt = cancel;
      context.refreshStatusView();
      context.refreshCommandSurface(context.editor.getText());
      const prompt = new InteractiveSelectPrompt({
        allowBack: options.allowBack,
        currentValue: options.currentValue,
        currentValues: options.currentValues,
        initialValue: options.initialValue,
        initialValues: options.initialValues,
        kind: options.kind,
        message: options.message,
        onCancel: cancel,
        onRender: () => context.tui.requestRender(),
        onSubmit: (values) => finish(values),
        options: options.options.map(toInteractivePromptOption),
        required: options.required,
        statusActions: options.statusActions?.map(toInteractivePromptOption),
        theme: context.selectListTheme,
      });
      handle = context.showSelectableOverlay(prompt, setupOverlayOptions("center"));
      handle.focus();
      context.tui.requestRender();
    });
  }

  return {
    begin(title: string): void {
      context.setStatus(title);
    },
    end(): void {
      context.setStatus("ready");
    },
    renderOutput(text: string): void {
      const summary = firstMeaningfulLine(text);
      if (summary !== undefined) context.setStatus(summary);
    },
    renderLine(text: string, tone: FlowLineTone = "info"): void {
      const summary = firstMeaningfulLine(text);
      if (summary !== undefined) context.setStatus(`${titleCaseTone(tone)}: ${summary}`);
    },
    setStatus(statusText: string | undefined): void {
      context.setStatus(statusText ?? "ready");
    },
    async readText(options): Promise<string | undefined> {
      let defaultValue = options.defaultValue;
      let error: string | undefined;
      for (;;) {
        const submitted = await readTextOverlay(options, error, defaultValue);
        if (submitted === undefined) return undefined;
        const value =
          submitted.trim().length === 0 && options.defaultValue !== undefined
            ? options.defaultValue
            : submitted;
        error = options.validate?.(value);
        if (error === undefined) return value;
        defaultValue = value;
      }
    },
    async readSecret(options): Promise<string | undefined> {
      let error: string | undefined;
      for (;;) {
        const submitted = await readTextOverlay({ ...options, sensitive: true }, error, undefined);
        if (submitted === undefined) return undefined;
        error = options.validate?.(submitted);
        if (error === undefined) return submitted;
      }
    },
    async readSelect(options): Promise<string[] | undefined> {
      return await readSelectOverlay(options);
    },
    waitForInterrupt() {
      let resolvePromise: (() => void) | undefined;
      const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
        interruptResolvers.add(resolve);
        context.refreshStatusView();
        context.refreshCommandSurface(context.editor.getText());
      });
      return {
        promise,
        dispose(): void {
          if (resolvePromise !== undefined) interruptResolvers.delete(resolvePromise);
          context.refreshStatusView();
          context.refreshCommandSurface(context.editor.getText());
        },
      };
    },
    cancelActivePrompt: cancelPrompt,
    handleSubmit,
    isWaitingForInput(): boolean {
      return cancelActivePrompt !== undefined || interruptResolvers.size > 0;
    },
  };
}
