interface CatalogTool {
  name: string;
  [key: string]: unknown;
}
export function createCatalogWatcher(input: {
  list(): Promise<readonly CatalogTool[]>;
  notify(): Promise<void>;
  /** Authenticated runtime identity also changes when schemas remain equal. */
  revision?(): string | undefined;
}): {
  observe(tools: readonly CatalogTool[]): void;
  check(): Promise<void>;
};
export function signalCodexCatalog(path?: string): Promise<void>;
