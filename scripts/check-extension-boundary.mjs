// Fails when the service's core gains an import of an extension (ADR 0328).
//
// Each file under apps/clankie/src belongs to the core unless a rule below
// names it as part of an extension. The core may not import an extension: an
// extension reaches the core through the ports it names, and the core reaches
// an extension only through what its projection adds; only the composition
// roots, apps/clankie/src/index.ts and the dormant body's dormant-body.ts,
// import extensions. The imports the core
// still has are listed in scripts/extension-boundary-baseline.json, which only
// shrinks as extensions move behind the contract.
//
// Usage: node scripts/check-extension-boundary.mjs [--update]
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const compositionRoots = new Set(["index.ts", "dormant-body.ts"]);
const source = join(root, "apps/clankie/src");
const baselinePath = join(root, "scripts/extension-boundary-baseline.json");

/** File paths relative to apps/clankie/src, and package names. First match wins. */
const EXTENSION_RULES = [
  // The fleet's agent personas (captain/personas.ts: each hire's name, role and
  // avatar) are part of hiring and the roster, so they stay core.
  [
    "persona",
    [
      /^discord-(?!voice|room-voice)/u,
      /^persona-/u,
      /^appearance-routes\.ts$/u,
      /^app\/discord-routes\.ts$/u,
      /^captain\/captain-discord-turns\.ts$/u,
      /^captain\/discord-/u,
      /^@clankie\/discord-presence-core(\/|$)/u,
      /^@clankie\/persona-images(\/|$)/u,
    ],
  ],
  [
    "voice",
    [
      /^voice-/u,
      /^composer-transcription\.ts$/u,
      /^discord-voice-presence\.ts$/u,
      /^discord-room-voice\.ts$/u,
      /^body-voice-stays\.ts$/u,
      /^app\/voice-/u,
      /^captain\/voice-/u,
      /^@clankie\/vox-client(\/|$)/u,
      /^@clankie\/play-voice(\/|$)/u,
    ],
  ],
  [
    "world",
    [
      /^activity-/u,
      /^play-/u,
      /^body-play-sessions\.ts$/u,
      /^stream-watch-observation\.ts$/u,
      /^world\//u,
      /^@clankie\/play(\/|$)/u,
      /^@clankie\/pokemon(\/|$)/u,
      /^@clankie\/rendered-surface-client(\/|$)/u,
    ],
  ],
  ["minecraft", [/^minecraft/u, /^@clankie\/minecraft(\/|$)/u]],
  ["tracker-linear", [/^linear-/u, /^app\/linear-routes\.ts$/u, /^captain\/conversations\/linear-/u]],
  [
    "relay",
    [
      /^relay-extension\.ts$/u,
      /^public-gateway-connector\.ts$/u,
      /^gateway-encryption\.ts$/u,
      /^body-doorway\.ts$/u,
    ],
  ],
  // Which harnesses can take computer work is part of hiring, so it stays core.
  ["computer", [/^computer-(?!use-harnesses\.ts$)/u, /^joined-computer\.ts$/u]],
  ["browser", [/^browser-/u]],
  ["media", [/^media-(generation|extension)\.ts$/u, /^skin-draft/u, /^tldraw-host\.ts$/u]],
];

const partOf = (path) => {
  for (const [id, rules] of EXTENSION_RULES) if (rules.some((rule) => rule.test(path))) return id;
  return "core";
};

const files = [];
(function walk(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith(".ts")) files.push(path);
  }
})(source);

const edges = new Set();
const lines = {};
for (const file of files) {
  const from = relative(source, file);
  const text = readFileSync(file, "utf8");
  const part = partOf(from);
  lines[part] = (lines[part] ?? 0) + text.split("\n").length;
  // The composition roots are the core files that wire extensions in.
  if (part !== "core" || compositionRoots.has(from)) continue;
  for (const match of text.matchAll(/(?:\bfrom|\bimport\()\s*"([^"]+)"/gu)) {
    const specifier = match[1];
    const target = specifier.startsWith(".")
      ? relative(source, resolve(dirname(file), specifier))
      : specifier;
    const extension = partOf(target);
    if (extension !== "core") edges.add(`${from} -> ${target} (${extension})`);
  }
}
const current = [...edges].sort();

if (process.argv.includes("--update")) {
  writeFileSync(baselinePath, `${JSON.stringify({ edges: current }, null, 2)}\n`);
  console.log(`Wrote ${current.length} core-to-extension imports to the baseline.`);
  process.exit(0);
}

const baseline = new Set(JSON.parse(readFileSync(baselinePath, "utf8")).edges);
const added = current.filter((edge) => !baseline.has(edge));
const gone = [...baseline].filter((edge) => !edges.has(edge));
if (added.length) {
  console.error("The core imports an extension it did not import before (ADR 0328):");
  for (const edge of added) console.error(`  ${edge}`);
  console.error(
    "Give the extension a host port or move the code into it. If the import only moved with code\n" +
      "from another core file, run `node scripts/check-extension-boundary.mjs --update`.",
  );
}
if (gone.length) {
  console.error("These core-to-extension imports are gone; take them out of the baseline:");
  for (const edge of gone) console.error(`  ${edge}`);
  console.error("Run `node scripts/check-extension-boundary.mjs --update`.");
}
if (added.length || gone.length) process.exit(1);
const parts = Object.entries(lines)
  .sort((a, b) => b[1] - a[1])
  .map(([part, count]) => `${part} ${count}`)
  .join(", ");
console.log(`The core has ${current.length} imports of extensions, none new. Lines: ${parts}.`);
