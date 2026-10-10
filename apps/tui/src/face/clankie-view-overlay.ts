/**
 * Live panel for one view (VUH-2035): the spec's panels over data the service
 * read just now, re-read every `refreshSeconds` by the follow loop outside the
 * component. Esc / Ctrl+C close.
 */
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { ViewRender } from "@clankie/protocol";
import { formatViewLines } from "../command/view.ts";
import type { ClankieCommandUiTheme } from "./clankie-command-ui.ts";
import { renderClankieOutline } from "./clankie-outline.ts";

export class ClankieViewOverlay implements Component, Focusable {
  focused = false;
  private render_: ViewRender | undefined;
  private notice: string | undefined;
  private readonly callbacks: { readonly onClose: () => void; readonly onRender: () => void };
  private readonly theme: ClankieCommandUiTheme;

  constructor(
    callbacks: { readonly onClose: () => void; readonly onRender: () => void },
    theme: ClankieCommandUiTheme,
  ) {
    this.callbacks = callbacks;
    this.theme = theme;
  }

  invalidate(): void {}

  setRender(render: ViewRender): void {
    this.render_ = render;
    this.notice = undefined;
    this.callbacks.onRender();
  }

  setNotice(message: string): void {
    this.notice = message;
    this.callbacks.onRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.callbacks.onClose();
  }

  render(width: number): string[] {
    const renderWidth = Math.max(24, width);
    const usable = Math.max(20, renderWidth - 4);
    const fit = (text: string) => truncateToWidth(text, usable);
    const cursor = this.focused ? CURSOR_MARKER : "";
    const body =
      this.render_ === undefined
        ? [this.theme.dim("reading…")]
        : formatViewLines(this.render_, { style: this.theme, now: Date.now() });
    const status =
      this.notice !== undefined
        ? this.theme.red(this.notice)
        : this.theme.dim(
            `live · every ${String(this.render_?.view.spec.refreshSeconds ?? 5)}s · esc close${cursor}`,
          );
    return renderClankieOutline([...body.map(fit), "", fit(status)], renderWidth, this.theme.dim);
  }
}
