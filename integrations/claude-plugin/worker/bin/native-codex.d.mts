/** Native executable discovery only; never runs a launcher or admits an agent identity. */
export function nativeCodexExecutable(options?: {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  canonical?: (path: string) => Promise<string>;
}): Promise<string>;
