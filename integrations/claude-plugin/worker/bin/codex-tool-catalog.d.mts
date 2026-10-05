export interface CodexToolCatalogReport {
  schemaVersion: 1;
  harness: "codex";
  sessionId: string;
  bridge: "worker" | "operator";
  tools: string[];
  checkedAt: string;
  error?: string;
}

/** Never starts or resumes a thread; reads only its already loaded runtime. */
export function codexToolCatalogReport(input: {
  sessionId: string;
  bridge?: "worker" | "operator";
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}): Promise<CodexToolCatalogReport>;
