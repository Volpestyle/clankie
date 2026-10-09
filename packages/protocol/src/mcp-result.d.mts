export function decodeMcpResult(result: unknown): unknown;
export function readableMcpResult<
  T extends {
    content: { type: string; text?: string }[];
    structuredContent?: Record<string, unknown> | undefined;
    isError?: boolean | undefined;
  },
>(result: T, name?: string): T & { structuredContent?: Record<string, unknown> | undefined };
