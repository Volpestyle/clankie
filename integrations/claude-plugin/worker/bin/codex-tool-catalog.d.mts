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
  /** Require a connected exact-thread server even when its expected projection is empty. */
  requireConnected?: boolean;
  /** Complete, unambiguous original-thread runtime observation, never worker input. */
  onServerStatus?: (status: { runtimeStatus?: string; toolsError?: string }) => void;
  request?: (method: string, params: Record<string, unknown>) => Promise<unknown>;
}): Promise<CodexToolCatalogReport>;
