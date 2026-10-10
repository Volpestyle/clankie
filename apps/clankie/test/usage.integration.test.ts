import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { ClankieUsageOverlay } from "../../tui/src/face/clankie-usage-panel.ts";
import { createClankieFaceAnsiTheme } from "../../tui/src/face/clankie-face-theme.ts";

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

describe("the /usage panel", () => {
  // This Mac's own reading at 2026-10-10T01:40:30Z (example identities): two
  // Max 20x Claude profiles, Codex Pro on pace to run out, a held free Codex.
  const observedAt = "2026-10-10T01:40:30.092Z";
  const week = (usedPercent: number, resetsAt: string, label = "Current week (all models)") => ({
    id: "week",
    label,
    usedPercent,
    windowMinutes: 10_080,
    resetsAt,
  });
  const claude = (
    label: string,
    [session, sessionReset]: [number, string],
    [used, reset]: [number, string],
    fableReset: string,
  ) => ({
    harness: "claude" as const,
    label,
    home: `/Users/owner/.claude-${label}`,
    signedIn: true,
    identity: `${label === "default" ? "work" : label}@example.com`,
    plan: "max",
    tier: "default_claude_max_20x",
    headroom: 1 - Math.max(session, used) / 100,
    usable: true,
    usage: {
      source: "claude-usage" as const,
      observedAt,
      windows: [
        {
          id: "session",
          label: "Current session",
          usedPercent: session,
          windowMinutes: 300,
          resetsAt: sessionReset,
        },
        week(used, reset),
        { ...week(0, fableReset, "Current week (Fable)"), id: "week:fable" },
      ],
    },
  });
  const accounts = [
    claude(
      "default",
      [3, "2026-10-10T05:59:00.000Z"],
      [87, "2026-10-14T10:59:00.000Z"],
      "2026-10-14T11:00:00.000Z",
    ),
    claude(
      "volpestyle",
      [37, "2026-10-10T02:59:00.000Z"],
      [25, "2026-10-14T00:59:00.000Z"],
      "2026-10-14T01:00:00.000Z",
    ),
    {
      harness: "codex" as const,
      label: "default",
      home: "/Users/owner/.codex",
      signedIn: true,
      identity: "owner@example.com",
      plan: "pro",
      headroom: 0.74,
      usable: true,
      usage: {
        source: "codex-rate-limits" as const,
        observedAt,
        windows: [week(26, "2026-10-16T12:04:44.000Z", "Weekly limit")],
      },
    },
    {
      harness: "codex" as const,
      label: "spare",
      home: "/Users/owner/.codex-spare",
      signedIn: true,
      plan: "free",
      headroom: 1,
      usable: true,
      held: { reason: "free plan, done" },
      usage: {
        source: "codex-rate-limits" as const,
        observedAt,
        windows: [{ ...week(0, "2026-11-06T18:01:00.000Z", "Weekly limit"), windowMinutes: 43_200 }],
      },
    },
  ];
  const plain = createClankieFaceAnsiTheme({ color: false, trueColor: false });
  const color = createClankieFaceAnsiTheme({ color: true, trueColor: true });
  // pi gives the overlay 88% of the terminal.
  const draw = (overlay: ClankieUsageOverlay, columns: number) =>
    overlay.render(Math.floor(columns * 0.88)).map((line) => line.trimEnd());

  it("draws the API's report at 80 and 160 columns, with color only reinforcing the text", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-10T01:40:40.092Z"), toFake: ["Date"] });
    try {
      const { client } = await service(async () => ({
        machine: "local",
        shell: "posix",
        observedAt,
        accounts,
      }));
      const report = UsageReportSchema.parse(await runUsageCommand([], client));
      const now = Date.now();
      const overlay = (theme: typeof plain) => {
        const panel = new ClankieUsageOverlay(
          { read: async () => report, setOverlay: async () => {}, setRunOutWarning: async () => {} },
          { onClose: () => {}, onRender: () => {} },
          { theme, unicode: true, clock: () => now, timeZone: "America/Chicago" },
        );
        panel.setReport(report, now);
        return panel;
      };
      const narrow = draw(overlay(plain), 80);
      const wide = draw(overlay(plain), 160);
      // Without color the panel is plain text that still says everything.
      expect([...narrow, ...wide].join("")).not.toContain("\u001b");
      await expect(`${narrow.join("\n")}\n`).toMatchFileSnapshot("goldens/usage-panel-80.txt");
      await expect(`${wide.join("\n")}\n`).toMatchFileSnapshot("goldens/usage-panel-160.txt");
      for (const columns of [80, 160])
        expect(draw(overlay(color), columns).map((line) => stripVTControlCharacters(line))).toEqual(
          columns === 80 ? narrow : wide,
        );
    } finally {
      vi.useRealTimers();
    }
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
