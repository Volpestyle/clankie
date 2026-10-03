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
    registered: boolean;
    pluginInstalled: boolean;
    enabled: boolean;
    version: string | null;
    expectedVersion: string | null;
    versionMatches: boolean | null;
    configPath: string;
    configSource: string;
    skill: boolean;
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
