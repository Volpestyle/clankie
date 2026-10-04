export function startFixtureServer(
  directory: string,
  options?: { port?: number; onFirstInput?: () => Promise<void> },
): Promise<{ url: string; state(): Promise<Record<string, unknown>>; close(): Promise<void> }>;
