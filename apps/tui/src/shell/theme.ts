/**
 * One place that detects terminal capabilities and derives every theme object
 * the face shell hands to pi-tui and the ported face components. Mirrors the
 * v1 face wiring (clankie snapshot 04734df9, scripts/clankie.ts).
 */
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";
import { detectBannerCapabilities, type BannerCapabilities } from "../face/clankie-banner.ts";
import {
  createClankieFaceAnsiTheme,
  createClankieFaceMarkdownTheme,
  type ClankieFaceAnsiTheme,
} from "../face/clankie-face-theme.ts";
import type { ClankieCommandUiTheme } from "../face/clankie-command-ui.ts";

export interface FaceThemeBundle {
  readonly capabilities: BannerCapabilities;
  readonly ansi: ClankieFaceAnsiTheme;
  readonly selectListTheme: SelectListTheme;
  readonly editorTheme: EditorTheme;
  readonly markdownTheme: MarkdownTheme;
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
    selectList: selectListTheme,
  };
  const markdownTheme = createClankieFaceMarkdownTheme(ansi);
  const commandUiTheme: ClankieCommandUiTheme = {
    bold: ansi.bold,
    cyan: ansi.cyan,
    dim: ansi.dim,
    green: ansi.green,
    red: ansi.red,
    selectedDescription: ansi.selectedDescription,
    yellow: ansi.yellow,
  };
  return { capabilities, ansi, selectListTheme, editorTheme, markdownTheme, commandUiTheme };
}
