import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it("a standalone bundle derives OAuth auth without the source package beside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-oauth-bundle-"));
  try {
    const output = join(root, "proof.mjs");
    await build({
      stdin: {
        resolveDir: fileURLToPath(new URL("../../../packages/model-provider", import.meta.url)),
        contents: `
          import assert from "node:assert/strict";
          import { registerConfiguredPiProviders } from "./src/pi.ts";
          import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
          registerConfiguredPiProviders({}, {}, {});
          const auth = await openaiCodexProvider().auth.oauth.toAuth({
            type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 0,
          });
          assert.equal(auth.apiKey, "fixture-access");
        `,
      },
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
    });
    const result = spawnSync(process.execPath, [output], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
