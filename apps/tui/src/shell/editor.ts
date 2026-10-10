/**
 * Pi's editor with a caret at the start of the input line. The caret sits in
 * the editor's own left padding, so wrapping, the cursor and autocomplete keep
 * Pi's layout; it marks only the first visible line.
 */
import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const CARET_PADDING = 2;

export class ClankieEditor extends Editor {
  private readonly caret: () => string;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    options: Omit<EditorOptions, "paddingX"> & { readonly caret: () => string },
  ) {
    const { caret, ...editorOptions } = options;
    super(tui, theme, { ...editorOptions, paddingX: CARET_PADDING });
    this.caret = caret;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    // Row 0 is the top border; row 1 is the first input line, padded by Pi.
    const first = lines[1];
    if (first?.startsWith(" ".repeat(CARET_PADDING)) === true) {
      lines[1] = `${this.caret()} ${first.slice(CARET_PADDING)}`;
    }
    return lines;
  }
}
