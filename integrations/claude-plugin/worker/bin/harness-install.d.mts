export type HarnessInstallTarget = "claude" | "codex";
export interface HarnessInstallResult {
  harness: HarnessInstallTarget;
  profile?: string;
  status:
    | "installed"
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
  codexSourceSetup?: { command: string; args: readonly string[] };
}): Promise<HarnessInstallResult[]>;
