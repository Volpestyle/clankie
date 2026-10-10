import { z } from "zod";

/**
 * Worker accounts on one machine (VUH-1780): what each Claude profile or Codex
 * home can do now, and the owner's holds that set one aside from Clankie's
 * automatic choice. An explicit hire may still name a held account.
 */
export const WORKER_ACCOUNTS_PATH = "/v1/worker-accounts";
export const WORKER_ACCOUNT_HOLDS_PATH = "/v1/worker-accounts/holds";

export const WorkerAccountHarnessSchema = z.enum(["claude", "codex", "pi"]);
export type WorkerAccountHarness = z.infer<typeof WorkerAccountHarnessSchema>;
/** Prime Agent's providers are read and shown, never held or allocated. */
const ReportedHarnessSchema = z.enum([...WorkerAccountHarnessSchema.options, "prime"]);
/** `local` (the body's own machine) or a runtime connection id. */
export const WorkerAccountMachineSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const WorkerAccountLabelSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

/** The one query `GET /v1/worker-accounts` accepts; anything else carries no authority. */
export function workerAccountsRoute(machine?: string): string {
  return machine === undefined || machine === "local"
    ? WORKER_ACCOUNTS_PATH
    : `${WORKER_ACCOUNTS_PATH}?fleet=${WorkerAccountMachineSchema.parse(machine)}`;
}
export function isWorkerAccountsRoute(route: string): boolean {
  return route === WORKER_ACCOUNTS_PATH || /^\/v1\/worker-accounts\?fleet=[a-z][a-z0-9-]{0,63}$/u.test(route);
}

/**
 * One usage limit as the harness itself reports it (VUH-1961): Claude's
 * `/usage` lines or Codex's rate-limit windows. `usedPercent` is the vendor's
 * figure; a missing reset is unknown, never "no reset".
 */
export const UsageWindowSchema = z.object({
  /** `session` (Claude's five-hour session or Codex's short window), `week`, or `week:<scope>` for a model-scoped week. */
  id: z.string().regex(/^(?:session|week)(?::[a-z0-9][a-z0-9_.-]{0,63})?$/u),
  /** The harness's own name for it, e.g. "Current week (Fable)". */
  label: z.string().min(1).max(96),
  usedPercent: z.number().min(0).max(100),
  windowMinutes: z.number().int().positive().optional(),
  resetsAt: z.iso.datetime().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** Where a usage reading came from and when; the windows are only as fresh as `observedAt`. */
export const AccountUsageSchema = z.object({
  /** `claude-usage`: the profile's own `claude -p /usage`. `codex-rate-limits`: Codex's app-server `account/rateLimits/read`. */
  source: z.enum(["claude-usage", "codex-rate-limits"]),
  observedAt: z.iso.datetime(),
  windows: z.array(UsageWindowSchema).max(16),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

const PrimeSpendPeriodSchema = z.object({ costUsd: z.number().min(0), tokens: z.number().int().min(0) });
/**
 * What a Prime Agent API key spent (VUH-1556), summed from Prime's own session
 * transcripts. `costUsd` is Prime's per-message estimate at list price.
 */
export const PrimeSpendSchema = z.object({
  source: z.literal("prime-transcripts"),
  observedAt: z.iso.datetime(),
  /** Since local midnight on the reading machine. */
  today: PrimeSpendPeriodSchema,
  /** The last seven days. */
  week: PrimeSpendPeriodSchema,
});
export type PrimeSpend = z.infer<typeof PrimeSpendSchema>;
/** Prime Agent fields shared by worker accounts and usage. */
const PrimeAccountFields = {
  /** How this provider is signed in to Prime; never the credential. Absent when Prime has no record of it. */
  credential: z.enum(["api_key", "subscription"]).optional(),
  /** An API key's spend. */
  spend: PrimeSpendSchema.optional(),
  /** The registered account whose limits this subscription draws from; its usage is that account's. */
  sharesLimitsWith: z.object({ harness: z.enum(["claude", "codex"]), label: z.string() }).optional(),
};

export const WorkerAccountStatusSchema = z.object({
  harness: ReportedHarnessSchema,
  label: z.string(),
  /** The profile home on its own machine. */
  home: z.string(),
  signedIn: z.boolean().nullable(),
  /** The account's email as its CLI reports it; never a token. */
  identity: z.string().optional(),
  plan: z.string().optional(),
  /** The plan's rate-limit tier as the harness caches it for this sign-in, e.g. `default_claude_max_20x`. */
  tier: z.string().max(64).optional(),
  /** Lowest remaining fraction of the account's all-model usage windows; null when unobserved. */
  headroom: z.number().min(0).max(1).nullable(),
  resetsAt: z.string().optional(),
  /** The windows behind `headroom`, with their source and observation time; absent when unobserved. */
  usage: AccountUsageSchema.optional(),
  workerPlugin: z.boolean().optional(),
  held: z.object({ reason: z.string().optional() }).optional(),
  /** Whether Clankie would hire on it now, and why not. */
  usable: z.boolean(),
  /** Pi: verified models in this native profile, not credentials. */
  models: z.array(z.string()).max(2048).optional(),
  ...PrimeAccountFields,
  reason: z.string().optional(),
});
export type WorkerAccountStatus = z.infer<typeof WorkerAccountStatusSchema>;

/**
 * How Clankie would spread hires over one machine's Claude and Codex accounts
 * (VUH-1974). Each account's spare capacity per day is its plan weight times
 * (the fraction left of a window divided by the days until that window resets,
 * minus the share it has been using per day), at its tightest all-model
 * window. Positive spare goes unused at reset unless hired on; negative means
 * it is projected to run out first. Model-scoped windows (`week:<scope>`)
 * bound only hires on that model, so they are named but never rank.
 */
export const AccountAllocationSchema = z.object({
  harness: z.enum(["claude", "codex"]),
  label: z.string(),
  /**
   * Plan size against the harness's base plan (Claude Max 5x = 1, Max 20x = 4,
   * Pro = 0.2; Codex Plus = 1, Pro = 6), from what the harness reports; null
   * when it reported no tier, which then counts as 1.
   */
  planWeight: z.number().positive().nullable(),
  /** The plan as named, e.g. `max_20x`; absent when unreported. */
  tier: z.string().max(64).optional(),
  /** Whether Clankie may pick it on his own: usable and not held. */
  eligible: z.boolean(),
  /** 1 is the next automatic hire on this harness; absent when not eligible. */
  rank: z.number().int().positive().optional(),
  /** Fraction left of the tightest all-model window; null when usage is unknown. */
  remaining: z.number().min(0).max(1).nullable(),
  /** Spare capacity per day in base-plan units; null when usage is unknown. */
  sparePerDay: z.number().nullable(),
  /** The all-model window that binds, by `UsageWindow.id`. */
  window: z.string().optional(),
  /** Percent of that window used per day so far; absent until 5% of it has passed. */
  burnPerDay: z.number().min(0).optional(),
  resetsAt: z.iso.datetime().optional(),
  /** When a window runs out at that pace, if before its reset (all-model or scoped). */
  runsOut: z
    .array(
      z.object({ window: z.string(), label: z.string(), at: z.iso.datetime(), resetsAt: z.iso.datetime() }),
    )
    .max(16)
    .optional(),
  /** One line in the owner's words. */
  reason: z.string().max(400),
});
export type AccountAllocation = z.infer<typeof AccountAllocationSchema>;

export const AllocationRecommendationSchema = z.object({
  harness: z.enum(["claude", "codex"]),
  /** The account the next automatic hire on this harness takes; absent when none can. */
  label: z.string().optional(),
  /** E.g. "next Claude hire → volpestyle: Max 20x, 99% of its week left, 4.3 days to reset". */
  reason: z.string().max(600),
});
export type AllocationRecommendation = z.infer<typeof AllocationRecommendationSchema>;

export const MachineAllocationSchema = z.object({
  accounts: z.array(AccountAllocationSchema).max(64),
  recommendations: z.array(AllocationRecommendationSchema).max(2),
});
export type MachineAllocation = z.infer<typeof MachineAllocationSchema>;

/** The owner's thresholds for allocation warnings (settings `usage`). */
export const UsageAllocationSettingsSchema = z
  .object({
    /** Wake the lead once when a weekly window is projected to run out before it resets. */
    runOutWarning: z.boolean(),
    /** ...and only when the projected run-out is at least this many hours before the reset. */
    runOutWarningHours: z.number().min(0).max(168),
  })
  .strict();
export type UsageAllocationSettings = z.infer<typeof UsageAllocationSettingsSchema>;
export const USAGE_ALLOCATION_DEFAULTS: UsageAllocationSettings = {
  runOutWarning: true,
  runOutWarningHours: 12,
};

export const MachineWorkerAccountsSchema = z.object({
  machine: z.string(),
  shell: z.enum(["posix", "powershell"]),
  observedAt: z.string(),
  accounts: z.array(WorkerAccountStatusSchema).max(256),
  /** A harness the machine could not answer for, with why. */
  unavailable: z.partialRecord(ReportedHarnessSchema, z.string()).optional(),
  /** How Clankie would spread hires over these accounts now. */
  allocation: MachineAllocationSchema.optional(),
});
export type MachineWorkerAccounts = z.infer<typeof MachineWorkerAccountsSchema>;

export const WorkerAccountHoldSchema = z
  .object({
    machine: WorkerAccountMachineSchema,
    harness: WorkerAccountHarnessSchema,
    label: WorkerAccountLabelSchema,
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type WorkerAccountHold = z.infer<typeof WorkerAccountHoldSchema>;

/** `POST /v1/worker-accounts/holds`: hold (`held: true`) or release one account. */
export const WorkerAccountHoldRequestSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    machine: WorkerAccountMachineSchema.default("local"),
    harness: WorkerAccountHarnessSchema,
    label: WorkerAccountLabelSchema,
    held: z.boolean(),
    /** Only with `held: true`. */
    reason: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.held || value.reason === undefined, "A release carries no reason");
export type WorkerAccountHoldRequest = z.input<typeof WorkerAccountHoldRequestSchema>;
export const WorkerAccountHoldsSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  holds: z.array(WorkerAccountHoldSchema).max(64),
});
export type WorkerAccountHolds = z.infer<typeof WorkerAccountHoldsSchema>;

/** Shared wording for the TUI, app and dashboard, in the owner's words. */
export const WORKER_ACCOUNTS_WORDING = {
  title: "Worker accounts",
  summary:
    "The Claude and Codex sign-ins and verified Pi profile on each machine. Clankie picks one that can work; set one aside to keep him off it.",
  setAside: "Set aside",
  useAgain: "Use again",
  setAsideState: "Set aside",
  setAsideDetail: "Clankie won't pick it on his own. A worker you start on it by name can still use it.",
  ready: "Ready",
  thisMachine: "This computer",
} as const;

/**
 * Usage meters (VUH-1961): this machine's registered Claude and Codex
 * accounts with how much of each limit is left and when it resets, read
 * through each harness's own CLI, and Prime Agent's providers: an API key's
 * spend, or the account whose limits a subscription draws from (VUH-1556).
 * `GET /v1/usage`, owner credential.
 */
export const USAGE_PATH = "/v1/usage";
export const USAGE_SETTINGS_PATH = "/v1/usage/settings";

export const UsageAccountSchema = z.object({
  harness: z.enum(["claude", "codex", "prime"]),
  label: z.string(),
  identity: z.string().optional(),
  plan: z.string().optional(),
  /** Claude's rate-limit tier as the profile itself last fetched it (e.g. `default_claude_max_20x`); absent when unknown. */
  tier: z.string().max(96).optional(),
  signedIn: z.boolean().nullable(),
  /** Same meaning as the worker-account field. */
  headroom: z.number().min(0).max(1).nullable(),
  usage: AccountUsageSchema.optional(),
  /** Seconds between `usage.observedAt` and this response. */
  ageSeconds: z.number().int().min(0).optional(),
  held: z.object({ reason: z.string().optional() }).optional(),
  ...PrimeAccountFields,
  /** Why usage is unknown or the account cannot take work. */
  reason: z.string().optional(),
});
export type UsageAccount = z.infer<typeof UsageAccountSchema>;

export const UsageDisplaySettingsSchema = z
  .object({
    /** Show the meters beside Clankie in the desktop overlay. */
    overlay: z.boolean(),
  })
  .strict();
export type UsageDisplaySettings = z.infer<typeof UsageDisplaySettingsSchema>;

export const UsageSettingsSnapshotSchema = z.object({
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
  display: UsageDisplaySettingsSchema,
  /** Absent from bodies older than VUH-1974. */
  allocation: UsageAllocationSettingsSchema.optional(),
});
export type UsageSettingsSnapshot = z.infer<typeof UsageSettingsSnapshotSchema>;

export const UpdateUsageSettingsSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    display: UsageDisplaySettingsSchema.partial().optional(),
    allocation: UsageAllocationSettingsSchema.partial().optional(),
  })
  .strict()
  .refine(
    (value) =>
      [...Object.values(value.display ?? {}), ...Object.values(value.allocation ?? {})].some(
        (entry) => entry !== undefined,
      ),
    "No usage settings change",
  );
export type UpdateUsageSettings = z.infer<typeof UpdateUsageSettingsSchema>;

export const UsageReportSchema = z.object({
  schemaVersion: z.literal(1),
  machine: z.string(),
  observedAt: z.iso.datetime(),
  accounts: z.array(UsageAccountSchema).max(64),
  unavailable: z.partialRecord(z.enum(["claude", "codex", "prime"]), z.string()).optional(),
  settings: UsageSettingsSnapshotSchema,
  /** Where the next automatic hires go and why (VUH-1974); absent from older bodies. */
  allocation: MachineAllocationSchema.optional(),
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

/** Shared wording for every surface that shows the meters. */
export const USAGE_WORDING = {
  title: "Usage",
  summary:
    "How much each Claude and Codex account has left, as each harness reports it, and what Prime Agent's API keys spent.",
  overlay: {
    label: "Show usage beside Clankie",
    description: "Compact meters above the desktop pet. Click them for detail.",
  },
  left: "left",
  resets: "resets",
  unknown: "Not reported",
  stale: "Last read",
  nextHire: "Next hire",
  runOutWarning: {
    label: "Warn when an account will run out",
    description:
      "Clankie tells his lead once when an account's weekly limit is on pace to run out this many hours or more before it resets.",
  },
} as const;

/**
 * The plan as the owner names it: Claude's tier when the profile reported one
 * (`default_claude_max_20x` → "Max 20x"), otherwise the harness's plan
 * ("max" → "Max", "pro" → "Pro"). Unknown stays unknown.
 */
export function usagePlanLabel(account: {
  plan?: string | undefined;
  tier?: string | undefined;
}): string | undefined {
  const tier = /^(?:default_)?claude_(max|pro|team|enterprise)(?:_(\d+x))?$/u.exec(account.tier ?? "");
  if (tier) return `${tier[1]![0]!.toUpperCase()}${tier[1]!.slice(1)}${tier[2] ? ` ${tier[2]}` : ""}`;
  const plan = account.plan?.trim();
  return plan ? `${plan[0]!.toUpperCase()}${plan.slice(1)}` : undefined;
}
