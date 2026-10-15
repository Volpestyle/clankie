import type { ProjectHiringPolicy } from "@clankie/protocol/projects";
import { accountTier, allocateAccounts } from "./account-allocation.ts";
import type { MachineWorkerAccounts, WorkerAccountStatus } from "./harness-accounts.ts";

/** A reserve for already-running work; reaching it stops new subscription hires. */
export const HIRE_PLAN_RESERVE = 0.1;
export function hirePlanKey(account: WorkerAccountStatus): string | undefined {
  const tier = accountTier(account);
  return tier === undefined ? undefined : `${account.harness}:${tier}`;
}

/** Observations, not a caller's claimed balance, decide admission. Existing seats are unaffected. */
export function hireAdmissionReport(
  report: MachineWorkerAccounts,
  policy: ProjectHiringPolicy | undefined,
  models: readonly string[],
  now = Date.now(),
): MachineWorkerAccounts {
  const allocation = allocateAccounts(report, now);
  const stale =
    !Number.isFinite(Date.parse(report.observedAt)) ||
    now - Date.parse(report.observedAt) > 5 * 60_000 ||
    Date.parse(report.observedAt) > now + 60_000;
  const accounts = report.accounts.map((account): WorkerAccountStatus => {
    const plan = hirePlanKey(account);
    const usageAt = Date.parse(account.usage?.observedAt ?? "");
    const staleUsage = !Number.isFinite(usageAt) || now - usageAt > 5 * 60_000 || usageAt > now + 60_000;
    const measured = allocation.accounts.find(
      (entry) => entry.harness === account.harness && entry.label === account.label,
    );
    const reason = account.held
      ? "held by the owner"
      : models.some((model) => policy?.excludedModels?.includes(model))
        ? "model excluded by project"
        : policy?.allowedPlans && (plan === undefined || !policy.allowedPlans.includes(plan))
          ? "plan not allowed by project"
          : plan !== undefined && policy?.excludedPlans?.includes(plan)
            ? "plan excluded by project"
            : stale || staleUsage
              ? "usage observation is stale or unavailable"
              : measured?.remaining == null
                ? "remaining plan usage was not observed"
                : measured.remaining <= HIRE_PLAN_RESERVE
                  ? `plan is near its limit (${Math.round(measured.remaining * 100)}% remaining; 10% reserved for running work)`
                  : undefined;
    return reason === undefined ? account : { ...account, usable: false, reason };
  });
  const filtered = { ...report, accounts };
  return { ...filtered, allocation: allocateAccounts(filtered, now) };
}

/** Across harnesses, compare remaining plan capacity per day, using the existing observed-plan allocator. */
export function hireAdmissionChoice(
  report: MachineWorkerAccounts,
  harness?: string,
  label?: string,
  now = Date.now(),
) {
  const allocation = allocateAccounts(report, now);
  const candidates = allocation.accounts.filter(
    (entry) =>
      entry.eligible &&
      entry.remaining !== null &&
      (harness === undefined || entry.harness === harness) &&
      (label === undefined ||
        report.accounts.some(
          (account) =>
            account.harness === entry.harness &&
            account.label === entry.label &&
            (account.label === label ||
              account.accountKey === (report.accountAliases?.[`${entry.harness}:${label}`] ?? label) ||
              account.identity === label ||
              account.aliases?.includes(label)),
        )),
  );
  candidates.sort(
    (a, b) =>
      (b.sparePerDay ?? -Infinity) - (a.sparePerDay ?? -Infinity) || (b.remaining ?? 0) - (a.remaining ?? 0),
  );
  const selected = candidates[0];
  if (!selected)
    throw new Error(
      `No observed plan can take this hire: ${report.accounts.map((account) => `${account.harness}/${account.label}: ${account.reason ?? "ineligible"}`).join("; ")}`,
    );
  const account = report.accounts.find(
    (account) => account.harness === selected.harness && account.label === selected.label,
  )!;
  return {
    account,
    plan: hirePlanKey(account) ?? `${account.harness}:unknown`,
    remaining: selected.remaining!,
    reason: selected.reason,
  };
}
