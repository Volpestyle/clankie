import { basename } from "node:path";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { OperatorConversationIdSchema } from "@clankie/protocol";
import { commandHost } from "./io.ts";
import type { SeatCommandOptions } from "./seat.ts";

export interface NewSeatConversation {
  readonly op: "create";
  readonly schemaVersion: 1;
  readonly scope: { readonly kind: "workspace"; readonly workspaceId: string };
  readonly title: string;
}

/** Each new native seat owns a chat; planning a launch never creates one. */
export async function resolveSeatContext(
  input: { conversationId?: string | undefined; cwd: string; command: string; dryRun: boolean },
  options: SeatCommandOptions,
): Promise<{ conversationId?: string; cwd: string; newConversation?: NewSeatConversation }> {
  const newConversation: NewSeatConversation = {
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: input.cwd },
    title: `Clankie ${input.command} · ${basename(input.cwd).slice(0, 64)} · ${new Date().toISOString()}`,
  };
  if (input.conversationId === undefined && input.dryRun) return { cwd: input.cwd, newConversation };
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) throw new Error("No operator credential is available; start Clankie first.");
  const url = new URL("/v1/captain/seat-context", commandHost({ ...options, env }));
  if (input.conversationId !== undefined) url.searchParams.set("conversationId", input.conversationId);
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: {
      authorization: `Bearer ${credential.token}`,
      ...(input.conversationId === undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.conversationId === undefined ? { method: "POST", body: JSON.stringify(newConversation) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Seat conversation unavailable (${response.status})`);
  const binding = (await response.json()) as { conversationId?: unknown; cwd?: unknown };
  const id = OperatorConversationIdSchema.safeParse(binding.conversationId);
  if (
    !id.success ||
    (input.conversationId !== undefined && id.data !== input.conversationId) ||
    typeof binding.cwd !== "string" ||
    !binding.cwd
  )
    throw new Error("Invalid service seat context");
  return { conversationId: id.data, cwd: binding.cwd };
}
