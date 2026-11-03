export type HarnessInstallTarget = "claude" | "codex";
/** Captured native setup inputs; consent does not confer a machine or workspace grant. */
export interface HarnessInstallConsentContext {
  profile: string;
  source: string;
  managed: boolean;
  /** Projects whose project-scoped copy the removal uninstalls from inside each one. */
  projects?: readonly string[];
  sourceSetup?: { command: string; args: readonly string[] };
}
export interface HarnessInstallResult {
  harness: HarnessInstallTarget;
  profile?: string;
  status:
    | "installed"
    | "updated"
    | "source-setup-completed"
    /** An older installed Claude worker copy was removed (ADR 0317). */
    | "removed"
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
  /** Refresh only existing links; never opt a new profile in. Claude profiles only lose an older worker copy. */
  linkedOnly?: boolean;
  codexHomes?: readonly string[];
  /** Results of a refresh that just ran; profiles it completed are not asked about again. */
  refreshed?: readonly HarnessInstallResult[];
  consent(
    harness: HarnessInstallTarget,
    detail: string,
    context?: HarnessInstallConsentContext,
  ): Promise<boolean>;
  /** `cwd` is set only where a native command acts on one project (a project-scoped uninstall). */
  execute?(command: string, args: readonly string[], env?: NodeJS.ProcessEnv, cwd?: string): Promise<unknown>;
  prepareSkills?(workerRoot: string): Promise<void>;
  codexSourceSetup?: { command: string; args: readonly string[] };
}): Promise<HarnessInstallResult[]>;

export function codexSourceSetupCommand(
  script: string,
  options?: { platform?: NodeJS.Platform; node?: string },
): { command: string; args: string[] };
