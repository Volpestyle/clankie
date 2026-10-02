import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { readCodexRateLimits } from "../../../packages/settings/src/codex-rate-limits.ts";
import { SettingsStore } from "@clankie/settings";
// @ts-expect-error -- checkout eval tooling is plain ESM.
import { codexCampaign } from "../../../scripts/evals/codex.mjs";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const args = ["--cases", "memory-card", "--reps", "1", "--max-runs", "1"];

test("evals pin one registry-selected home for the campaign and restore the caller's home", async () => {
  const root = await mkdtemp(join(tmpdir(), "eval-codex-accounts-"));
  roots.push(root);
  const first = join(root, "default"),
    second = join(root, "second");
  for (const [home, used] of [
    [first, 90],
    [second, 10],
  ] as const) {
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "auth.json"), "fixture presence only");
    await writeFile(
      join(home, "sessions", "rollout.jsonl"),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        payload: {
          rate_limits: {
            primary: { used_percent: used, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
            secondary: { used_percent: used, window_minutes: 10080, resets_at: Date.now() / 1000 + 86400 },
          },
        },
      }) + "\n",
    );
  }
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, codexAccounts: [{ label: "second", home: second }] }));
  vi.stubEnv("CODEX_HOME", first);
  vi.stubEnv("CLANKIE_SETTINGS_FILE", settings.path);
  const runner = vi.fn(async (options) => {
    expect(process.env.CODEX_HOME).toBe(second);
    await Promise.resolve();
    expect(process.env.CODEX_HOME).toBe(second);
    return { options };
  });
  expect(await codexCampaign(args, runner)).toMatchObject({
    options: { harness: "codex", account: { label: "second", home: second } },
  });
  expect(process.env.CODEX_HOME).toBe(first);
  runner.mockClear();
  await expect(codexCampaign([...args, "--account", "default"], runner)).rejects.toThrow("usage guard");
  expect(runner).not.toHaveBeenCalled();
  // A missing weekly window cannot hide an exhausted known five-hour window.
  await writeFile(
    join(first, "sessions", "rollout.jsonl"),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      payload: {
        rate_limits: {
          primary: { used_percent: 100, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
        },
      },
    }) + "\n",
  );
  await expect(codexCampaign([...args, "--account", "default"], runner)).rejects.toThrow("usage guard");
  expect(runner).not.toHaveBeenCalled();
  await expect(
    codexCampaign([...args, "--account", "second"], async () => {
      throw Error("fixture failure");
    }),
  ).rejects.toThrow("fixture failure");
  expect(process.env.CODEX_HOME).toBe(first);
  // Live weekly-only quota overrides an older, less-used rollout before a campaign starts.
  vi.mocked(readCodexRateLimits).mockResolvedValueOnce(
    JSON.stringify({
      payload: {
        rate_limits: {
          primary: { used_percent: 92, window_minutes: 10080, resets_at: Date.now() / 1000 + 86400 },
        },
      },
    }),
  );
  runner.mockClear();
  await expect(codexCampaign([...args, "--account", "second"], runner)).rejects.toThrow("usage guard");
  expect(runner).not.toHaveBeenCalled();
});

test("a Codex dry run neither loads credentials nor starts the runner", async () => {
  const runner = vi.fn();
  expect(await codexCampaign([...args, "--account", "second", "--dry-run"], runner)).toMatchObject({
    dryRun: true,
    account: "second",
    harness: "codex",
  });
  expect(runner).not.toHaveBeenCalled();
  await expect(codexCampaign([...args, "--account"], runner)).rejects.toThrow("registered label");
});

vi.mock("../../../packages/settings/src/codex-rate-limits.ts", () => ({
  readCodexRateLimits: vi.fn(async () => null),
}));
