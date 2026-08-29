/**
 * Overlay that tails retained Discord voice transcripts. Speaker · age, then
 * the utterance. A dim room header reprints only when the stay's body or
 * guild:channel changes. Esc / Ctrl+C close; the follow loop lives outside
 * the component so tests can drive snapshots without a TTY.
 */
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { formatVoiceTranscriptLines, type VoiceTranscriptSnapshot } from "../session/voice-transcripts.ts";
import type { ClankieCommandUiTheme } from "./clankie-command-ui.ts";
import { renderClankieOutline } from "./clankie-outline.ts";

export type VoiceTranscriptOverlayTheme = ClankieCommandUiTheme;

export type VoiceTranscriptOverlayCallbacks = {
  readonly onClose: () => void;
  readonly onRender: () => void;
};

const DISABLED_COPY = "Voice transcript logging is off. Enable it in /discord.";
const EMPTY_COPY = "Listening for retained speech…";

export class ClankieVoiceTranscriptOverlay implements Component, Focusable {
  focused = false;
  private readonly callbacks: VoiceTranscriptOverlayCallbacks;
  private readonly theme: VoiceTranscriptOverlayTheme;
  private snapshot: VoiceTranscriptSnapshot | undefined;
  private notice: string | undefined;
  private now = Date.now();

  constructor(callbacks: VoiceTranscriptOverlayCallbacks, theme: VoiceTranscriptOverlayTheme) {
    this.callbacks = callbacks;
    this.theme = theme;
  }

  invalidate(): void {}

  setSnapshot(snapshot: VoiceTranscriptSnapshot, now = Date.now()): void {
    this.snapshot = snapshot;
    this.now = now;
    this.notice = undefined;
    this.callbacks.onRender();
  }

  setNotice(message: string | undefined): void {
    this.notice = message;
    this.callbacks.onRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.callbacks.onClose();
    }
  }

  render(width: number): string[] {
    const renderWidth = Math.max(24, width);
    const usableWidth = Math.max(20, renderWidth - 4);
    const cursor = this.focused ? CURSOR_MARKER : "";
    const header = fit(
      `${this.theme.bold("Voice transcripts")}  ${this.theme.dim("newest first · esc close")}${cursor}`,
      usableWidth,
    );
    const status = fit(this.statusLine(), usableWidth);
    const body = this.bodyLines(usableWidth);
    return renderClankieOutline([header, status, "", ...body], renderWidth, this.theme.dim);
  }

  private statusLine(): string {
    if (this.notice !== undefined) return this.theme.red(this.notice);
    if (this.snapshot === undefined) return this.theme.dim("connecting…");
    if (!this.snapshot.enabled) return this.theme.yellow("logging disabled");
    const count = this.snapshot.entries.length;
    if (count === 0) return this.theme.dim("live · no speech yet");
    return this.theme.dim(`live · ${String(count)} line${count === 1 ? "" : "s"}`);
  }

  private bodyLines(width: number): string[] {
    if (this.snapshot === undefined) {
      return [this.theme.dim(fit("connecting…", width))];
    }
    if (!this.snapshot.enabled) {
      return wrapTextWithAnsi(this.theme.yellow(DISABLED_COPY), width).map((line) => fit(line, width));
    }
    if (this.snapshot.entries.length === 0) {
      return [this.theme.dim(fit(EMPTY_COPY, width))];
    }
    // Newest first so pi's top-clip on a short terminal keeps the live lines.
    const newestFirst = [...this.snapshot.entries].slice(-40).reverse();
    return formatVoiceTranscriptLines(newestFirst, {
      now: this.now,
      theme: this.theme,
      width,
      wrap: (text, wrapWidth) => wrapTextWithAnsi(text, wrapWidth),
    }).map((line) => fit(line, width));
  }
}

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(1, width));
}
