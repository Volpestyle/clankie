/** Compare the same Pi read blocks drawn bare and as Clankie's one-line tool rows. */
import { performance } from "node:perf_hooks";
import { ProcessTerminal, TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { ClankieToolRow } from "../src/shell/tool-row.ts";
import { createClankieFaceAnsiTheme } from "../src/face/clankie-face-theme.ts";

initTheme("dark");
const ui = new TuiAltScreen(new ProcessTerminal());
const ansi = createClankieFaceAnsiTheme({ color: false, trueColor: false });
const counts = process.argv[2] === undefined ? [10, 100, 500] : [Number(process.argv[2])];
if (counts.some((count) => !Number.isSafeInteger(count) || count <= 0 || count > 10_000)) {
  throw new Error("Expected a block count from 1 to 10000");
}
function measure(blocks: readonly Component[]): { rows: number; milliseconds: number } {
  const rows = blocks.reduce((sum, block) => sum + block.render(100).length, 0);
  const start = performance.now();
  for (let frame = 0; frame < 100; frame++) for (const block of blocks) block.render(100);
  return { rows, milliseconds: Number(((performance.now() - start) / 100).toFixed(3)) };
}
for (const count of counts) {
  const plain: ToolExecutionComponent[] = [];
  const rows: ClankieToolRow[] = [];
  for (let i = 0; i < count; i++) {
    const args = { path: `src/file-${i}.ts` };
    const block = new ToolExecutionComponent("read", `call-${i}`, args, {}, undefined, ui, process.cwd());
    block.markExecutionStarted();
    block.setArgsComplete();
    block.updateResult({ content: [{ type: "text", text: "Read output\n".repeat(10) }], isError: false });
    plain.push(block);
    const row = new ClankieToolRow(block, "read", args, { ansi, unicode: true });
    row.complete(false, undefined);
    rows.push(row);
  }
  console.log(JSON.stringify({ blocks: count, plain: measure(plain), rows: measure(rows) }));
}
