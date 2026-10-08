import type { BuildResult } from "esbuild";
export function bundlePiWorkerFleet(
  repoRoot: string,
  releaseRoot: string,
): Promise<BuildResult<{ metafile: true }>>;
