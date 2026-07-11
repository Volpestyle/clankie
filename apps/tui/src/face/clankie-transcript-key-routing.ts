import {
  isClankieTranscriptMouseScrollInput,
  isClankieTranscriptPageScrollInput,
} from "./clankie-transcript-viewport.ts";

export type ClankieTranscriptGlobalInputState = {
  readonly commandPaletteFocused: boolean;
  readonly editorAutocompleteOpen: boolean;
  readonly editorText: string;
  readonly setupWaiting: boolean;
  readonly transcriptFocused: boolean;
};

export function shouldRouteClankieTranscriptGlobalInput(
  data: string,
  state: ClankieTranscriptGlobalInputState,
): boolean {
  if (state.setupWaiting || state.commandPaletteFocused) return false;
  if (state.transcriptFocused || state.editorAutocompleteOpen) return false;
  if (state.editorText.length === 0) return true;
  return isClankieTranscriptPageScrollInput(data) || isClankieTranscriptMouseScrollInput(data);
}
