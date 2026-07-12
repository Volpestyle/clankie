import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectListTheme,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { renderClankieOutline } from "./clankie-outline.ts";

export type InteractivePromptOption = {
  readonly value: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly description?: string | undefined;
};

export type InteractiveTextPromptOptions = {
  readonly message: string;
  readonly defaultValue?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly error?: string | undefined;
  /** Masks the input and suppresses values from prompt chrome. */
  readonly sensitive?: boolean | undefined;
  readonly allowBack?: boolean | undefined;
  readonly onCancel: () => void;
  readonly onRender: () => void;
  readonly onSubmit: (value: string) => void;
};

export type InteractiveSelectPromptOptions = {
  readonly kind: "multi" | "single";
  readonly message: string;
  readonly options: readonly InteractivePromptOption[];
  readonly statusActions?: readonly InteractivePromptOption[] | undefined;
  readonly initialValue?: string | undefined;
  readonly initialValues?: readonly string[] | undefined;
  readonly currentValue?: string | undefined;
  readonly currentValues?: readonly string[] | undefined;
  readonly required?: boolean | undefined;
  readonly allowBack?: boolean | undefined;
  readonly theme: SelectListTheme;
  readonly onCancel: () => void;
  readonly onRender: () => void;
  readonly onSubmit: (values: readonly string[]) => void;
};

type IndexedOption = {
  readonly index: number;
  readonly option: InteractivePromptOption;
  readonly placement: "menu" | "status";
};

const MAX_VISIBLE_OPTIONS = 12;
const TITLE_WORD_OVERRIDES: Record<string, string> = {
  api: "API",
  asr: "ASR",
  dm: "DM",
  dms: "DMs",
  id: "ID",
  ids: "IDs",
  mcp: "MCP",
  openai: "OpenAI",
  tts: "TTS",
  xai: "xAI",
};

export class InteractiveTextPrompt implements Component, Focusable {
  private readonly input = new Input();
  private readonly options: InteractiveTextPromptOptions;

  private _focused = false;

  constructor(options: InteractiveTextPromptOptions) {
    this.options = options;
    this.input.setValue(options.defaultValue ?? "");
    this.input.onSubmit = (value) => {
      if (options.sensitive === true) this.input.setValue("");
      options.onSubmit(value);
    };
    this.input.onEscape = () => {
      if (options.sensitive === true) this.input.setValue("");
      options.onCancel();
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.options.onRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const inputLines =
      this.options.sensitive === true
        ? [
            truncateToWidth(
              `> ${this.focused ? CURSOR_MARKER : ""}${this.input.getValue() === "" ? "" : "••••••••"}`,
              contentWidth,
              "",
            ),
          ]
        : this.input.render(contentWidth);
    const lines = [
      ...promptHeader(
        this.options.sensitive === true ? "Secret" : "Input",
        this.options.message,
        contentWidth,
      ),
      ...(this.options.sensitive === true || this.options.defaultValue === undefined
        ? []
        : [dim(`Default: ${this.options.defaultValue}`)]),
      ...(this.options.sensitive === true || this.options.placeholder === undefined
        ? []
        : [dim(`Placeholder: ${this.options.placeholder}`)]),
      ...(this.options.error === undefined ? [] : [errorLine(this.options.error)]),
      "",
      ...inputLines,
      dim(this.options.allowBack === true ? "Enter accepts. Esc goes back." : "Enter accepts. Esc cancels."),
    ];
    return boxLines(lines, width);
  }
}

export class InteractiveSelectPrompt implements Component, Focusable {
  private readonly options: InteractiveSelectPromptOptions;
  private readonly selectedValues: Set<string>;
  private readonly currentValues: Set<string>;
  focused = false;
  private cursorIndex = 0;
  private filter = "";
  private error: string | undefined;

  constructor(options: InteractiveSelectPromptOptions) {
    this.options = options;
    this.selectedValues = new Set(options.kind === "multi" ? (options.initialValues ?? []) : []);
    this.currentValues = new Set(
      options.kind === "multi"
        ? (options.currentValues ?? [])
        : options.currentValue === undefined
          ? []
          : [options.currentValue],
    );
    const initialValue = options.initialValue;
    if (options.kind === "single" && initialValue !== undefined) {
      const index = this.allOptions().findIndex((item) => item.option.value === initialValue);
      if (index >= 0) this.cursorIndex = index;
    }
  }

  invalidate(): void {
    // Rendering is derived directly from current state.
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.options.onCancel();
      return;
    }
    if (this.options.allowBack === true && matchesKey(data, Key.left)) {
      this.options.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.right) || data === "\n" || data === "\r") {
      this.submit();
      return;
    }
    if (this.options.kind === "multi" && (matchesKey(data, Key.space) || data === " ")) {
      this.toggleCurrent();
      this.options.onRender();
      return;
    }
    if (this.options.kind === "multi" && (matchesKey(data, Key.ctrl("a")) || data === "\x01")) {
      this.toggleAllFiltered();
      this.error = undefined;
      this.options.onRender();
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.cursorIndex = 0;
      this.options.onRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.cursorIndex = Math.max(0, this.filteredOptions().length - 1);
      this.options.onRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveCursor(-1);
      this.options.onRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveCursor(1);
      this.options.onRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveCursor(-8);
      this.options.onRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveCursor(8);
      this.options.onRender();
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.filter = this.filter.slice(0, -1);
      this.cursorIndex = 0;
      this.error = undefined;
      this.options.onRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("u")) || data === "\x15") {
      this.filter = "";
      this.cursorIndex = 0;
      this.error = undefined;
      this.options.onRender();
      return;
    }
    const printable = decodeKittyPrintable(data) ?? printableInput(data);
    if (printable !== undefined) {
      this.filter += printable;
      this.cursorIndex = 0;
      this.error = undefined;
      this.options.onRender();
    }
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const filtered = this.filteredOptions();
    this.cursorIndex = clamp(this.cursorIndex, 0, Math.max(0, filtered.length - 1));
    const active = filtered[this.cursorIndex];
    const statusActions = filtered.filter((item) => item.placement === "status");
    const menuItems = filtered.filter((item) => item.placement === "menu");
    const visibleMenuItems = this.visibleMenuItems(menuItems, active);
    const labelWidth = optionLabelWidth(
      [...visibleMenuItems.items, ...statusActions],
      contentWidth,
      this.options.kind,
      this.currentValues,
    );
    const statusActionLines = statusActions.map((item) =>
      this.renderItem(item, item === active, contentWidth, labelWidth, "none"),
    );
    const lines = [
      ...promptHeader(
        selectPromptTitle(this.options.message, this.options.kind),
        this.options.message,
        contentWidth,
        statusActionLines,
      ),
      ...this.statusLines(filtered.length, this.allOptions().length, contentWidth),
      ...(this.error === undefined ? [] : [errorLine(this.error)]),
      "",
      ...this.renderMenuItems(
        visibleMenuItems,
        active,
        menuItems.length,
        statusActions.length > 0,
        contentWidth,
        labelWidth,
      ),
      ...this.renderCurrentDetail(filtered, contentWidth),
    ];
    return boxLines(lines, width);
  }

  private allOptions(): IndexedOption[] {
    return [
      ...this.options.options.map((option, index) => ({ index, option, placement: "menu" as const })),
      ...(this.options.statusActions ?? []).map((option, index) => ({
        index,
        option,
        placement: "status" as const,
      })),
    ];
  }

  private filteredOptions(): IndexedOption[] {
    const normalized = this.filter.trim().toLowerCase();
    const indexed = this.allOptions();
    if (normalized.length === 0) return indexed;
    return indexed.filter(({ option }) => optionSearchText(option).includes(normalized));
  }

  private visibleMenuItems(
    items: readonly IndexedOption[],
    active: IndexedOption | undefined,
  ): { readonly items: readonly IndexedOption[]; readonly startIndex: number } {
    if (items.length === 0) return { items, startIndex: 0 };
    const maxVisible = Math.min(MAX_VISIBLE_OPTIONS, items.length);
    const cursorMenuIndex = active?.placement === "menu" ? items.indexOf(active) : 0;
    const startIndex = clamp(
      cursorMenuIndex - Math.floor(maxVisible / 2),
      0,
      Math.max(0, items.length - maxVisible),
    );
    return { items: items.slice(startIndex, startIndex + maxVisible), startIndex };
  }

  private renderMenuItems(
    visible: { readonly items: readonly IndexedOption[]; readonly startIndex: number },
    active: IndexedOption | undefined,
    totalMenuItems: number,
    hasStatusActions: boolean,
    width: number,
    labelWidth: number,
  ): string[] {
    if (totalMenuItems === 0)
      return hasStatusActions ? [] : [this.options.theme.noMatch("  No options match this filter")];
    const rows = visible.items.map((item) => this.renderItem(item, item === active, width, labelWidth));
    if (totalMenuItems > visible.items.length) {
      rows.push(
        this.options.theme.scrollInfo(
          `  Showing ${visible.startIndex + 1}-${visible.startIndex + visible.items.length} of ${totalMenuItems}`,
        ),
      );
    }
    return rows;
  }

  private renderItem(
    item: IndexedOption,
    active: boolean,
    width: number,
    labelWidth: number,
    prefixMode: "normal" | "none" = "normal",
  ): string {
    const selected = this.selectedValues.has(item.option.value);
    const current = this.currentValues.has(item.option.value);
    const label = optionLabelText(item.option, this.options.kind, selected, current);
    const paddedLabel = padVisible(truncateToWidth(label, labelWidth, ""), labelWidth);
    const details = [item.option.hint, item.option.description]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(" - ");
    const prefix = prefixMode === "none" ? "" : active ? "> " : "  ";
    const available = Math.max(1, width - prefix.length);
    const detailGap = prefixMode === "none" ? "    " : "  ";
    const detailText = details.length === 0 ? "" : `${detailGap}${this.options.theme.description(details)}`;
    const row = truncateToWidth(`${paddedLabel}${detailText}`, available, "");
    if (!active) return `${prefix}${row}`;
    // Hovered row gets the accent color highlight plus bold; the trailing dim detail keeps its own style.
    return this.options.theme.selectedText(this.options.theme.selectedPrefix(`${prefix}${row}`));
  }

  private renderCurrentDetail(items: readonly IndexedOption[], width: number): string[] {
    const current = items[this.cursorIndex]?.option;
    if (current === undefined) return [];
    const details = [current.hint, current.description].filter(
      (part): part is string => part !== undefined && part.length > 0,
    );
    if (details.length === 0) return [];
    const inline = `${current.label}  ${details.join(" - ")}`;
    if (visibleWidth(inline) <= Math.max(1, width - 2)) return [];
    const wrapped = details.flatMap((detail) => wrapTextWithAnsi(detail, Math.max(1, width - 4)));
    return ["", ...wrapped.slice(0, 4).map((line) => dim(`  ${line}`))];
  }

  private statusLines(filteredCount: number, totalCount: number, width: number): string[] {
    const cursor = this.focused ? CURSOR_MARKER : "";
    const selected =
      this.options.kind === "multi" && this.selectedValues.size > 0
        ? `${this.selectedValues.size} selected`
        : undefined;
    const back = this.options.allowBack === true ? "← Back" : "Esc cancels";
    let line: string;
    if (this.filter.length > 0) {
      line = compactParts([
        `Showing ${filteredCount} of ${totalCount}`,
        selected,
        `filter "${this.filter}"${cursor}`,
        "Ctrl+U clears",
        back,
      ]);
      return wrapTextWithAnsi(line, width).map(dim);
    }
    const movement = "Up/down move";
    const action = this.options.kind === "multi" ? "Space toggles" : "Enter/→ chooses";
    const finish = this.options.kind === "multi" ? "Enter/→ saves" : undefined;
    line = compactParts([selected, movement, action, finish, `type to filter${cursor}`, back]);
    return wrapTextWithAnsi(line, width).map(dim);
  }

  private moveCursor(delta: number): void {
    const filteredLength = this.filteredOptions().length;
    if (filteredLength === 0) {
      this.cursorIndex = 0;
      return;
    }
    this.cursorIndex = (this.cursorIndex + delta + filteredLength) % filteredLength;
  }

  private toggleCurrent(): void {
    const current = this.currentOption();
    if (current === undefined) return;
    if (this.selectedValues.has(current.value)) this.selectedValues.delete(current.value);
    else this.selectedValues.add(current.value);
    this.error = undefined;
  }

  private toggleAllFiltered(): void {
    const values = this.filteredOptions().map(({ option }) => option.value);
    if (values.length === 0) return;
    const allSelected = values.every((value) => this.selectedValues.has(value));
    for (const value of values) {
      if (allSelected) this.selectedValues.delete(value);
      else this.selectedValues.add(value);
    }
  }

  private submit(): void {
    if (this.options.kind === "single") {
      const current = this.currentOption();
      if (current !== undefined) {
        this.options.onSubmit([current.value]);
        return;
      }
      if (this.options.required === true) {
        this.error = "A selection is required.";
        this.options.onRender();
        return;
      }
      this.options.onSubmit([]);
      return;
    }
    const values = [...this.selectedValues];
    if (values.length === 0 && this.options.required === true) {
      this.error = "Select at least one option.";
      this.options.onRender();
      return;
    }
    this.options.onSubmit(values);
  }

  private currentOption(): InteractivePromptOption | undefined {
    return this.filteredOptions()[this.cursorIndex]?.option;
  }
}

function promptHeader(
  title: string,
  message: string,
  width: number,
  statusActions: readonly string[] = [],
): string[] {
  return [
    bold(truncateToWidth(title, width, "")),
    "",
    ...wrapPromptMessage(messageWithoutDuplicateTitle(title, message), width, statusActions),
  ];
}

function messageWithoutDuplicateTitle(title: string, message: string): string {
  const lines = message.split("\n");
  const firstTextIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstTextIndex < 0) return message;
  if (normalizePromptHeaderLine(lines[firstTextIndex] ?? "") !== normalizePromptHeaderLine(title))
    return message;
  const next = [...lines.slice(0, firstTextIndex), ...lines.slice(firstTextIndex + 1)];
  if (next[firstTextIndex]?.trim().length === 0) next.splice(firstTextIndex, 1);
  return next.join("\n");
}

function normalizePromptHeaderLine(text: string): string {
  return (
    text
      // oxlint-disable-next-line no-control-regex -- intentionally strips ANSI escape sequences
      .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/gu, "")
      .replace(/[.?!:]+$/u, "")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase()
  );
}

function wrapPromptMessage(message: string, width: number, statusActions: readonly string[] = []): string[] {
  const lines: string[] = [];
  for (const raw of messageLinesWithStatusActions(message, statusActions)) {
    const wrapped = wrapTextWithAnsi(raw, width);
    lines.push(...(wrapped.length === 0 ? [""] : wrapped));
  }
  return lines;
}

function messageLinesWithStatusActions(message: string, statusActions: readonly string[]): string[] {
  if (statusActions.length === 0) return message.split("\n");
  const rawLines = message.split("\n");
  const insertionIndex = finalParagraphStart(rawLines);
  const before = trimTrailingBlankLines(rawLines.slice(0, insertionIndex));
  const after = rawLines.slice(insertionIndex);
  return [...before, ...statusActions, "", ...after];
}

function finalParagraphStart(lines: readonly string[]): number {
  let lastNonEmpty = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim().length !== 0) {
      lastNonEmpty = index;
      break;
    }
  }
  if (lastNonEmpty < 0) return lines.length;
  let start = lastNonEmpty;
  while (start > 0 && lines[start - 1]?.trim().length !== 0) start -= 1;
  return start;
}

function trimTrailingBlankLines(lines: readonly string[]): readonly string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.trim().length === 0) end -= 1;
  return lines.slice(0, end);
}

function boxLines(lines: readonly string[], width: number): string[] {
  return renderClankieOutline(lines, width, dim);
}

function optionSearchText(option: InteractivePromptOption): string {
  return [option.value, option.label, option.hint ?? "", option.description ?? ""].join(" ").toLowerCase();
}

function selectPromptTitle(message: string, kind: InteractiveSelectPromptOptions["kind"]): string {
  const candidate = selectPromptTitleCandidate(message);
  if (candidate === undefined) return kind === "multi" ? "Choose Options" : "Choose One";
  const normalized = candidate
    .replace(/^(choose|select|pick)\s+(which\s+|the\s+)?/iu, "")
    .replace(/^toggle\s+which\s+/iu, "")
    .replace(/\s+setting\s+to\s+change$/iu, " settings")
    .replace(/\s+to\s+(change|remove)$/iu, "")
    .replace(/\s+clankie\s+may\s+use\s+for\s+worker\s+panes$/iu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return kind === "multi" ? "Choose Options" : "Choose One";
  return titleCasePromptTitle(normalized);
}

function selectPromptTitleCandidate(message: string): string | undefined {
  const lines = message
    .split("\n")
    .map((line) => line.trim().replace(/[.?!]+$/u, ""))
    .filter((line) => line.length > 0);
  return lines.findLast((line) => /^(choose|select|pick|toggle)\b/iu.test(line)) ?? lines[0];
}

function titleCasePromptTitle(text: string): string {
  return text
    .split(/\s+/u)
    .map((word) => {
      const normalized = word.toLowerCase();
      const override = TITLE_WORD_OVERRIDES[normalized];
      if (override !== undefined) return override;
      if (word !== normalized) return word;
      return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
    })
    .join(" ");
}

function optionLabelWidth(
  items: readonly IndexedOption[],
  width: number,
  kind: InteractiveSelectPromptOptions["kind"],
  currentValues: ReadonlySet<string>,
): number {
  const labels = items.map((item) =>
    visibleWidth(optionLabelText(item.option, kind, false, currentValues.has(item.option.value))),
  );
  const longest = Math.max(0, ...labels);
  const detailColumnTarget = Math.max(16, Math.floor(width * 0.44));
  return clamp(longest, 0, Math.max(0, width - detailColumnTarget));
}

function optionLabelText(
  option: InteractivePromptOption,
  kind: InteractiveSelectPromptOptions["kind"],
  selected: boolean,
  current: boolean,
): string {
  const currentSuffix = current ? " (current)" : "";
  return kind === "multi"
    ? `${selected ? "[x]" : "[ ]"} ${option.label}${currentSuffix}`
    : `${option.label}${currentSuffix}`;
}

function padVisible(text: string, width: number): string {
  const padding = width - visibleWidth(text);
  return padding <= 0 ? text : `${text}${" ".repeat(padding)}`;
}

function compactParts(parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(" | ");
}

function printableInput(data: string): string | undefined {
  if (data.length === 0) return undefined;
  return [...data].every((char) => {
    const code = char.charCodeAt(0);
    return code >= 32 && code !== 127 && (code < 0x80 || code > 0x9f);
  })
    ? data
    : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

function dim(text: string): string {
  return `\x1b[2m${text}\x1b[22m`;
}

function errorLine(text: string): string {
  return `\x1b[31m${text}\x1b[39m`;
}
