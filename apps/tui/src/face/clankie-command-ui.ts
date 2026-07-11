import {
  CURSOR_MARKER,
  Key,
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import {
  clankieCommandCompletion,
  describeClankieCommand,
  listClankieCommands,
  searchClankieCommands,
  type ClankieAutocompleteCommand,
  type ClankieCommandDetail,
  type ClankieCommandSearchItem,
} from "./clankie-autocomplete.ts";
import { renderClankieOutline } from "./clankie-outline.ts";

export type ClankieCommandUiTheme = {
  readonly bold: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
  readonly red: (text: string) => string;
  readonly selectedDescription?: (text: string) => string;
  readonly yellow: (text: string) => string;
};

export type ClankieCommandTypeaheadState = {
  readonly query: string;
  readonly matches: readonly ClankieAutocompleteCommand[];
  readonly selectedIndex: number;
  readonly dismissed: boolean;
};

type ParsedSlashText = {
  readonly commandToken: string;
  readonly argumentText: string;
  readonly hasArgumentText: boolean;
};

const TYPEAHEAD_VISIBLE_ROWS = 10;
const WORKBENCH_VISIBLE_ROWS = 10;

export function clankieCommandTypeaheadFor(
  commands: readonly ClankieAutocompleteCommand[],
  text: string,
  previous?: ClankieCommandTypeaheadState,
): ClankieCommandTypeaheadState | undefined {
  const query = commandTokenQuery(text);
  if (query === undefined) return undefined;

  const token = query.slice(1).toLowerCase();
  const matches = commands.filter((command) =>
    [command.name, ...command.aliases].some((name) => name.startsWith(token)),
  );
  const previousSelected = previous?.matches[previous.selectedIndex];
  const selectedIndex =
    previousSelected === undefined
      ? 0
      : Math.max(
          0,
          matches.findIndex((command) => command.name === previousSelected.name),
        );
  return {
    query,
    matches,
    selectedIndex: selectedIndex >= matches.length ? 0 : selectedIndex,
    dismissed: previous?.dismissed === true && previous.query === query,
  };
}

export function moveClankieCommandTypeaheadSelection(
  state: ClankieCommandTypeaheadState,
  delta: number,
): ClankieCommandTypeaheadState {
  if (state.matches.length === 0) return state;
  return {
    ...state,
    selectedIndex: wrapIndex(state.selectedIndex + delta, state.matches.length),
  };
}

export function dismissClankieCommandTypeahead(
  state: ClankieCommandTypeaheadState,
): ClankieCommandTypeaheadState {
  return state.dismissed ? state : { ...state, dismissed: true };
}

export function selectedClankieCommandTypeahead(
  state: ClankieCommandTypeaheadState | undefined,
): ClankieAutocompleteCommand | undefined {
  return state?.matches[state.selectedIndex];
}

export function isClankieCommandTypeaheadOpen(state: ClankieCommandTypeaheadState | undefined): boolean {
  return (
    state !== undefined &&
    !state.dismissed &&
    state.matches.length > 0 &&
    inlineClankieCommandHint(state) === undefined
  );
}

export function isExactClankieCommandTypeahead(state: ClankieCommandTypeaheadState | undefined): boolean {
  return state !== undefined && inlineClankieCommandHint(state) !== undefined;
}

export function inlineClankieCommandHint(state: ClankieCommandTypeaheadState): string | undefined {
  if (state.dismissed || state.matches.length !== 1) return undefined;
  const command = state.matches[0];
  if (command === undefined) return undefined;
  const token = state.query.slice(1).toLowerCase();
  if (![command.name, ...command.aliases].includes(token)) return undefined;
  return command.argumentHint ?? "";
}

export function clankieCommandFilterFromText(text: string): string {
  return commandTokenQuery(text)?.slice(1) ?? "";
}

export function renderClankieCommandTypeahead(
  state: ClankieCommandTypeaheadState,
  theme: ClankieCommandUiTheme,
  width: number,
  maxVisibleRows = TYPEAHEAD_VISIBLE_ROWS,
): string[] {
  if (state.dismissed) return [];
  const usableWidth = Math.max(1, width);
  if (maxVisibleRows <= 0) return [];
  const visibleRows = clampVisibleRows(maxVisibleRows, TYPEAHEAD_VISIBLE_ROWS);
  const contentRows = visibleRows > 1 ? visibleRows - 1 : visibleRows;
  const inlineHint = inlineClankieCommandHint(state);
  if (inlineHint !== undefined) {
    const command = state.matches[0];
    if (command === undefined) return [];
    const hint = inlineHint.length === 0 ? "Enter to run" : inlineHint;
    return withTypeaheadTopSpacing(
      [
        fit(
          `${theme.cyan(`> /${command.name}`)} ${theme.dim(hint)}  ${theme.dim(command.description)}`,
          usableWidth,
        ),
      ],
      visibleRows,
    );
  }
  if (state.matches.length === 0) {
    return withTypeaheadTopSpacing(
      [theme.dim(fit(`No command matches ${state.query}`, usableWidth))],
      visibleRows,
    );
  }

  const initialWindow = windowAroundSelection(state.matches, state.selectedIndex, contentRows);
  const invocationWidth = Math.min(
    Math.max(
      16,
      ...initialWindow.items.map((command) => visibleWidth(commandInvocationWithAliases(command))),
    ) + 2,
    Math.max(16, Math.floor(usableWidth * 0.58)),
  );
  const selectedCommand = state.matches[state.selectedIndex];
  const selectedDetailLines =
    selectedCommand === undefined ||
    !commandDescriptionIsTruncated(selectedCommand, usableWidth, invocationWidth)
      ? []
      : wrapSelectedCommandDescription(selectedCommand, theme, usableWidth);
  const commandRows = Math.max(1, contentRows - selectedDetailLines.length);
  const windowed = windowAroundSelection(state.matches, state.selectedIndex, commandRows);

  const rows = windowed.items.map((command, index) => {
    const absoluteIndex = windowed.start + index;
    const selected = absoluteIndex === state.selectedIndex;
    const pointer = selected ? "> " : "  ";
    const canonical = `/${command.name}`;
    const aliases =
      command.aliases.length === 0 ? "" : ` ${command.aliases.map((alias) => `(/${alias})`).join(" ")}`;
    const commandText = selected ? theme.cyan(`${pointer}${canonical}`) : `${pointer}${canonical}`;
    const left = padVisible(fit(`${commandText}${theme.dim(aliases)}`, invocationWidth), invocationWidth);
    const description = selected
      ? (theme.selectedDescription ?? theme.dim)(command.description)
      : theme.dim(command.description);
    return fit(`${left}${description}`, usableWidth);
  });
  return withTypeaheadTopSpacing([...selectedDetailLines, ...rows], visibleRows);
}

export type ClankieCommandTypeaheadPanelOptions = {
  readonly maxVisibleRows?: () => number;
};

export class ClankieCommandTypeaheadPanel implements Component {
  private readonly commands: readonly ClankieAutocompleteCommand[];
  private readonly maxVisibleRows: () => number;
  private readonly theme: ClankieCommandUiTheme;
  private state: ClankieCommandTypeaheadState | undefined;
  private text = "";
  private disabled = false;

  constructor(
    commands: readonly ClankieAutocompleteCommand[],
    theme: ClankieCommandUiTheme,
    options: ClankieCommandTypeaheadPanelOptions = {},
  ) {
    this.commands = commands;
    this.maxVisibleRows = options.maxVisibleRows ?? (() => TYPEAHEAD_VISIBLE_ROWS);
    this.theme = theme;
  }

  setText(text: string, state: ClankieCommandTypeaheadState | undefined, disabled = false): void {
    this.text = text;
    this.state = state;
    this.disabled = disabled;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.disabled) return [];
    const maxVisibleRows = this.maxVisibleRows();
    if (this.state !== undefined)
      return renderClankieCommandTypeahead(this.state, this.theme, width, maxVisibleRows);
    return renderArgumentDetail(this.commands, this.text, this.theme, width, maxVisibleRows);
  }
}

export type ClankieCommandWorkbenchCallbacks = {
  readonly onCancel: () => void;
  readonly onRender: () => void;
  readonly onSubmit: (text: string) => void;
};

export class ClankieCommandWorkbench implements Component, Focusable {
  focused = false;
  private readonly commands: readonly ClankieAutocompleteCommand[];
  private readonly callbacks: ClankieCommandWorkbenchCallbacks;
  private readonly theme: ClankieCommandUiTheme;
  private filter: string;
  private items: ClankieCommandSearchItem[] = [];
  private selectedIndex = 0;

  constructor(
    commands: readonly ClankieAutocompleteCommand[],
    callbacks: ClankieCommandWorkbenchCallbacks,
    theme: ClankieCommandUiTheme,
    initialFilter = "",
  ) {
    this.commands = commands;
    this.callbacks = callbacks;
    this.theme = theme;
    this.filter = normalizeWorkbenchFilter(initialFilter);
    this.refreshItems();
  }

  invalidate(): void {}

  getFilter(): string {
    return this.filter;
  }

  getSelectedCommand(): ClankieAutocompleteCommand | undefined {
    return this.items[this.selectedIndex]?.command;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(24, width);
    const usableWidth = Math.max(20, renderWidth - 4);
    const header = fit(this.theme.bold("Command workbench"), usableWidth);
    const cursor = this.focused ? CURSOR_MARKER : "";
    const filterLine = fit(
      `${this.theme.dim("filter")} /${this.filter}${cursor}  ${this.theme.dim("type to search names, aliases, descriptions")}`,
      usableWidth,
    );
    const footer = fit(
      this.theme.dim("up/down select  enter insert  tab example  ctrl-u clear  esc close"),
      usableWidth,
    );
    const list = this.renderCommandRows(usableWidth);
    const detail = this.renderSelectedDetail(usableWidth);
    const body =
      usableWidth >= 84 ? this.renderWideBody(list, detail, usableWidth) : [...list, "", ...detail];
    return renderClankieOutline([header, filterLine, "", ...body, "", footer], renderWidth, this.theme.dim);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.callbacks.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      this.submitCompletion(false);
      return;
    }
    if (matchesKey(data, Key.tab) || data === "\t") {
      this.submitCompletion(true);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveSelection(-WORKBENCH_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveSelection(WORKBENCH_VISIBLE_ROWS);
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.setFilter("");
      return;
    }
    if (matchesKey(data, Key.backspace) || data === "\x7f") {
      this.setFilter(this.filter.slice(0, -1));
      return;
    }

    const printable = decodeKittyPrintable(data) ?? printableAscii(data);
    if (printable === undefined) return;
    if (printable === "/" && this.filter.length === 0) return;
    this.setFilter(this.filter + printable);
  }

  private setFilter(filter: string): void {
    this.filter = normalizeWorkbenchFilter(filter);
    this.refreshItems();
    this.callbacks.onRender();
  }

  private refreshItems(): void {
    this.items =
      this.filter.trim().length === 0
        ? listClankieCommands(this.commands)
        : searchClankieCommands(this.commands, this.filter);
    if (this.items.length === 0) {
      this.selectedIndex = 0;
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, this.items.length - 1);
  }

  private moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    this.selectedIndex = wrapIndex(this.selectedIndex + delta, this.items.length);
    this.callbacks.onRender();
  }

  private submitCompletion(useExample: boolean): void {
    const command = this.getSelectedCommand();
    if (command === undefined) return;
    const detail = describeClankieCommand(command);
    const text = useExample
      ? (detail.examples[0] ?? clankieCommandCompletion(command))
      : clankieCommandCompletion(command);
    this.callbacks.onSubmit(text);
  }

  private renderCommandRows(width: number): string[] {
    if (this.items.length === 0) return [this.theme.dim(fit("No commands match the current filter.", width))];
    const windowed = windowAroundSelection(this.items, this.selectedIndex, WORKBENCH_VISIBLE_ROWS);
    return windowed.items.map((item, index) => {
      const selected = windowed.start + index === this.selectedIndex;
      const pointer = selected ? "> " : "  ";
      const left = selected
        ? this.theme.cyan(`${pointer}${item.invocation}`)
        : `${pointer}${item.invocation}`;
      const aliasText = item.aliasesText.length === 0 ? "" : ` ${this.theme.dim(item.aliasesText)}`;
      const row = `${left}${aliasText} ${this.theme.dim(item.category)}`;
      return fit(row, width);
    });
  }

  private renderSelectedDetail(width: number): string[] {
    const command = this.getSelectedCommand();
    if (command === undefined) return [this.theme.dim(fit("No command selected.", width))];
    const detail = describeClankieCommand(command);
    return renderCommandDetail(detail, this.theme, width, true);
  }

  private renderWideBody(list: string[], detail: string[], width: number): string[] {
    const leftWidth = clamp(Math.floor(width * 0.45), 34, 54);
    const divider = this.theme.dim(" | ");
    const rightWidth = Math.max(20, width - leftWidth - 3);
    const rows = Math.max(list.length, detail.length);
    const result: string[] = [];
    for (let index = 0; index < rows; index += 1) {
      const left = padVisible(fit(list[index] ?? "", leftWidth), leftWidth);
      const right = fit(detail[index] ?? "", rightWidth);
      result.push(fit(`${left}${divider}${right}`, width));
    }
    return result;
  }
}

function renderArgumentDetail(
  commands: readonly ClankieAutocompleteCommand[],
  text: string,
  theme: ClankieCommandUiTheme,
  width: number,
  maxVisibleRows = 4,
): string[] {
  if (maxVisibleRows <= 0) return [];
  const parsed = parseSlashText(text);
  if (parsed === undefined || !parsed.hasArgumentText) return [];
  const command = findCommand(commands, parsed.commandToken);
  if (command === undefined) return [theme.dim(fit(`Unknown command "/${parsed.commandToken}".`, width))];
  const detail = describeClankieCommand(command, parsed.argumentText);
  return renderCommandDetail(detail, theme, width, false).slice(0, clampVisibleRows(maxVisibleRows, 4));
}

function renderCommandDetail(
  detail: ClankieCommandDetail,
  theme: ClankieCommandUiTheme,
  width: number,
  includeCategory: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(fit(`${theme.cyan(detail.invocation)} ${theme.dim(detail.description)}`, width));
  if (includeCategory) lines.push(fit(`${theme.dim("category")} ${detail.category}`, width));
  if (detail.aliases.length > 0) {
    lines.push(
      fit(`${theme.dim("aliases")} ${detail.aliases.map((alias) => `/${alias}`).join(", ")}`, width),
    );
  }
  if (detail.warning !== undefined) lines.push(fit(theme.red(`warning: ${detail.warning}`), width));
  if (detail.validArgs.length > 0) {
    const args = detail.validArgs
      .slice(0, 8)
      .map((item) => item.label)
      .join("  ");
    lines.push(fit(`${theme.dim("next")} ${args}`, width));
  }
  if (detail.examples.length > 0) {
    lines.push(
      ...wrapDetailLine(`${theme.dim("examples")} ${detail.examples.slice(0, 3).join("  ")}`, width),
    );
  }
  return lines;
}

function wrapDetailLine(line: string, width: number): string[] {
  return wrapTextWithAnsi(line, width)
    .slice(0, 2)
    .map((wrapped) => fit(wrapped, width));
}

function parseSlashText(text: string): ParsedSlashText | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) return undefined;
  const withoutSlash = trimmed.slice(1);
  const match = /^(\S*)(\s+([\s\S]*))?$/u.exec(withoutSlash);
  if (match === null || match[1] === undefined || match[1].length === 0) return undefined;
  return {
    commandToken: match[1].toLowerCase(),
    argumentText: match[3] ?? "",
    hasArgumentText: match[2] !== undefined,
  };
}

function commandTokenQuery(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/") || trimmed.includes("\n")) return undefined;
  if (/\s/u.test(trimmed.slice(1))) return undefined;
  return trimmed;
}

function findCommand(
  commands: readonly ClankieAutocompleteCommand[],
  token: string,
): ClankieAutocompleteCommand | undefined {
  return commands.find((command) => command.name === token || command.aliases.includes(token));
}

function commandInvocationWithAliases(command: ClankieAutocompleteCommand): string {
  const aliases =
    command.aliases.length === 0 ? "" : ` ${command.aliases.map((alias) => `(/${alias})`).join(" ")}`;
  return `/${command.name}${aliases}`;
}

function commandDescriptionIsTruncated(
  command: ClankieAutocompleteCommand,
  width: number,
  invocationWidth: number,
): boolean {
  return visibleWidth(command.description) > Math.max(0, width - invocationWidth);
}

function wrapSelectedCommandDescription(
  command: ClankieAutocompleteCommand,
  theme: ClankieCommandUiTheme,
  width: number,
): string[] {
  return wrapTextWithAnsi(theme.yellow(command.description), Math.max(1, width)).map((line) =>
    fit(line, width),
  );
}

function withTypeaheadTopSpacing(rows: readonly string[], visibleRows: number): string[] {
  if (rows.length === 0) return [];
  if (visibleRows <= 1) return rows.slice(0, visibleRows);
  return ["", ...rows].slice(0, visibleRows);
}

function normalizeWorkbenchFilter(filter: string): string {
  return filter.trimStart().replace(/^\//u, "");
}

function printableAscii(data: string): string | undefined {
  return data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined;
}

function windowAroundSelection<T>(
  items: readonly T[],
  selectedIndex: number,
  maxVisible: number,
): { start: number; items: readonly T[] } {
  const visible = Math.min(items.length, maxVisible);
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(visible / 2), items.length - visible));
  return { start, items: items.slice(start, start + visible) };
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width));
}

function clampVisibleRows(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return clamp(Math.floor(value), 1, fallback);
}

function padVisible(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
