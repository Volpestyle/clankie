import { build } from "esbuild";
import { resolve } from "node:path";

await build({
  absWorkingDir: resolve(import.meta.dirname, ".."),
  entryPoints: ["apps/tui/bin/remote-lead-mcp.ts"],
  outfile: ".local/remote-lead/remote-lead-mcp.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
