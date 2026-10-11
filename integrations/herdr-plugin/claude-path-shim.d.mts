export function installPaneShell(options: {
  root: string;
  socketPath: string;
  owner?: NodeJS.ProcessEnv;
  restore?: NodeJS.ProcessEnv;
}): Promise<string>;
export function preparePaneShell(options: {
  root: string;
  socketPath: string;
  configPath: string;
  owner?: NodeJS.ProcessEnv;
  action?: "install" | "remove";
}): Promise<{ action: string; configPath: string; canonical: string; paneShell: string; changed: boolean }>;
export function inspectPaneShim(options: {
  root: string;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  installed: boolean;
  configured: boolean;
  active: boolean;
  paneShell: string;
  state: string;
  detail: string;
}>;
