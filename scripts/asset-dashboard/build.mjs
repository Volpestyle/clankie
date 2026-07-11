// Art-asset dashboard — dependency-free (node:fs, node:path, node:http).
//
// Scans assets/ for PNG/GIF renders, embeds every image as a data URI, parses
// the ATLAS_FRAMES block of assets/garden-atlas/atlas.gen.ts, and injects one
// JSON manifest into template.html to emit a single self-contained HTML page:
// palette swatches, the four character variants with live idle GIFs, the
// per-tag animation renders (GIF + frame strip), props and scene, an atlas
// explorer with every frame cut from its manifest coordinates, and the
// .aseprite source inventory.
//
// Animation renders come from assets/garden/review/, which is untracked and
// transient; when absent, the dashboard is built without that section and
// shows the regeneration command (python3 assets/garden/tools/render_review.py).
//
// Snapshot build:  node scripts/asset-dashboard/build.mjs [out.html]
//                  (pnpm assets:dashboard; default artifacts/asset-dashboard.html, gitignored)
// Live mode:       node scripts/asset-dashboard/build.mjs --serve [--port 4173]
//                  (pnpm assets:dashboard:watch) — serves the dashboard locally,
//                  watches assets/ + template.html, rebuilds on change, and
//                  auto-reloads open tabs over server-sent events.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ASSETS = path.join(ROOT, "assets");
const GARDEN = path.join(ASSETS, "garden");
const REVIEW = path.join(GARDEN, "review");
const ATLAS_DIR = path.join(ASSETS, "garden-atlas");
const TEMPLATE = path.join(HERE, "template.html");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function imageDims(buf, file) {
  if (buf.subarray(0, 8).equals(PNG_SIG)) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.subarray(0, 3).toString("latin1") === "GIF") {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  throw new Error(`unsupported image format: ${file}`);
}

function img(file) {
  const buf = fs.readFileSync(file);
  const { w, h } = imageDims(buf, file);
  const mime = file.endsWith(".gif") ? "image/gif" : "image/png";
  return {
    uri: `data:${mime};base64,${buf.toString("base64")}`,
    w,
    h,
    bytes: buf.length,
    name: path.basename(file),
  };
}

// ---- palette (mirrors assets/garden/README.md) ----
const PALETTE = {
  base: [
    { name: "face", hex: "#f2e5c8" },
    { name: "outline", hex: "#503b2c" },
    { name: "bezel/stem", hex: "#806440" },
    { name: "body lt", hex: "#dfddb6" },
    { name: "body dk", hex: "#b2ae7e" },
    { name: "eyes", hex: "#262f3a" },
    { name: "cheeks", hex: "#f3b2a4" },
    { name: "cloud lt", hex: "#e8ece4" },
    { name: "cloud dk", hex: "#b9c0b4" },
    { name: "night bg", hex: "#242a2e" },
  ],
  variants: [
    { name: "green", light: "#c6d668", dark: "#7d8f41" },
    { name: "teal", light: "#63d0bd", dark: "#34988c" },
    { name: "amber", light: "#f0b24a", dark: "#c47a2c" },
    { name: "purple", light: "#b79ce2", dark: "#7d5cb0" },
  ],
};

// ---- animation frame counts + notes (mirror assets/garden/README.md) ----
const ANIM_META = [
  ["idle", 4, "long holds, a rare 1px crown sway, snappy blink"],
  ["walk", 4, "contact/passing cycle; crown lags on the passing frames"],
  ["walk-side", 4, "side walk, authored facing right"],
  ["walk-side-mirror", 4, "runtime left-facing mirror check"],
  ["walk-back", 4, "back walk, same counts/timing as front"],
  ["work", 4, "dig: wind-up, fast swing, impact (squash + dust), recover"],
  ["carry", 4, "frond hugged to the chest, hands wrapped over it; heave — lift, settle"],
  ["carry-side", 4, "side carry, authored facing right"],
  ["carry-side-mirror", 4, "runtime left-facing mirror check"],
  ["carry-back", 4, "back carry, same counts/timing as front"],
  ["blocked", 2, "hands up, worried; eyes glance sideways on beat two"],
  ["sleep", 4, "soft half-mast crown, slow 3-phase breath"],
  ["wilt", 2, "stem hooked over, leaves slumped down one side; slow sag — dying"],
  ["poof", 3, "dust-cloud disappearance"],
];

function collectData() {
  const atlasTs = fs.readFileSync(path.join(ATLAS_DIR, "atlas.gen.ts"), "utf8");
  const framesBlock = atlasTs.split("ATLAS_FRAMES")[1].split("};")[0];
  const frames = [...framesBlock.matchAll(/(\w+): \{ x: (\d+), y: (\d+), w: (\d+), h: (\d+) \}/g)].map(
    (m) => ({
      name: m[1],
      x: Number(m[2]),
      y: Number(m[3]),
      w: Number(m[4]),
      h: Number(m[5]),
    }),
  );

  const characters = PALETTE.variants.map((v) => ({
    name: `clankie-${v.name}`,
    chip: v,
    gif: img(path.join(GARDEN, `clankie-${v.name}.gif`)),
    png: img(path.join(GARDEN, `clankie-${v.name}.png`)),
    srcBytes: fs.statSync(path.join(GARDEN, `clankie-${v.name}.aseprite`)).size,
    frames: 43,
  }));

  const anims = ANIM_META.flatMap(([tag, frameCount, desc]) => {
    const gif = path.join(REVIEW, `${tag}.gif`);
    const strip = path.join(REVIEW, `${tag}-strip.png`);
    if (!fs.existsSync(gif) || !fs.existsSync(strip)) return [];
    return [
      { tag, frames: frameCount, desc, mirror: tag.endsWith("-mirror"), gif: img(gif), strip: img(strip) },
    ];
  });

  const props = ["mushroom", "grass", "rocks", "sprig"].map((n) => img(path.join(GARDEN, `prop-${n}.png`)));
  const scenes = [
    { ...img(path.join(GARDEN, "garden-scene.png")), note: "composed demo scene, 3 layers, native 160×90" },
  ];

  const atlas = { ...img(path.join(ATLAS_DIR, "leafguy-atlas.png")), frames };
  const sheets = [{ ...img(path.join(ATLAS_DIR, "contact-sheet.png")), note: "garden-atlas contact sheet" }];
  const reviewSheet = path.join(REVIEW, "contact-sheet-directions.png");
  if (fs.existsSync(reviewSheet)) {
    sheets.push({ ...img(reviewSheet), note: "review sheet: character poses by direction" });
  }

  const allFiles = fs.readdirSync(ASSETS, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  const sources = allFiles
    .filter((e) => e.name.endsWith(".aseprite"))
    .map((e) => {
      const p = path.join(e.parentPath, e.name);
      return { path: path.relative(ASSETS, p), bytes: fs.statSync(p).size };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    palette: PALETTE,
    characters,
    anims,
    props,
    scenes,
    atlas,
    sheets,
    sources,
    stats: { files: allFiles.length, atlasFrames: frames.length },
  };
}

function build() {
  const data = collectData();
  const template = fs.readFileSync(TEMPLATE, "utf8");
  // split/join, not String.replace: the JSON payload may contain `$`-sequences
  // that replace() would treat as substitution patterns.
  const html = template.split("/*__DATA__*/").join(`window.DATA = ${JSON.stringify(data)};`);
  return { html, data };
}

function summarize(html, data) {
  const missing =
    data.anims.length === 0
      ? " — review renders missing; run python3 assets/garden/tools/render_review.py"
      : "";
  return (
    `${Math.round(html.length / 1024)} KB: ${data.characters.length} characters, ` +
    `${data.anims.length} animation renders, ${data.stats.atlasFrames} atlas frames, ${data.sources.length} sources${missing}`
  );
}

// ---- CLI ----
const argv = process.argv.slice(2);
const serveMode = argv.includes("--serve");

if (!serveMode) {
  const outArg = argv.find((a) => !a.startsWith("--"));
  const outPath = path.resolve(outArg ?? path.join(ROOT, "artifacts", "asset-dashboard.html"));
  const { html, data } = build();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html);
  console.log(`wrote ${path.relative(ROOT, outPath)} (${summarize(html, data)})`);
} else {
  const port = Number(argv[argv.indexOf("--port") + 1]) || 4173;
  const RELOAD_CLIENT =
    "<script>new EventSource('/events').addEventListener('reload',()=>location.reload())</script>";

  // fail fast on startup, then rebuild on every page load — the served
  // dashboard always reflects assets/ as they are right now.
  const startup = build();
  console.log(`built (${summarize(startup.html, startup.data)})`);

  const sseClients = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(":ok\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    try {
      const { html, data } = build();
      console.log(`rebuilt on load (${summarize(html, data)})`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html + RELOAD_CLIENT);
    } catch (err) {
      console.error(`rebuild failed: ${err.message}`);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`dashboard rebuild failed: ${err.message}`);
    }
  });

  // watching just nudges open tabs to reload; the reload's GET does the build.
  let timer = null;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const res of sseClients) res.write("event: reload\ndata: 1\n\n");
    }, 250);
  };
  fs.watch(ASSETS, { recursive: true }, notify);
  fs.watch(TEMPLATE, notify);

  server.listen(port, () => {
    console.log(`live dashboard at http://localhost:${port} — watching assets/ (ctrl-c to stop)`);
  });
}
