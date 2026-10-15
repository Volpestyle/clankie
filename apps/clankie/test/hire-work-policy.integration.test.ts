import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { ProjectHires, projectHireProfile } from "../src/captain/project-hires.ts";
import { hireAdmissionReport, hireAdmissionChoice } from "../src/captain/hire-admission.ts";
import type { MachineWorkerAccounts } from "../src/captain/harness-accounts.ts";

// Same redacted real PC observation captured 2026-10-09 in worker-accounts.integration.test.ts.
const NOW = Date.parse("2026-10-09T17:17:07.344Z");
const week = (usedPercent: number, resetsAt: string, id = "week", label = "Current week (all models)") => ({
  id,
  label,
  usedPercent,
  windowMinutes: 10_080,
  resetsAt,
});
const report: MachineWorkerAccounts = {
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

it("admits from observed remaining plan capacity, enforces pins/exclusions and persists the per-job selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "hire-work-policy-"));
  try {
    const settings = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "kh2",
          name: "KH2",
          hiring: {
            lead: { model: "lead-model" },
            worker: { model: "worker-model", effort: "low" },
            allowedPlans: ["codex:pro"],
          },
        },
      ],
    });
    const job = {
      schemaVersion: 1 as const,
      title: "Policy fix",
      workingDirectory: root,
      effort: "high",
      effortReason: "Cross-service admission and durable journal changes require boundary verification.",
      harness: "codex" as const,
    };
    expect(projectHireProfile(settings, "kh2", job, { effort: "ultra" })).toMatchObject({
      model: "worker-model",
      effort: "high",
    });
    expect(
      projectHireProfile(settings, "kh2", { ...job, hireKind: "lead" }, { effort: "ultra" }),
    ).toMatchObject({ model: "lead-model", effort: "high" });
    expect(
      projectHireProfile(
        settings,
        "kh2",
        { ...job, effort: undefined, hireKind: "lead" },
        { effort: "ultra" },
      ).effort,
    ).toBeUndefined();
    const policy = settings.projects[0]!.hiring;
    const chosen = hireAdmissionChoice(
      hireAdmissionReport(report, policy, ["worker-model"], NOW),
      undefined,
      undefined,
      NOW,
    );
    expect(chosen.plan).toBe("codex:pro");
    expect(chosen.remaining).toBeCloseTo(0.82);
    expect(() =>
      hireAdmissionChoice(
        hireAdmissionReport(report, { ...policy, excludedPlans: ["codex:pro"] }, [], NOW),
        undefined,
        undefined,
        NOW,
      ),
    ).toThrow("No observed plan");
    expect(() =>
      hireAdmissionChoice(
        hireAdmissionReport(report, { excludedModels: ["worker-model"] }, ["worker-model"], NOW),
        undefined,
        undefined,
        NOW,
      ),
    ).toThrow("model excluded");
    const path = join(root, "hires.json");
    const ledger = new ProjectHires(path);
    const hire = ledger.reserve(settings, "kh2", job);
    ledger.selection(hire.id, {
      at: report.observedAt,
      plan: chosen.plan,
      remaining: chosen.remaining,
      reason: chosen.reason,
      model: "worker-model",
      effort: job.effort,
      effortReason: job.effortReason,
    });
    new ProjectHires(path).launch(hire.id, settings, false);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.allocations[0].selection).toMatchObject({
      plan: "codex:pro",
      remaining: chosen.remaining,
      effort: "high",
      effortReason: job.effortReason,
    });
    const changed = structuredClone(settings);
    changed.projects[0]!.hiring!.excludedPlans = ["codex:pro"];
    expect(() => new ProjectHires(path).launch(hire.id, changed, false)).toThrow("launch settings changed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("stops new hires on near-limit, held, stale or unobserved plans even when explicitly pinned", () => {
  const near = structuredClone(report);
  near.accounts.forEach((account) =>
    account.usage?.windows.forEach((window) => {
      window.usedPercent = 90;
    }),
  );
  for (const pinned of [undefined, "default"])
    expect(() =>
      hireAdmissionChoice(hireAdmissionReport(near, undefined, [], NOW), "codex", pinned, NOW),
    ).toThrow("near its limit");
  const held = { ...report, accounts: report.accounts.map((account) => ({ ...account, held: {} })) };
  expect(() =>
    hireAdmissionChoice(hireAdmissionReport(held, undefined, [], NOW), "codex", "default", NOW),
  ).toThrow("held by the owner");
  expect(() =>
    hireAdmissionChoice(hireAdmissionReport(report, undefined, [], NOW + 301_000), undefined, undefined, NOW),
  ).toThrow("stale");
  const unknown = { ...report, accounts: report.accounts.map(({ usage: _usage, ...account }) => account) };
  expect(() =>
    hireAdmissionChoice(hireAdmissionReport(unknown, undefined, [], NOW), undefined, undefined, NOW),
  ).toThrow("unavailable");
});

it("permits an explicit owner override of the reserve, while keeping holds, exclusions and exhausted accounts binding", () => {
  const near = structuredClone(report);
  near.accounts.forEach((account) =>
    account.usage?.windows.forEach((window) => {
      window.usedPercent = 95;
    }),
  );
  const refused = hireAdmissionReport(near, { allowedPlans: ["codex:pro"] }, [], NOW);
  try {
    hireAdmissionChoice(refused, "codex", "default", NOW);
    throw new Error("Expected refusal");
  } catch (error) {
    expect(error).toMatchObject({
      admission: {
        kind: "usage_refused",
        canOverride: true,
        accounts: [{ plan: "codex:pro", canOverride: true, resetsAt: expect.any(String) }],
      },
    });
  }
  expect(
    hireAdmissionChoice(hireAdmissionReport(near, undefined, [], NOW, true), "codex", "default", NOW)
      .remaining,
  ).toBeCloseTo(0.05);
  for (const guarded of [
    {
      source: { ...near, accounts: near.accounts.map((account) => ({ ...account, held: {} })) },
      policy: undefined,
    },
    {
      source: near,
      policy: { excludedPlans: ["codex:pro", "claude:max_20x", "claude:max_5x", "codex:free"] },
    },
    {
      source: {
        ...near,
        accounts: near.accounts.map((account) => ({ ...account, usable: false, reason: "Signed out" })),
      },
      policy: undefined,
    },
  ])
    expect(() =>
      hireAdmissionChoice(
        hireAdmissionReport(guarded.source, guarded.policy, [], NOW, true),
        "codex",
        "default",
        NOW,
      ),
    ).toThrow("No observed plan");
  near.accounts.forEach((account) =>
    account.usage?.windows.forEach((window) => {
      window.usedPercent = 100;
    }),
  );
  expect(() =>
    hireAdmissionChoice(hireAdmissionReport(near, undefined, [], NOW, true), "codex", "default", NOW),
  ).toThrow("No observed plan");
});
