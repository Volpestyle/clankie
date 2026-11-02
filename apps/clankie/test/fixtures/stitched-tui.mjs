// A full-screen app with a long scrollback that follows the mouse wheel and takes a
// moment to repaint, like a coding agent's TUI. herdr-core reads its history by
// scrolling it (stitching), which outlasts a short call budget (#243).
const total = 2000;
let offset = 0;
const draw = () => {
  const rows = process.stdout.rows || 24;
  const end = total - offset;
  let out = "\x1b[H\x1b[2J";
  for (let i = Math.max(0, end - rows); i < end; i++) out += `history line ${i}${i < end - 1 ? "\r\n" : ""}`;
  process.stdout.write(out);
};
process.stdout.write("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
draw();
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  for (const [, button] of data.toString("latin1").matchAll(/\x1b\[<(\d+);\d+;\d+[Mm]/gu)) {
    if (button === "64") offset = Math.min(total - 1, offset + 3);
    else if (button === "65") offset = Math.max(0, offset - 3);
    else continue;
    setTimeout(draw, 60);
  }
});
process.stdout.on("resize", draw);
setInterval(() => {}, 1000);
