import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  codexAccountStatus,
  readCodexAccountStatus,
  selectLiveCodexAccount,
  codexRateLimit,
  selectCodexAccount,
  registerCodexAccount,
  codexAccounts,
} from "../src/codex-accounts.ts";
import { SettingsStore } from "../src/store.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function account(label: string, used?: [number, number], age = 0, reset = Date.now() + 3600_000) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "codex-account-")));
  roots.push(home);
  // Deliberately not JSON: only presence is checked, never credential contents.
  writeFileSync(join(home, "auth.json"), "not credential data");
  mkdirSync(join(home, "sessions"));
  if (used)
    writeFileSync(
      join(home, "sessions", "rollout.jsonl"),
      JSON.stringify({
        timestamp: new Date(Date.now() - age).toISOString(),
        payload: {
          rate_limits: {
            primary: { used_percent: used[0], window_minutes: 300, resets_at: reset / 1000 },
            secondary: { used_percent: used[1], window_minutes: 10080, resets_at: reset / 1000 },
          },
        },
      }) + '\n{"payload":',
    );
  return { label, home };
}

test("selects the least constrained account across both windows, with explicit override and stable ties", () => {
  const a = account("default", [10, 90]);
  const b = account("second", [40, 50]);
  expect(selectCodexAccount([a, b]).label).toBe("second");
  expect(selectCodexAccount([a, b], "default").label).toBe("default");
  expect(selectCodexAccount([b, account("tie", [40, 50])]).label).toBe("second");
  expect(() => selectCodexAccount([a], "missing")).toThrow("Unknown Codex account");
});

test("unknown and stale telemetry are not free quota; expired windows recover", () => {
  const unknown = account("unknown");
  const stale = account("stale", [0, 0], 25 * 3600_000);
  const exhausted = account("exhausted", [100, 0]);
  const known = account("known", [80, 80]);
  expect(codexAccountStatus(stale).headroom).toBeNull();
  expect(selectCodexAccount([unknown, stale, known]).label).toBe("known");
  expect(selectCodexAccount([exhausted, unknown]).label).toBe("unknown");
  expect(codexAccountStatus(account("reset", [100, 100], 0, Date.now() - 1000)).headroom).toBe(1);
});

test("skips homes without credentials without reading credential contents", () => {
  const missing = account("missing", [0, 0]);
  rmSync(join(missing.home, "auth.json"));
  const ready = account("ready", [50, 50]);
  expect(selectCodexAccount([missing, ready]).label).toBe("ready");
  expect(() => selectCodexAccount([missing], "missing")).toThrow("owner must sign in");
});

test("registration stores only canonical paths and labels and rejects duplicates", async () => {
  const a = account("second");
  const store = new SettingsStore(join(a.home, "settings.json"));
  await registerCodexAccount(store, a, { CODEX_HOME: "/missing-default" });
  expect((await store.load()).codexAccounts).toEqual([a]);
  expect(codexAccounts(await store.load(), { CODEX_HOME: "/missing-default" })).toEqual([
    { label: "default", home: "/missing-default" },
    a,
  ]);
  await expect(registerCodexAccount(store, a)).rejects.toThrow("already registered");
  await expect(registerCodexAccount(store, { ...a, label: "default" })).rejects.toThrow();
});

test("the eval parser tolerates partial records and maps the two Codex windows", () => {
  expect(
    codexRateLimit(
      '{"payload":{"rate_limits":{"primary":{"window_minutes":300,"used_percent":72,"resets_at":123}}}}\n{"payload":',
    ),
  ).toEqual({
    five_hour: 0.72,
    seven_day: null,
    resets: { five_hour: 123, seven_day: null },
    limited: false,
  });
  expect(codexRateLimit("not JSON")).toBeNull();
});

vi.mock("../src/codex-rate-limits.ts", () => ({ readCodexRateLimits: vi.fn(async () => null) }));
import { readCodexRateLimits } from "../src/codex-rate-limits.ts";

function weekly(used: number, reset = Date.now() / 1000 + 3600, limited = false) {
  return JSON.stringify({
    payload: {
      rate_limits: {
        primary: { used_percent: used, window_minutes: 10080, resets_at: reset },
        secondary: null,
        rate_limit_reached_type: limited ? "weekly" : null,
      },
    },
  });
}

test("live weekly-only quota selects by current home, even without rollouts, and override pins", async () => {
  const a = account("default", [1, 1]);
  const b = account("second");
  vi.mocked(readCodexRateLimits).mockImplementation(async (home) => weekly(home === a.home ? 92 : 2));
  try {
    expect((await readCodexAccountStatus(a)).headroom).toBeCloseTo(0.08);
    expect((await selectLiveCodexAccount([a, b])).label).toBe("second");
    expect((await selectLiveCodexAccount([a, b], "default")).label).toBe("default");
    vi.mocked(readCodexRateLimits).mockImplementation(async (home) => weekly(home === a.home ? 2 : 92));
    expect((await selectLiveCodexAccount([a, b])).label).toBe("default");
  } finally {
    vi.mocked(readCodexRateLimits).mockResolvedValue(null);
  }
});

test("unavailable live quota falls back to rollout observations", async () => {
  const a = account("saved", [60, 70]);
  vi.mocked(readCodexRateLimits).mockRejectedValueOnce(new Error("unavailable"));
  expect((await readCodexAccountStatus(a)).headroom).toBeCloseTo(0.3);
  expect((await readCodexAccountStatus(account("unknown"))).headroom).toBeNull();
});

test("a limited weekly-only window recovers only when its reset passes", async () => {
  const a = account("weekly");
  vi.mocked(readCodexRateLimits).mockResolvedValueOnce(weekly(100, Date.now() / 1000 + 3600, true));
  expect((await readCodexAccountStatus(a)).headroom).toBe(0);
  vi.mocked(readCodexRateLimits).mockResolvedValueOnce(weekly(100, Date.now() / 1000 - 1, true));
  expect((await readCodexAccountStatus(a)).headroom).toBe(1);
});
