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

export const WorkerAccountStatusSchema = z.object({
  harness: WorkerAccountHarnessSchema,
  label: z.string(),
  /** The profile home on its own machine. */
  home: z.string(),
  signedIn: z.boolean().nullable(),
  /** The account's email as its CLI reports it; never a token. */
  identity: z.string().optional(),
  plan: z.string().optional(),
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
  reason: z.string().optional(),
});
export type WorkerAccountStatus = z.infer<typeof WorkerAccountStatusSchema>;

export const MachineWorkerAccountsSchema = z.object({
  machine: z.string(),
  shell: z.enum(["posix", "powershell"]),
  observedAt: z.string(),
  accounts: z.array(WorkerAccountStatusSchema).max(256),
  /** A harness the machine could not answer for, with why. */
  unavailable: z.partialRecord(WorkerAccountHarnessSchema, z.string()).optional(),
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
 * through each harness's own CLI. `GET /v1/usage`, owner credential.
 */
export const USAGE_PATH = "/v1/usage";
export const USAGE_SETTINGS_PATH = "/v1/usage/settings";

export const UsageAccountSchema = z.object({
  harness: z.enum(["claude", "codex"]),
  label: z.string(),
  identity: z.string().optional(),
  plan: z.string().optional(),
  signedIn: z.boolean().nullable(),
  /** Same meaning as the worker-account field. */
  headroom: z.number().min(0).max(1).nullable(),
  usage: AccountUsageSchema.optional(),
  /** Seconds between `usage.observedAt` and this response. */
  ageSeconds: z.number().int().min(0).optional(),
  held: z.object({ reason: z.string().optional() }).optional(),
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
});
export type UsageSettingsSnapshot = z.infer<typeof UsageSettingsSnapshotSchema>;

export const UpdateUsageSettingsSchema = z
  .object({
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    display: UsageDisplaySettingsSchema.partial().refine(
      (value) => Object.values(value).some((entry) => entry !== undefined),
      "No usage display change",
    ),
  })
  .strict();
export type UpdateUsageSettings = z.infer<typeof UpdateUsageSettingsSchema>;

export const UsageReportSchema = z.object({
  schemaVersion: z.literal(1),
  machine: z.string(),
  observedAt: z.iso.datetime(),
  accounts: z.array(UsageAccountSchema).max(64),
  unavailable: z.partialRecord(z.enum(["claude", "codex"]), z.string()).optional(),
  settings: UsageSettingsSnapshotSchema,
});
export type UsageReport = z.infer<typeof UsageReportSchema>;

/** Shared wording for every surface that shows the meters. */
export const USAGE_WORDING = {
  title: "Usage",
  summary: "How much each Claude and Codex account has left, as each harness reports it.",
  overlay: {
    label: "Show usage beside Clankie",
    description: "Compact meters under the desktop pet. Click them for detail.",
  },
  left: "left",
  resets: "resets",
  unknown: "Not reported",
  stale: "Last read",
} as const;
