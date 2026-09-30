import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  codexAccountStatus,
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
