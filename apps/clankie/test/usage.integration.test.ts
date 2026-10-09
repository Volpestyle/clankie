import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { mintOperatorToken } from "@clankie/credential-broker";
import {
  USAGE_PATH,
  USAGE_SETTINGS_PATH,
  UsageReportSchema,
  UsageSettingsSnapshotSchema,
} from "@clankie/protocol/worker-accounts";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { readMachineWorkerAccounts } from "../src/captain/harness-accounts.ts";
import { claudeUsageLines, claudeUsageWindows, usageHeadroom } from "../src/captain/harness-usage.ts";
import { runUsageCommand } from "../../tui/src/command/usage.ts";

/**
 * Usage meters (VUH-1961, ADR 0221). The API answers through the real account
 * probe against real `claude` and `codex` CLIs in a fixture home; the Claude
 * golden is the profile output `claude -p /usage` gave on 2026-10-09.
 */
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const installed = (command: string) => {
  try {
    execFileSync("/bin/sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const harnessesInstalled = process.platform !== "win32" && installed("claude") && installed("codex");

describe("Claude's own /usage lines", () => {
  it("become windows with absolute resets in the zone Claude names", () => {
    // Both profiles' lines as Claude Code 2.1.295 printed them, read at 14:20Z.
    const now = Date.parse("2026-10-09T14:20:53Z");
    const windows = claudeUsageWindows(
      claudeUsageLines([
        "Current session: 6% used · resets Oct 9 at 9:59am (America/Chicago)",
        "Current week (all models): 82% used · resets Oct 14 at 5:59am (America/Chicago)",
        "Current week (Fable): 0% used · resets Oct 14 at 6am (America/Chicago)",
      ]),
      now,
    );
    expect(windows).toEqual([
      {
        id: "session",
        label: "Current session",
        usedPercent: 6,
        windowMinutes: 300,
        resetsAt: "2026-10-09T14:59:00.000Z",
      },
      {
        id: "week",
        label: "Current week (all models)",
        usedPercent: 82,
        windowMinutes: 10_080,
        resetsAt: "2026-10-14T10:59:00.000Z",
      },
      {
        id: "week:fable",
        label: "Current week (Fable)",
        usedPercent: 0,
        windowMinutes: 10_080,
        resetsAt: "2026-10-14T11:00:00.000Z",
      },
    ]);
    // The tightest all-model window bounds a hire; the Fable-only week does not.
    expect(
      usageHeadroom({ source: "claude-usage", observedAt: new Date(now).toISOString(), windows }, now),
    ).toBeCloseTo(0.18);
    // A reset whose wall time already passed this year is next year's.
    expect(
      claudeUsageWindows([{ label: "Current session", usedPercent: 1, resets: "Jan 2 at 1am (UTC)" }], now)[0]
        ?.resetsAt,
    ).toBe("2027-01-02T01:00:00.000Z");
    // Unknown wording stays unknown rather than guessed.
    expect(
      claudeUsageWindows([{ label: "Current session", usedPercent: 1, resets: "soon" }], now)[0],
    ).not.toHaveProperty("resetsAt");
  });
});

async function service(read: Parameters<typeof createClankieApp>[0]["workerAccounts"]) {
  const root = await mkdtemp(join(tmpdir(), "clankie-usage-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const token = mintOperatorToken();
  const app = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "owner" } : undefined,
    ...(read === undefined ? {} : { workerAccounts: read }),
  });
  const client = {
    env: { CLANKIE_OPERATOR_TOKEN: token },
    host: "http://clankie.test",
    fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
      app.app.fetch(new Request(String(url), init))) as typeof fetch,
  };
  return { app, settings, client, root };
}

describe("the owner's overlay choice", () => {
  it("is read and changed through the API and CLI, refusing a stale revision", async () => {
    const { app, settings, client } = await service(undefined);
    expect((await app.app.request(USAGE_SETTINGS_PATH)).status).toBe(401);
    const initial = UsageSettingsSnapshotSchema.parse(await runUsageCommand(["overlay"], client));
    expect(initial.display).toEqual({ overlay: true });
    const hidden = UsageSettingsSnapshotSchema.parse(await runUsageCommand(["overlay", "off"], client));
    expect(hidden.display).toEqual({ overlay: false });
    const defaults = { runOutWarning: true, runOutWarningHours: 12 };
    expect((await settings.load()).usage).toEqual({ overlay: false, ...defaults });
    await expect(
      runUsageCommand(["overlay", "on", "--expected-revision", initial.revision], client),
    ).rejects.toThrow(/Settings changed/u);
    expect((await settings.load()).usage).toEqual({ overlay: false, ...defaults });
    // The run-out warning threshold (VUH-1974) rides the same fenced settings.
    expect(hidden.allocation).toEqual(defaults);
    const later = UsageSettingsSnapshotSchema.parse(await runUsageCommand(["warning", "24"], client));
    expect(later.allocation).toEqual({ runOutWarning: true, runOutWarningHours: 24 });
    const off = UsageSettingsSnapshotSchema.parse(await runUsageCommand(["warning", "off"], client));
    expect(off.allocation).toEqual({ runOutWarning: false, runOutWarningHours: 24 });
    expect((await settings.load()).usage).toEqual({
      overlay: false,
      runOutWarning: false,
      runOutWarningHours: 24,
    });
    await expect(runUsageCommand(["warning", "500"], client)).rejects.toThrow(/Usage: clankie usage/u);
  });
});

describe.skipIf(!harnessesInstalled)("GET /v1/usage", () => {
  it("reports each account through its own CLI, with unknown usage left unknown and readings shared", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-usage-home-"));
    roots.push(root);
    const home = join(root, "home");
    await mkdir(join(home, ".claude-work"), { recursive: true });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key),
      ),
    );
    let probes = 0;
    const { app, client } = await service(async () => {
      probes += 1;
      return readMachineWorkerAccounts(
        { id: "local", ssh: { host: "localhost", shell: "posix" } },
        async (command, timeout) =>
          (
            await exec("/bin/sh", ["-c", command], {
              env: { ...env, HOME: home },
              timeout: timeout ?? 60_000,
              maxBuffer: 1024 * 1024,
            })
          ).stdout,
        { harnesses: ["claude", "codex"] },
      );
    });
    expect((await app.app.request(USAGE_PATH)).status).toBe(401);
    const report = UsageReportSchema.parse(await runUsageCommand([], client));
    expect(report.accounts.map((account) => `${account.harness}:${account.label}`)).toEqual([
      "claude:default",
      "claude:work",
      "codex:default",
    ]);
    for (const account of report.accounts) {
      expect(account).toMatchObject({ signedIn: false, headroom: null });
      expect(account.usage).toBeUndefined();
      expect(account.reason).toContain("not signed in");
    }
    expect(report.settings.display).toEqual({ overlay: true });
    expect(JSON.stringify(report)).not.toMatch(/token|secret|bearer/iu);
    await runUsageCommand([], client);
    expect(probes).toBe(1);
    await runUsageCommand(["--refresh"], client);
    expect(probes).toBe(2);
  }, 120_000);
});
