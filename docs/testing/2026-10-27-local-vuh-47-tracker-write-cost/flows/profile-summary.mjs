// Self and total CPU time by function from a V8 .cpuprofile (LOCAL-VUH-47).
//   node profile-summary.mjs PROFILE [SKIP_FUNCTIONS]  -- SKIP_FUNCTIONS drops samples whose stack has any of them (comma-separated)
import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = (n) =>
  `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
const self = new Map(),
  total = new Map();
const dt = p.timeDeltas;
const skip = process.argv[3]; // comma-separated function names whose samples are dropped
for (let i = 0; i < p.samples.length; i++) {
  const d = dt[i] / 1000;
  let id = p.samples[i];
  const stack = [];
  while (id !== undefined) {
    stack.push(byId.get(id));
    id = parent.get(id);
  }
  if (skip && stack.some((n) => skip.split(",").includes(n.callFrame.functionName))) continue;
  const leaf = name(stack[0]);
  self.set(leaf, (self.get(leaf) ?? 0) + d);
  for (const k of new Set(stack.map(name))) total.set(k, (total.get(k) ?? 0) + d);
}
const top = (m, n) =>
  [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${v.toFixed(1).padStart(8)} ms  ${k}`)
    .join("\n");
console.log("== self\n" + top(self, 35) + "\n== total\n" + top(total, 60));
