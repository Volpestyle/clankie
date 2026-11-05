export function readHookResponse(
  response: Response,
  notice: (message: string) => void,
): Promise<{ hookOutput?: { hookSpecificOutput: unknown; requestId?: string } }>;
