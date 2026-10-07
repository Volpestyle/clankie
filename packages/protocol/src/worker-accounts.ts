import { z } from "zod";

/**
 * Worker accounts on one machine (VUH-1780): what each Claude profile or Codex
 * home can do now, and the owner's holds that set one aside from Clankie's
 * automatic choice. An explicit hire may still name a held account.
 */
export const WORKER_ACCOUNTS_PATH = "/v1/worker-accounts";
export const WORKER_ACCOUNT_HOLDS_PATH = "/v1/worker-accounts/holds";

export const WorkerAccountHarnessSchema = z.enum(["claude", "codex"]);
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

export const WorkerAccountStatusSchema = z.object({
  harness: WorkerAccountHarnessSchema,
  label: z.string(),
  /** The profile home on its own machine. */
  home: z.string(),
  signedIn: z.boolean().nullable(),
  /** The account's email as its CLI reports it; never a token. */
  identity: z.string().optional(),
  plan: z.string().optional(),
  /** Codex: lowest remaining fraction of its usage windows; null when unobservable (always for Claude). */
  headroom: z.number().min(0).max(1).nullable(),
  resetsAt: z.string().optional(),
  workerPlugin: z.boolean().optional(),
  held: z.object({ reason: z.string().optional() }).optional(),
  /** Whether Clankie would hire on it now, and why not. */
  usable: z.boolean(),
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
export const WorkerAccountHoldsSchema = z.object({ holds: z.array(WorkerAccountHoldSchema).max(64) });
export type WorkerAccountHolds = z.infer<typeof WorkerAccountHoldsSchema>;

/** Shared wording for the TUI, app and dashboard, in the owner's words. */
export const WORKER_ACCOUNTS_WORDING = {
  title: "Worker accounts",
  summary:
    "The Claude and Codex sign-ins on each machine. Clankie picks one with usage left for each new worker; set one aside to keep him off it.",
  setAside: "Set aside",
  useAgain: "Use again",
  setAsideState: "Set aside",
  setAsideDetail: "Clankie won't pick it on his own. A worker you start on it by name can still use it.",
  ready: "Ready",
  thisMachine: "This machine",
} as const;
