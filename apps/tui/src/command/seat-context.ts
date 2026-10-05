import { basename } from "node:path";
import { resolveCaptainCredential, resolveOperatorCredential } from "@clankie/credential-broker";
import { OperatorConversationIdSchema } from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
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
  const fetchImpl = options.fetchImpl ?? fetch;
  let expectedId = input.conversationId;
  const request: RequestInit = {
    headers: {
      authorization: `Bearer ${credential.token}`,
      ...(input.conversationId === undefined ? { "content-type": "application/json" } : {}),
    },
    ...(input.conversationId === undefined ? { method: "POST", body: JSON.stringify(newConversation) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  };
  let response = await fetchImpl(url, request);
  if (response.status === 404 && input.conversationId !== undefined) {
    // An exact ID is the fast path. Resolve only a definite miss through the
    // same authenticated discovery contract `conversations show` already uses.
    const captain = await resolveCaptainCredential({ env });
    if (captain === undefined)
      throw new Error("Use an exact conversation ID from clankie conversations list.");
    const client = createCaptainOperatorConversationClient(
      createCaptainRouteClient({
        host: commandHost({ ...options, env }),
        captainToken: captain.token,
        fetchImpl,
      }),
    );
    const conversations = await client.list();
    const exact = conversations.find((item) => item.conversationId === input.conversationId);
    const matches =
      exact === undefined
        ? conversations.filter(
            (item) =>
              item.title === input.conversationId ||
              (item.scope.kind === "room" &&
                item.roomHandoff === undefined &&
                (item.scope.targetId === input.conversationId ||
                  item.scope.targetId.split(":").at(-1) === input.conversationId)),
          )
        : [exact];
    if (matches.length !== 1) throw new Error("Choose one conversation ID from clankie conversations list.");
    expectedId = matches[0]!.conversationId;
    url.searchParams.set("conversationId", expectedId);
    response = await fetchImpl(url, { ...request, signal: AbortSignal.timeout(10000) });
  }
  if (!response.ok) throw new Error(`Seat conversation unavailable (${response.status})`);
  const binding = (await response.json()) as { conversationId?: unknown; cwd?: unknown };
  const id = OperatorConversationIdSchema.safeParse(binding.conversationId);
  if (
    !id.success ||
    (expectedId !== undefined && id.data !== expectedId) ||
    typeof binding.cwd !== "string" ||
    !binding.cwd
  )
    throw new Error("Invalid service seat context");
  return { conversationId: id.data, cwd: binding.cwd };
}
