import type { ClankieApiClient } from "@clankie/api-client";
import type { CaptainFileReadResult, CaptainShellRunResult } from "@clankie/protocol";

/**
 * The captain's side of his shell
 * ([ADR 0086](../../../docs/adr/0086-clankie-holds-a-shell.md)).
 *
 * A control plane that is down, a runner without a sandbox, and a doctrine
 * profile that denies the action all arrive at the model as the same shape: a
 * refusal with a reason he can say. They are deliberately not thrown, because a
 * thrown tool reads to a model as "something broke" and invites a retry, where
 * "I am not allowed to do that" is an answer he can give and move on from.
 */
export async function runShell(
  client: ClankieApiClient,
  command: string,
  timeoutMs?: number,
): Promise<CaptainShellRunResult> {
  try {
    return await client.runCaptainShell({
      schemaVersion: 1,
      command,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  } catch (error) {
    return { outcome: "refused", reason: "shell_unavailable", detail: reason(error) };
  }
}

export async function readHostFile(
  client: ClankieApiClient,
  request: { path: string; offset?: number | undefined; limit?: number | undefined },
): Promise<CaptainFileReadResult> {
  try {
    return await client.readCaptainFile({ schemaVersion: 1, ...request });
  } catch (error) {
    return { outcome: "refused", reason: "shell_unavailable", detail: reason(error) };
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : "the shell host was unreachable";
}
