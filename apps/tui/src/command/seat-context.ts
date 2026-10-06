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

export const GLOBAL_CONVERSATION_ID = "global-default";

/**
 * A new native seat without a selection takes the global chat while no live
 * seat holds it, and otherwise owns a fresh workspace chat; `fresh` asks for
 * the workspace chat outright. Planning a launch never creates one.
 */
export async function resolveSeatContext(
  input: {
    conversationId?: string | undefined;
    fresh?: boolean;
    cwd: string;
    command: string;
    dryRun: boolean;
  },
  options: SeatCommandOptions,
): Promise<{ conversationId?: string; cwd: string; newConversation?: NewSeatConversation }> {
  const newConversation: NewSeatConversation = {
    op: "create",
    schemaVersion: 1,
    scope: { kind: "workspace", workspaceId: input.cwd },
    title: `Clankie ${input.command} · ${basename(input.cwd).slice(0, 64)} · ${new Date().toISOString()}`,
  };
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (input.conversationId === undefined && !input.fresh) {
    if (credential === undefined)
      throw new Error("No operator credential is available; start Clankie first.");
    const url = new URL("/v1/captain/seat-context", commandHost({ ...options, env }));
    url.searchParams.set("conversationId", GLOBAL_CONVERSATION_ID);
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${credential.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Seat conversation unavailable (${response.status})`);
    const global = (await response.json()) as { conversationId?: unknown; cwd?: unknown; occupied?: unknown };
    if (global.conversationId !== GLOBAL_CONVERSATION_ID || typeof global.cwd !== "string" || !global.cwd)
      throw new Error("Invalid service seat context");
    // A service that cannot report occupancy keeps the separate-chat behavior.
    if (global.occupied === false) return { conversationId: GLOBAL_CONVERSATION_ID, cwd: global.cwd };
  }
  if (input.conversationId === undefined && input.dryRun) return { cwd: input.cwd, newConversation };
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
