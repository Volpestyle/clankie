interface CatalogTool {
  name: string;
  [key: string]: unknown;
}
export function createCatalogWatcher(input: {
  list(): Promise<readonly CatalogTool[]>;
  notify(): Promise<void>;
}): {
  observe(tools: readonly CatalogTool[]): void;
  check(): Promise<void>;
};
export function signalCodexCatalog(path?: string): Promise<void>;
