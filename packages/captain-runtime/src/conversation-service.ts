import {
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceDispatch,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "@clankie/protocol";
import type { OperatorConversationPort } from "./conversations.ts";

/**
 * Server-side dispatcher for the callable operator conversation contract. This
 * is the boundary the authenticated control plane / VUH-864 relay mounts on its
 * transport; it validates the request and result at the public edge and routes
 * to the captain-owned `OperatorConversationPort`. VUH-864 owns the physical
 * HTTP/NDJSON transport that carries this contract — not this task.
 */
export async function serveOperatorConversationRequest(
  port: OperatorConversationPort,
  requestInput: OperatorConversationServiceRequest,
): Promise<OperatorConversationServiceResult> {
  const request = OperatorConversationServiceRequestSchema.parse(requestInput);
  const result = await routeOperatorConversationRequest(port, request);
  return OperatorConversationServiceResultSchema.parse(result);
}

async function routeOperatorConversationRequest(
  port: OperatorConversationPort,
  request: OperatorConversationServiceRequest,
): Promise<OperatorConversationServiceResult> {
  switch (request.op) {
    case "list": {
      const conversations = await port.list(request.scope);
      return { op: "list", schemaVersion: 1, conversations: [...conversations] };
    }
    case "get": {
      const conversation = await port.get(request.conversationId);
      return { op: "get", schemaVersion: 1, ...(conversation === undefined ? {} : { conversation }) };
    }
    case "create": {
      const conversation = await port.create({ scope: request.scope, title: request.title });
      return { op: "create", schemaVersion: 1, conversation };
    }
    case "replay": {
      const result = await port.replay(request.replay);
      return { op: "replay", schemaVersion: 1, result };
    }
    case "tail": {
      // Single-shot next page. The transport long-polls by re-issuing `tail`
      // with `nextCursor`; the streaming iterable lives in the protocol client.
      const result = await port.replay(request.tail);
      return { op: "tail", schemaVersion: 1, result };
    }
    case "send": {
      const result = await port.send(request.turn);
      return { op: "send", schemaVersion: 1, result };
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unknown operator conversation op ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * A dispatch bound to a local in-process port. Tests and co-located surfaces use
 * this to exercise the exact same request/result contract RN/macOS reach over
 * the relay transport.
 */
export function createLocalOperatorConversationDispatch(
  port: OperatorConversationPort,
): OperatorConversationServiceDispatch {
  return (request) => serveOperatorConversationRequest(port, request);
}
