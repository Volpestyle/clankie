import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { defineChannel, POST, type SendFn } from "eve/channels";
import { extractBearerToken, localDev, routeAuth, type AuthFn } from "eve/channels/auth";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceRequestSchema,
} from "@clankie/protocol";
import { serveOperatorConversationRequest, type OperatorConversationPort } from "@clankie/captain-runtime";
import {
  buildOperatorConversationService,
  eveSessionEvents,
  type CaptainConversationClient,
} from "../../lib/lanes/runtime.ts";

/** The accepted (non-Response) auth context `routeAuth` yields. */
type CaptainRouteAuth = Exclude<Awaited<ReturnType<typeof routeAuth>>, Response>;

/**
 * Stateful authored channel for the operator conversation callable boundary
 * (VUH-769). Each `send` seeds `state.conversationId`; `metadata`/`context`
 * project `captainLane: "operator"` and `captainTargetId: state.conversationId`
 * so the captain resolves the turn to the RIGHT conversation from the channel —
 * not a process-global env var — keeping simultaneous conversations isolated.
 *
 * `POST /operator/v1/dispatch` validates `OperatorConversationServiceRequest` at
 * the edge, is authenticated (custom routes are NOT auto-authenticated), and for
 * `send` builds a request-local service whose executor drives the accepted turn
 * through this channel's own `args.send`. The VUH-864 relay projects the same
 * route to physical devices; it never proxies approval completion.
 */
export interface OperatorChannelState {
  readonly conversationId: string;
}

export function operatorChannelMetadata(state: OperatorChannelState): Readonly<Record<string, unknown>> {
  return { captainLane: "operator", captainTargetId: state.conversationId };
}

/**
 * Captain route auth policy: a shared bearer (`CLANKIE_CAPTAIN_TOKEN`) when
 * configured, else loopback dev access. The captain HTTP endpoint binds
 * loopback; a non-loopback request without the token exhausts the walk and
 * `routeAuth` fails closed with 401. VUH-864's relay authenticates in front.
 */
export function captainRouteAuth(): readonly AuthFn<Request>[] {
  const expected = process.env.CLANKIE_CAPTAIN_TOKEN?.trim();
  return expected === undefined || expected.length === 0 ? [localDev()] : [captainBearerAuth(expected)];
}

function captainBearerAuth(expected: string): AuthFn<Request> {
  return (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    if (token === null) return null;
    const provided = Buffer.from(token);
    const secret = Buffer.from(expected);
    if (provided.length !== secret.length || !timingSafeEqual(provided, secret)) return null;
    return { principalId: "captain-token", principalType: "service" } as CaptainRouteAuth;
  };
}

/** Adapts the authored channel `send` into the per-conversation turn driver. */
export function authoredChannelClient(
  send: SendFn<OperatorChannelState>,
  auth: CaptainRouteAuth,
): CaptainConversationClient {
  return {
    send: async ({ conversationId, message, continuationToken }) => {
      const session = await send(
        { message },
        { auth, continuationToken: continuationToken ?? conversationId, state: { conversationId } },
      );
      return {
        sessionId: session.id,
        continuationToken: session.continuationToken,
        events: (startIndex: number) => eveSessionEvents(session.getEventStream({ startIndex })),
      };
    },
  };
}

/**
 * Dispatches one validated service request against a service. Exported for unit
 * tests (pass a fake `OperatorConversationPort`). `send` acknowledges promptly;
 * `waitUntil` keeps the invocation alive until the detached run settles.
 */
export async function handleOperatorConversationDispatch(
  request: Request,
  service: OperatorConversationPort & { awaitRun?(runId: string): Promise<void> },
  waitUntil?: (task: Promise<unknown>) => void,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = OperatorConversationServiceRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const result = await serveOperatorConversationRequest(service, parsed.data);
  if (
    result.op === "send" &&
    result.result.status === "accepted" &&
    waitUntil !== undefined &&
    service.awaitRun !== undefined
  ) {
    waitUntil(service.awaitRun(result.result.runId));
  }
  return Response.json(result);
}

export default defineChannel<OperatorChannelState>({
  metadata: operatorChannelMetadata,
  context: (state) => ({ metadata: operatorChannelMetadata(state) }),
  routes: [
    POST(OPERATOR_CONVERSATION_DISPATCH_PATH, async (request, args) => {
      const auth = await routeAuth(request, captainRouteAuth());
      if (auth instanceof Response) return auth;
      const service = await buildOperatorConversationService(authoredChannelClient(args.send, auth));
      return handleOperatorConversationDispatch(request, service, args.waitUntil);
    }),
  ],
});
