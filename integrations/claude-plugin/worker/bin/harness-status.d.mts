/** Where a settings entry keeps an old Claude worker copy that only its owner may drop. */
export interface OldClaudeWorkerKeeper {
  scope: "profile" | "project";
  project?: string;
  settings: string;
}
export function oldClaudeWorker(profile: string): Promise<{
  found: boolean;
  worker: boolean;
  projects: string[];
  marketplace: boolean;
  keptBy: OldClaudeWorkerKeeper[];
  settings?: unknown;
}>;
export function claudeProfileDirectories(env?: NodeJS.ProcessEnv): Promise<string[]>;
export function inspectHarnessProfiles(options?: {
  env?: NodeJS.ProcessEnv;
  expectedVersion?: string;
  execute?: (command: string, args: string[]) => Promise<string>;
}): Promise<{
  machine: { platform: string; home: string };
  claude: ReadonlyArray<{
    profile: string;
    executable: boolean;
    installed: boolean;
    enabled: boolean;
    version: string | null;
    expectedVersion: string | null;
    versionMatches: boolean | null;
    bridge: boolean;
    legacyServerName: boolean;
    hooks: boolean;
    skill: boolean;
    liveReceiver: string;
  }>;
  codex: {
    executable: boolean;
    executablePath: string | null;
    executableDetail: string;
    registered: boolean;
    registration: string;
    registrationIdentityForwarding: boolean;
    bridge: boolean;
    identityForwarding: boolean;
    pluginInstalled: boolean;
    enabled: boolean;
    version: string | null;
    expectedVersion: string | null;
    versionMatches: boolean | null;
    configPath: string;
    configSource: string;
    sourceSetup?: { state: string; detail?: string; fix?: string };
    skill: boolean;
    bridgeTools: string[] | null;
    replies: string;
    liveReceiver: string;
  };
  otherHarnesses: ReadonlyArray<{
    harness: string;
    executable: boolean;
    registration: string;
    detail: string;
  }>;
}>;
