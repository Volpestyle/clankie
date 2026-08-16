/**
 * Measures one transcript frame the way a keystroke pays for it: the face
 * re-renders the viewport on every `requestRender`, so this is the per-keypress
 * cost the operator feels as lag. Run against a realistic block count before and
 * after touching the render path.
 *
 *   node apps/tui/bench/transcript-render.ts [blockCounts...]
 */
import { ClankieTranscriptMarkdownBlock } from "../src/face/clankie-transcript-block.ts";
import { ClankieTranscriptViewport } from "../src/face/clankie-transcript-viewport.ts";
import {
  createClankieFaceAnsiTheme,
  createClankieFaceMarkdownTheme,
} from "../src/face/clankie-face-theme.ts";

const WIDTH = 120;
const VIEWPORT_ROWS = 40;
const FRAMES = 200;

const ansi = createClankieFaceAnsiTheme({ color: true, unicode: true });
const blockTheme = {
  bold: ansi.bold,
  cyan: ansi.cyan,
  dim: ansi.dim,
  green: ansi.green,
  loadingGlyph: () => "*",
  markdown: createClankieFaceMarkdownTheme(ansi),
  red: ansi.red,
  yellow: ansi.yellow,
};

// A turn as it actually lands in the transcript: a bolded title line the block
// parser splits off, then a markdown body with the inline styling that pushes
// truncateToWidth onto its grapheme-segmenter path.
function sampleTurn(index: number): string {
  return [
    `**Tool: bash - completed**`,
    "",
    `Ran \`pnpm --filter @clankie/tui test\` for turn ${index}.`,
    "",
    "- checked the *transcript* viewport window",
    "- confirmed `renderBlocks` walks every block",
    "- noted the scrollbar gutter reserves one column",
    "",
    "> Wrapping prose so the markdown renderer produces several wrapped lines per",
    "> block rather than one short line, which is what a real turn looks like.",
  ].join("\n");
}

function buildViewport(blocks: number): ClankieTranscriptViewport {
  const viewport = new ClankieTranscriptViewport(() => VIEWPORT_ROWS, ansi, {
    blockSpacing: 1,
    scrollbar: true,
    unicode: true,
  });
  for (let index = 0; index < blocks; index++) {
    viewport.addChild(new ClankieTranscriptMarkdownBlock(sampleTurn(index), blockTheme));
  }
  return viewport;
}

function measure(blocks: number): { ms: number; rows: number } {
  const viewport = buildViewport(blocks);
  viewport.render(WIDTH); // warm the markdown caches, as a live session would be
  const started = process.hrtime.bigint();
  for (let frame = 0; frame < FRAMES; frame++) viewport.render(WIDTH);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  return { ms: elapsed / FRAMES, rows: viewport.render(WIDTH).length };
}

const counts = process.argv.slice(2).map(Number).filter(Number.isFinite);
const blockCounts = counts.length > 0 ? counts : [10, 50, 100, 250, 500];

process.stdout.write(`transcript frame cost (width ${WIDTH}, viewport ${VIEWPORT_ROWS} rows)\n`);
for (const blocks of blockCounts) {
  const { ms, rows } = measure(blocks);
  const verdict = ms > 16 ? "  <- past one 60fps frame" : "";
  process.stdout.write(
    `  ${String(blocks).padStart(4)} blocks  ${ms.toFixed(2).padStart(8)} ms/frame  (${rows} rows out)${verdict}\n`,
  );
}
