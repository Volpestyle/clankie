import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
for (const [entry, outfile] of [
  ["../src/index.ts", "../dist/index.cjs"],
  // Operator-only recovery, run beside the service on the gateway host.
  ["../src/host-keys-cli.ts", "../dist/host-keys-cli.cjs"],
]) {
  await build({
    entryPoints: [path(entry)],
    outfile: path(outfile),
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
  });
}
