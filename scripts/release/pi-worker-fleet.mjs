import { build } from "esbuild";
import { join } from "node:path";

// Native Pi loads this asset outside the service bundle and has no Clankie deps.
export function bundlePiWorkerFleet(repoRoot, releaseRoot) {
  return build({
    metafile: true,
    absWorkingDir: repoRoot,
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    bundle: true,
    entryPoints: ["apps/clankie/src/captain/pi-worker-fleet.mjs"],
    outfile: join(releaseRoot, "apps/clankie/src/captain/pi-worker-fleet.mjs"),
    format: "esm",
    platform: "node",
    target: "node24",
  });
}
