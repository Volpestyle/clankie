export function readCandidatePatch(
  cwd: string,
  baseRef?: string,
): { base: string; head: string; patch: Buffer; patchId: string; dirty: boolean };
export const REVIEW_TOOLS: readonly { name: string; description: string; inputSchema: object }[];
export function createReviewTools(options: {
  request: (route: string, suffix?: string, init?: RequestInit) => Promise<Response>;
  cwd?: () => string;
  patchDirectory?: string;
}): Record<"submit" | "read" | "verdict", (args: unknown) => Promise<unknown>>;
