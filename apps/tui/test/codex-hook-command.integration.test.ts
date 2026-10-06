import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

// Exercise the shipped commands through the native shell, including paths
// that cannot safely be interpolated into JavaScript or shell source.
test("Codex hook commands load both real plugins from a path with spaces and punctuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-hook-command-"));
  const repo = join(import.meta.dirname, "../../..");
  try {
    for (const [source, manifest] of [
      ["integrations/claude-plugin/worker", "hooks/codex-hooks.json"],
      ["integrations/codex-plugin", "hooks/hooks.json"],
    ] as const) {
      const plugin = join(root, source, "plugin $ root's path");
      await cp(join(repo, source), plugin, { recursive: true });
      const definitions = JSON.parse(await readFile(join(plugin, manifest), "utf8"));
      for (const entries of Object.values(definitions.hooks) as { hooks: { command: string }[] }[][]) {
        for (const { hooks } of entries) {
          for (const { command } of hooks) {
            const env: NodeJS.ProcessEnv = { ...process.env, PLUGIN_ROOT: plugin };
            delete env.HERDR_PANE_ID;
            delete env.CLANKIE_CODEX_SEAT_BINDING;
            const result = spawnSync(command, { env, shell: true, encoding: "utf8", input: "{}" });
            expect(result.status, result.stderr).toBe(0);
            expect(result.stdout).toBe("");
            expect(result.stderr).toBe("");
          }
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
