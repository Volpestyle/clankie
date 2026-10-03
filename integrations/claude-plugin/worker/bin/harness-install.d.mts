export type HarnessInstallTarget = "claude" | "codex";
export interface HarnessInstallResult {
  harness: HarnessInstallTarget;
  profile?: string;
  status:
    | "installed"
    | "updated"
    | "source-setup-completed"
    | "declined"
    | "absent"
    | "source-manager-required"
    | "failed";
  detail: string;
}
export function installHarnessBridges(options: {
  repoRoot?: string;
  marketplaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  consent(harness: HarnessInstallTarget, detail: string): Promise<boolean>;
  execute?(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<unknown>;
  prepareSkills?(workerRoot: string): Promise<void>;
  codexSourceSetup?: { command: string; args: readonly string[] };
}): Promise<HarnessInstallResult[]>;

/** Read-only confirmation using native exit metadata and fresh settings from the same profile. */
export function confirmClaudeWorkerEnabled(
  error: unknown,
  options: {
    profile: string;
    source: string;
    configBefore: string | undefined;
  },
): Promise<boolean>;
