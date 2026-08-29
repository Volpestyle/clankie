/**
 * One place that detects terminal capabilities and derives the theme objects
 * for Clankie's own chrome (banner, typeahead, workbench, setup flow, command
 * results). The chat surface itself renders through pi's theme singleton
 * (`initTheme` in the shell), so pi components stay pixel-true to pi.
 */
import type { EditorTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { detectBannerCapabilities, type BannerCapabilities } from "../face/clankie-banner.ts";
import { createClankieFaceAnsiTheme, type ClankieFaceAnsiTheme } from "../face/clankie-face-theme.ts";
import type { ClankieCommandUiTheme } from "../face/clankie-command-ui.ts";

export interface FaceThemeBundle {
  readonly capabilities: BannerCapabilities;
  readonly ansi: ClankieFaceAnsiTheme;
  readonly selectListTheme: SelectListTheme;
  readonly editorTheme: EditorTheme;
  readonly commandUiTheme: ClankieCommandUiTheme;
}

export function createFaceThemeBundle(stream: NodeJS.WriteStream): FaceThemeBundle {
  const capabilities = detectBannerCapabilities(stream);
  const ansi = createClankieFaceAnsiTheme(capabilities);
  const selectListTheme: SelectListTheme = {
    description: ansi.dim,
    noMatch: ansi.dim,
    scrollInfo: ansi.dim,
    selectedPrefix: ansi.cyan,
    selectedText: ansi.bold,
  };
  const editorTheme: EditorTheme = {
    borderColor: ansi.dim,
    ghostText: ansi.dim,
    selectList: selectListTheme,
  };
  const commandUiTheme: ClankieCommandUiTheme = {
    bold: ansi.bold,
    cyan: ansi.cyan,
    dim: ansi.dim,
    green: ansi.green,
    red: ansi.red,
    selectedDescription: ansi.selectedDescription,
    yellow: ansi.yellow,
  };
  return { capabilities, ansi, selectListTheme, editorTheme, commandUiTheme };
}
