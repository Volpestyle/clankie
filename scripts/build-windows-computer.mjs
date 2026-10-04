import { resolve } from "node:path";
import { build } from "esbuild";

// Creates a loadable observation host; it never starts a harness or desktop operation.
const root = resolve(import.meta.dirname, "..");
const path = resolve(root, ".local/windows-computer/native-host.mjs");
await build({
  entryPoints: [resolve(root, "apps/clankie/src/computer-windows-host.ts")],
  outfile: path,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
process.stdout.write(`${path}\n`);
