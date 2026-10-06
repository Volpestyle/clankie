/** Compatibility exports; the Pokémon executor lives in its extension. */
export {
  overlayText,
  PLAY_STREAM_HEIGHT,
  PLAY_STREAM_WIDTH,
  type PlayExecutionLogger,
} from "@clankie/pokemon";
export { roomEvent } from "@clankie/game-extension";
export { resolvePlayMind, resolvePlayRuntimeRoots } from "./play-mind.ts";
