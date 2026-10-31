import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
await build({
  entryPoints: [path("../src/index.ts")],
  outfile: path("../dist/index.cjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
});
