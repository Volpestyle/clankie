import { mintOperatorToken } from "@clankie/credential-broker";
import { createWorkerAccountHoldsRoutes } from "../src/worker-account-holds-routes.ts";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HerdrFleet, HerdrFleetRun } from "../src/herdr-fleet.ts";
import { createRemoteHerdrRunner, routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { runAccountsCommand } from "../../tui/src/command/accounts.ts";
import {
  createWorkerAccountsReader,
  chooseWorkerAccount,
  readMachineWorkerAccounts,
  workerAccountsProbeCommand,
  type MachineWorkerAccounts,
  type WorkerAccountHold,
} from "../src/captain/harness-accounts.ts";
import { allocateAccounts, runOutWarnings } from "../src/captain/account-allocation.ts";

/**
 * Account choice across the fleet link (VUH-1527, ADR 0221): the probe is the
 * real script run by a real shell and Node against real `claude` and `codex`
 * CLIs in a fixture home, and the hire runs through the remote Herdr runner.
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

/** A fleet shell into a fixture home: what ssh gives a posix machine, minus the network. */
function fixtureShell(home: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["CLAUDE_CONFIG_DIR", "CODEX_HOME", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"].includes(key),
    ),
  );
  return async (command: string, timeout?: number) =>
    (
      await exec("/bin/sh", ["-c", command], {
        env: { ...env, HOME: home },
        timeout: timeout ?? 60_000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
}

async function fixtureHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-accounts-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(join(home, ".claude-work"), { recursive: true });
  await mkdir(join(home, ".codex-work"), { recursive: true });
  await writeFile(join(home, ".codex-work", "config.toml"), "");
  // Not a Codex home: no config or sign-in, so it is not offered.
  await mkdir(join(home, ".codex-notes"), { recursive: true });
  return home;
}

const box: HerdrFleet = { id: "box", session: "default", ssh: { host: "box.invalid", shell: "posix" } };

describe.skipIf(!harnessesInstalled)("a machine reports its own worker accounts", () => {
  it("discovers ~/.claude-<label> and ~/.codex-<label> homes and asks each CLI whether it is signed in", async () => {
    const home = await fixtureHome();
    const report = await readMachineWorkerAccounts(box, fixtureShell(home));
    expect(report.unavailable).toBeUndefined();
    const labels = report.accounts.map((account) => `${account.harness}:${account.label}`);
    expect(labels).toEqual(["claude:default", "claude:work", "codex:default", "codex:work"]);
    const work = report.accounts.filter((account) => account.label === "work");
    for (const account of work) {
      expect(account).toMatchObject({ signedIn: false, usable: false, headroom: null });
      expect(account.home).toBe(join(home, `.${account.harness}-work`));
      expect(account.reason).toContain("Sign it in on box");
    }
    expect(JSON.stringify(report)).not.toMatch(/token|secret/iu);
  }, 90_000);

  it("answers the API and CLI for a linked machine, with the owner's holds", async () => {
    const home = await fixtureHome();
    const settings = new SettingsStore(join(home, "..", "settings.json"));
    await settings.update((current) => ({
      ...current,
      execution: {
        connections: [
          {
            id: "box",
            kind: "herdr",
            session: "default",
            ssh: box.ssh,
            enabled: true,
            capabilities: ["code"],
          },
        ],
      },
    }));
    const app = await createClankieApp({
      captain: createStubCaptain(),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
      workerAccounts: createWorkerAccountsReader({
        settings: () => settings.load(),
        fleet: async (id) => (id === "box" ? box : undefined),
        shell: () => fixtureShell(home),
      }),
    });
    const request = async (path: string) =>
      (await (await app.app.request(path, { headers: { authorization: "Bearer owner" } })).json()) as Record<
        string,
        unknown
      >;
    expect((await app.app.request("/v1/worker-accounts?fleet=box")).status).toBe(401);
    const holdToken = mintOperatorToken();
    const holdRoutes = createWorkerAccountHoldsRoutes(
      async (request) =>
        request.headers.get("authorization") === `Bearer ${holdToken}` ? true : "authentication_required",
      settings,
    );
    const holdClient = {
      settings,
      env: { CLANKIE_OPERATOR_TOKEN: holdToken },
      host: "http://clankie.test",
      fetchImpl: ((url: RequestInfo | URL, init?: RequestInit) =>
        holdRoutes.fetch(new Request(String(url), init))) as typeof fetch,
    };
    expect(
      await runAccountsCommand(
        ["hold", "codex", "work", "--machine", "box", "--reason", "plan not renewed"],
        {
          ...holdClient,
        },
      ),
    ).toMatchObject({
      holds: [{ machine: "box", harness: "codex", label: "work", reason: "plan not renewed" }],
    });
    const report = (await runAccountsCommand(["workers", "--machine", "box"], {
      request,
    })) as MachineWorkerAccounts;
    expect(report.machine).toBe("box");
    expect(report.accounts.find((a) => a.harness === "codex" && a.label === "work")).toMatchObject({
      held: { reason: "plan not renewed" },
      signedIn: false,
    });
    await runAccountsCommand(["release", "codex", "work", "--machine", "box"], holdClient);
    expect((await settings.load()).workerAccountHolds).toEqual([]);
    await expect(runAccountsCommand(["workers", "--machine", "nowhere"], { request })).rejects.toThrow(
      /nowhere is not a linked machine/u,
    );
  }, 90_000);

  it("refuses a hire on a signed-out or missing profile by name, before any pane exists", async () => {
    const home = await fixtureHome();
    const calls: string[][] = [];
    const run: HerdrFleetRun = async (args) => {
      calls.push([...args]);
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const root = await mkdtemp(join(tmpdir(), "clankie-worker-accounts-store-"));
    roots.push(root);
    const store = new HerdrWatchStore(join(root, "watches.json"), {
      runner: routeHerdrFleets(
        {
          get: async () => ({}) as HerdrAgentSnapshot,
          resolveTerminal: async () => undefined,
          wait: async () => ({}) as HerdrAgentSnapshot,
        },
        new Map([["box", createRemoteHerdrRunner(box, run, { pollMs: 5 })]]),
      ),
      remoteWorkspace: async (fleet, directory) => fleet === "box" && directory === "/src/app",
      workerAccounts: (fleet, harness) =>
        readMachineWorkerAccounts(box, fixtureShell(home), { harnesses: [harness] }).then((report) => {
          expect(fleet).toBe("box");
          return report;
        }),
    });
    const signedOut = await store.spawnSeat({
      schemaVersion: 1,
      harness: "claude",
      title: "Reader",
      workingDirectory: "/src/app",
      fleet: "box",
      account: "work",
    });
    expect(signedOut).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
    const detail = (signedOut as { detail: string }).detail;
    expect(detail).toContain("Claude profile work on box");
    expect(detail).toContain(`CLAUDE_CONFIG_DIR='${join(home, ".claude-work")}' claude auth login`);
    expect(detail).toContain("No other account was tried");
    const missing = await store.spawnSeat({
      schemaVersion: 1,
      harness: "codex",
      title: "Reader",
      workingDirectory: "/src/app",
      fleet: "box",
      account: "spare",
    });
    expect((missing as { detail: string }).detail).toContain("box has no Codex account spare");
    expect(calls).toEqual([]);
    store.close();
  }, 120_000);
});

it("keeps the Windows probe command within the ssh command-line bound", () => {
  const command = workerAccountsProbeCommand("powershell");
  expect(command.length).toBeLessThan(30_000);
  expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /u);
});

/**
 * James's PC as its probe reported it on 2026-10-07 (identities redacted):
 * the default Claude profile signed out, `~/.claude-james` signed in, and two
 * Codex homes with headroom.
 */
const PC_REPORT: MachineWorkerAccounts = {
  machine: "pc",
  shell: "powershell",
  observedAt: "2026-10-07T18:16:08.148Z",
  accounts: [
    {
      harness: "claude",
      label: "default",
      home: "C:\\Users\\volpe\\.claude",
      signedIn: false,
      headroom: null,
      workerPlugin: true,
      usable: false,
      reason: "not signed in. Sign it in on pc: claude auth login.",
    },
    {
      harness: "claude",
      label: "james",
      home: "C:\\Users\\volpe\\.claude-james",
      signedIn: true,
      identity: "owner@example.com",
      plan: "max",
      headroom: null,
      workerPlugin: true,
      usable: true,
    },
    {
      harness: "codex",
      label: "default",
      home: "C:\\Users\\volpe\\.codex",
      signedIn: true,
      identity: "owner2@example.com",
      plan: "pro",
      headroom: 1,
      usable: true,
    },
    {
      harness: "codex",
      label: "james",
      home: "C:\\Users\\volpe\\.codex-james",
      signedIn: true,
      identity: "owner2@example.com",
      plan: "pro",
      headroom: 1,
      usable: true,
    },
  ],
};

describe("a remote hire runs as the account Clankie chose on that machine", () => {
  const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "pc.invalid", shell: "powershell" } };
  async function hireOn(
    harness: "claude" | "codex" | undefined,
    holds: readonly WorkerAccountHold[],
    account?: string,
    machine: MachineWorkerAccounts = PC_REPORT,
    // The harness the pane comes up as when the hire names none.
    expected: "claude" | "codex" = harness ?? "codex",
  ) {
    const calls: string[][] = [];
    const run: HerdrFleetRun = async (args) => {
      calls.push([...args]);
      if (args[0] === "worktree")
        return JSON.stringify({
          result: { source: { repo_key: "fixture-repo", repo_root: "C:\\src", repo_name: "src" } },
        });
      if (args[0] === "api")
        return JSON.stringify({
          result: {
            snapshot: {
              workspaces: [
                {
                  workspace_id: "w2",
                  label: "src",
                  number: 2,
                  worktree: {
                    repo_key: "fixture-repo",
                    repo_root: "C:\\src",
                    repo_name: "src",
                    is_linked_worktree: false,
                  },
                },
              ],
              tabs: [],
              panes: [],
            },
          },
        });
      if (args[0] === "pane" && args[1] === "rename") return "{}";
      if (args[0] === "pane" && args[1] === "report-metadata") {
        expect(args[2]).toBe("w2:p9");
        expect(args[args.indexOf("--source") + 1]).toBe("clankie-hire-layout");
        const tokens = args.flatMap((arg, index) => (args[index - 1] === "--token" ? [arg] : []));
        expect(tokens).toContain("clankie_grid=2x2");
        expect(tokens.some((token) => /^clankie_repo=[a-f0-9]{64}$/u.test(token))).toBe(true);
        expect(tokens.some((token) => /^clankie_pipeline=[a-f0-9]{64}$/u.test(token))).toBe(true);
        return ""; // Real Herdr metadata success has no JSON payload.
      }
      if (args[0] === "tab") return JSON.stringify({ result: { root_pane: { pane_id: "w2:p9" } } });
      if (args[0] === "pane" && args[1] === "list")
        return JSON.stringify({
          result: {
            panes: [
              {
                pane_id: "w2:p9",
                terminal_id: "term_new",
                agent: expected,
                agent_status: "idle",
                agent_session: { source: `herdr:${expected}`, kind: "id", value: "session-new" },
              },
            ],
          },
        });
      if (args[0] === "agent" && args[1] === "start") return "{}";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const root = await mkdtemp(join(tmpdir(), "clankie-worker-accounts-hire-"));
    roots.push(root);
    const report = async () => ({
      ...machine,
      accounts: machine.accounts.map((entry) => {
        const hold = holds.find((h) => h.harness === entry.harness && h.label === entry.label);
        return hold ? { ...entry, held: {} } : entry;
      }),
    });
    const store = new HerdrWatchStore(join(root, "watches.json"), {
      runner: routeHerdrFleets(
        {
          get: async () => ({}) as HerdrAgentSnapshot,
          resolveTerminal: async () => undefined,
          wait: async () => ({}) as HerdrAgentSnapshot,
        },
        new Map([["pc", createRemoteHerdrRunner(pc, run, { pollMs: 5 })]]),
      ),
      remoteWorkspace: async (fleet, directory) => fleet === "pc" && directory === "C:\\src\\rivals",
      workerAccounts: report,
    });
    // The same machine view the worker_accounts tool reads, wired as the captain wires it.
    store.workerAccountsReport = report;
    const result = await store.spawnSeat({
      schemaVersion: 1,
      ...(harness === undefined ? {} : { harness }),
      title: "Reader",
      workingDirectory: "C:\\src\\rivals",
      fleet: "pc",
      ...(account === undefined ? {} : { account }),
    });
    store.close();
    const tab = calls.find((call) => call[0] === "tab");
    return {
      result,
      calls,
      env: tab?.flatMap((arg, index) => (tab[index - 1] === "--env" ? [arg] : [])) ?? [],
    };
  }

  it("skips a signed-out default Claude profile for a signed-in one and starts there", async () => {
    const { result, env } = await hireOn("claude", []);
    expect(result).toMatchObject({ outcome: "spawned", seat: { paneId: "pc/w2:p9" } });
    expect(env).toContain("CLAUDE_CONFIG_DIR=C:\\Users\\volpe\\.claude-james");
  });

  it("refuses an explicit signed-out profile instead of falling back", async () => {
    const { result, env } = await hireOn("claude", [], "default");
    expect(result).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
    expect((result as { detail: string }).detail).toContain("Claude profile default on pc");
    expect(env).toEqual([]);
  });

  it("leaves a held Codex account to an explicit choice", async () => {
    const auto = await hireOn("codex", [{ machine: "pc", harness: "codex", label: "default" }]);
    expect(auto.result).toMatchObject({ outcome: "spawned" });
    expect(auto.env).toContain("CODEX_HOME=C:\\Users\\volpe\\.codex-james");
    const explicit = await hireOn(
      "codex",
      [{ machine: "pc", harness: "codex", label: "default" }],
      "default",
    );
    expect(explicit.result).toMatchObject({ outcome: "spawned" });
    expect(explicit.env.some((entry) => entry.startsWith("CODEX_HOME="))).toBe(false);
  });

  it("explains why nothing is usable when every account is out", () => {
    const report: MachineWorkerAccounts = {
      ...PC_REPORT,
      accounts: PC_REPORT.accounts.map((entry) => ({ ...entry, usable: false, reason: "usage exhausted" })),
    };
    expect(chooseWorkerAccount("pc", "codex", report)).toEqual({
      refused:
        "No Codex account on pc can take a hire now: default: usage exhausted; james: usage exhausted.",
    });
  });

  it("with no harness at any layer, chooses one from the machine's accounts instead of assuming Codex", async () => {
    // Plenty of Codex usage left: Codex, on its best account.
    const roomy = await hireOn(undefined, []);
    expect(roomy.result).toMatchObject({ outcome: "spawned", profile: { harness: "codex" } });
    // Codex under half its usage: Claude, on the signed-in profile, not the signed-out default.
    const tight: MachineWorkerAccounts = {
      ...PC_REPORT,
      accounts: PC_REPORT.accounts.map((entry) =>
        entry.harness === "codex" ? { ...entry, headroom: 0.3 } : entry,
      ),
    };
    const low = await hireOn(undefined, [], undefined, tight, "claude");
    expect(low.result).toMatchObject({ outcome: "spawned", profile: { harness: "claude" } });
    expect(low.env).toContain("CLAUDE_CONFIG_DIR=C:\\Users\\volpe\\.claude-james");
    // Claude's observed usage is tighter still: back to Codex (VUH-1961).
    const claudeTighter: MachineWorkerAccounts = {
      ...tight,
      accounts: tight.accounts.map((entry) =>
        entry.harness === "claude" ? { ...entry, headroom: 0.2 } : entry,
      ),
    };
    const lower = await hireOn(undefined, [], undefined, claudeTighter);
    expect(lower.result).toMatchObject({ outcome: "spawned", profile: { harness: "codex" } });
    // Every Codex account held by the owner: Claude even with full Codex usage.
    const held = await hireOn(
      undefined,
      [
        { machine: "pc", harness: "codex", label: "default" },
        { machine: "pc", harness: "codex", label: "james" },
      ],
      undefined,
      PC_REPORT,
      "claude",
    );
    expect(held.result).toMatchObject({ outcome: "spawned", profile: { harness: "claude" } });
  });

  it("refuses a harness-less hire before any pane when no account can take it", async () => {
    const out: MachineWorkerAccounts = {
      ...PC_REPORT,
      accounts: PC_REPORT.accounts.map((entry) => ({ ...entry, usable: false, reason: "usage exhausted" })),
    };
    const { result, calls } = await hireOn(undefined, [], undefined, out);
    expect(result).toMatchObject({ outcome: "failed", reason: "harness_unavailable" });
    expect((result as { detail: string }).detail).toContain(
      "No usable claude or codex account on pc to choose a harness from",
    );
    expect((result as { detail: string }).detail).toContain("Pass harness");
    expect(calls).toEqual([]);
  });

  /**
   * The 2026-10-09 accounts (VUH-1974): a Max 20x week 84% used with 4.7 days
   * to go, a Max 5x week barely touched, Codex Pro at 18% with its gpt-reserve
   * pool at 94%, and the free Codex account held.
   */
  const NOW = Date.parse("2026-10-09T17:17:07.344Z");
  const week = (usedPercent: number, resetsAt: string, id = "week", label = "Current week (all models)") => ({
    id,
    label,
    usedPercent,
    windowMinutes: 10_080,
    resetsAt,
  });
  const OCT_9: MachineWorkerAccounts = {
    machine: "pc",
    shell: "powershell",
    observedAt: new Date(NOW).toISOString(),
    accounts: [
      {
        harness: "claude",
        label: "james",
        home: "C:\\Users\\volpe\\.claude-james",
        signedIn: true,
        identity: "owner@example.com",
        plan: "max",
        tier: "default_claude_max_20x",
        headroom: 0.16,
        usage: {
          source: "claude-usage",
          observedAt: new Date(NOW).toISOString(),
          windows: [week(84, "2026-10-14T11:00:00.000Z")],
        },
        workerPlugin: true,
        usable: true,
      },
      {
        harness: "claude",
        label: "volpestyle",
        home: "C:\\Users\\volpe\\.claude-volpestyle",
        signedIn: true,
        identity: "owner2@example.com",
        plan: "max",
        tier: "default_claude_max_5x",
        headroom: 0.99,
        usage: {
          source: "claude-usage",
          observedAt: new Date(NOW).toISOString(),
          windows: [week(1, "2026-10-14T00:59:00.000Z")],
        },
        workerPlugin: true,
        usable: true,
      },
      {
        harness: "codex",
        label: "default",
        home: "C:\\Users\\volpe\\.codex",
        signedIn: true,
        plan: "pro",
        headroom: 0.82,
        usage: {
          source: "codex-rate-limits",
          observedAt: new Date(NOW).toISOString(),
          windows: [
            { ...week(18, "2026-10-16T12:04:44.000Z"), label: "Weekly limit" },
            week(94, "2026-10-16T10:05:37.000Z", "week:base_model_inference", "Weekly limit (gpt-reserve)"),
          ],
        },
        usable: true,
      },
      {
        harness: "codex",
        label: "james",
        home: "C:\\Users\\volpe\\.codex-james",
        signedIn: true,
        plan: "free",
        headroom: 1,
        usable: true,
      },
    ],
  };

  it("puts an unpinned Claude hire on the account with room by plan and pace, and says why", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const auto = await hireOn("claude", [], undefined, OCT_9);
      expect(auto.result).toMatchObject({
        outcome: "spawned",
        accountChoice: { harness: "claude", account: "volpestyle" },
      });
      expect(auto.env).toContain("CLAUDE_CONFIG_DIR=C:\\Users\\volpe\\.claude-volpestyle");
      const reason = (auto.result as { accountChoice: { reason: string } }).accountChoice.reason;
      expect(reason).toContain("volpestyle (Max 5x): 99% of its week left");
      // An explicit choice is used exactly, with no allocation reason.
      const named = await hireOn("claude", [], "james", OCT_9);
      expect(named.env).toContain("CLAUDE_CONFIG_DIR=C:\\Users\\volpe\\.claude-james");
      expect(named.result).not.toHaveProperty("accountChoice");
      // An owner hold is never overridden by the ranking.
      const held = await hireOn(
        "claude",
        [{ machine: "pc", harness: "claude", label: "volpestyle" }],
        undefined,
        OCT_9,
      );
      expect(held.env).toContain("CLAUDE_CONFIG_DIR=C:\\Users\\volpe\\.claude-james");
      const codex = await hireOn(
        "codex",
        [{ machine: "pc", harness: "codex", label: "james" }],
        undefined,
        OCT_9,
      );
      expect(codex.result).toMatchObject({ accountChoice: { account: "default" } });
      expect((codex.result as { accountChoice: { reason: string } }).accountChoice.reason).toContain(
        "Weekly limit (gpt-reserve) 94% used (only hires on that model)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("projects the 20x week running out before its reset, once per reset", () => {
    const settings = { runOutWarning: true, runOutWarningHours: 12 };
    const first = runOutWarnings(OCT_9, settings, NOW);
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toContain("Claude account james (owner@example.com) on pc is on pace to run out");
    expect(first[0]!.text).toContain("Put the next Claude hires on volpestyle");
    expect(first[0]!.text).toContain("Nothing was moved or stopped");
    // A later round of the same week is the same warning, so the lead is told once.
    const later = runOutWarnings(
      {
        ...OCT_9,
        accounts: OCT_9.accounts.map((account) =>
          account.label === "james" && account.harness === "claude"
            ? {
                ...account,
                usage: { ...account.usage!, windows: [week(88, "2026-10-14T11:00:00.000Z")] },
              }
            : account,
        ),
      },
      settings,
      NOW + 3_600_000,
    );
    expect(later.map((warning) => warning.key)).toEqual(first.map((warning) => warning.key));
    expect(runOutWarnings(OCT_9, { ...settings, runOutWarning: false }, NOW)).toEqual([]);
    expect(runOutWarnings(OCT_9, { ...settings, runOutWarningHours: 120 }, NOW)).toEqual([]);
    expect(JSON.stringify(allocateAccounts(OCT_9, NOW))).not.toMatch(/token|secret|bearer/iu);
  });
});

describe("a Claude profile that has not finished first-run setup", () => {
  it("is reported unusable with the fix, and a finished one carries its plan tier", async () => {
    const home = await fixtureHome();
    const bin = join(home, "..", "bin");
    await mkdir(bin, { recursive: true });
    // Stands in for a signed-in Claude Code: the probe reads the profile's own files.
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\ncase "$*" in\n  "auth status --json") echo '{"loggedIn":true,"email":"owner@example.com","subscriptionType":"max"}';;\n  "--version") echo "1.0.0 (Claude Code)";;\nesac\n`,
      { mode: 0o755 },
    );
    await mkdir(join(home, ".claude-ready"), { recursive: true });
    await writeFile(
      join(home, ".claude-ready", ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        oauthAccount: {
          emailAddress: "owner@example.com",
          organizationRateLimitTier: "default_claude_max_20x",
        },
      }),
    );
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        hasCompletedOnboarding: true,
        // A cached sign-in for someone else says nothing about this one.
        oauthAccount: {
          emailAddress: "other@example.com",
          organizationRateLimitTier: "default_claude_max_5x",
        },
      }),
    );
    const shell = fixtureShell(home);
    const report = await readMachineWorkerAccounts(
      box,
      (command, timeout) => shell(`PATH='${bin}':"$PATH"; ${command}`, timeout),
      { harnesses: ["claude"] },
    );
    const byLabel = Object.fromEntries(report.accounts.map((account) => [account.label, account]));
    expect(byLabel["work"]).toMatchObject({ signedIn: true, usable: false });
    expect(byLabel["work"]!.reason).toContain("first-run setup");
    expect(byLabel["work"]!.reason).toContain(`CLAUDE_CONFIG_DIR='${join(home, ".claude-work")}' claude`);
    expect(byLabel["ready"]).toMatchObject({ tier: "default_claude_max_20x" });
    expect(byLabel["ready"]!.reason ?? "").not.toContain("first-run setup");
    expect(byLabel["default"]).not.toHaveProperty("tier");
    expect(byLabel["default"]!.reason ?? "").not.toContain("first-run setup");
  }, 60_000);
});
