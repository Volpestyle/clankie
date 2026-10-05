import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: [fileURLToPath(new URL("../src/official-admission.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/activity-client.js", import.meta.url)),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "eof",
});
