export const leadPlugin: "clankie-remote-lead@clankie-remote-leads";
export function prepareClaude(
  executable: string,
  plugin: string,
  options?: { env?: NodeJS.ProcessEnv; home?: string; policyPath?: string },
): Promise<string>;
