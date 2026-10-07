/**
 * The blank page the TUI opens on. Restored history sits above a quiet hint;
 * new blocks fill the page below it top-down, and blank rows after the
 * transcript hold the hint at the top of the screen until the page is full.
 * Scrolled back, the hint reads as the divider between what was already said
 * and this session.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export class ClankieFreshPage implements Component {
  private readonly dim: (text: string) => string;
  private readonly viewportHeight: () => number;
  private readonly after: () => readonly Component[] | undefined;
  /** Off while the transcript is written to scrollback, where blank rows are noise. */
  padded = true;
  /** Goes after the transcript; renders the rows that keep the hint at the top. */
  readonly tail: Component = {
    invalidate: () => {},
    render: (width) => Array<string>(this.paddingRows(width)).fill(""),
  };

  constructor(options: {
    readonly dim: (text: string) => string;
    readonly viewportHeight: () => number;
    /** The transcript blocks below the hint, in order; undefined once the hint left the transcript. */
    readonly after: () => readonly Component[] | undefined;
  }) {
    this.dim = options.dim;
    this.viewportHeight = options.viewportHeight;
    this.after = options.after;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const label = " ↑ scroll up for earlier messages ";
    const side = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
    return [this.dim(truncateToWidth(`${"─".repeat(side)}${label}${"─".repeat(side)}`, width, ""))];
  }

  private paddingRows(width: number): number {
    const after = this.after();
    if (!this.padded || after === undefined) return 0;
    const room = this.viewportHeight() - 1;
    let below = 0;
    for (const block of after) {
      below += block.render(width).length;
      if (below >= room) return 0;
    }
    return Math.max(0, room - below);
  }
}
