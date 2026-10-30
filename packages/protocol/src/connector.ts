import { z } from "zod";
import type { OperatorConversationServiceRequest } from "./operator-service.ts";

// ---------------------------------------------------------------------------
// The Claude connector (ADR 0301): a remote MCP server Claude can add as a
// custom connector to list the owner's agents, read their panes and message
// them. The Mac is the OAuth authorization server; signing in pairs one more
// device, scoped to `connector`. Node-free: the app bundles this index.
// ---------------------------------------------------------------------------

/** The MCP endpoint the relay serves. */
export const CONNECTOR_MCP_PATH = "/mcp";
/** RFC 9728 protected resource metadata for {@link CONNECTOR_MCP_PATH}. */
export const CONNECTOR_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
/** RFC 8414 authorization server metadata. */
export const CONNECTOR_AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
/** RFC 7591 dynamic client registration. */
export const CONNECTOR_REGISTER_PATH = "/oauth/register";
/** The browser page a sign-in opens; it shows the code the owner approves. */
export const CONNECTOR_AUTHORIZE_PATH = "/oauth/authorize";
/** The sign-in page polls this until the owner approves or denies. */
export const CONNECTOR_AUTHORIZE_STATUS_PATH = "/oauth/authorize/status";
export const CONNECTOR_TOKEN_PATH = "/oauth/token";

/** Owner routes: pending sign-ins, and the approve and deny decisions. */
export const CONNECTOR_SIGN_INS_PATH = "/v1/connector/sign-ins";
export const CONNECTOR_SIGN_IN_APPROVE_PATH = "/v1/connector/sign-ins/approve";
export const CONNECTOR_SIGN_IN_DENY_PATH = "/v1/connector/sign-ins/deny";

/**
 * The public origin and path a connector request arrived at, set by this
 * Mac's own gateway connector when it forwards one. Discovery documents name
 * their URLs from it; a caller that sets it only misleads itself.
 */
export const CONNECTOR_PUBLIC_BASE_HEADER = "x-clankie-public-base";

/** Where the hosted Claude apps send a finished sign-in. */
export const CLAUDE_CONNECTOR_CALLBACK_URLS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
] as const;

/** Sign-in codes are short and typed by the owner on another screen. */
export const ConnectorSignInCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/u));

/**
 * Who may receive an approved code: any app's own https callback (Claude,
 * Grok and other hosted MCP clients), or a loopback port on the machine that
 * opened the sign-in page (Claude Code, Codex, MCP Inspector; any port, RFC
 * 8252 section 7.3). The owner's approval on the Mac is the gate, and both the
 * sign-in page and `clankie connector` name the host a code goes to.
 */
export function connectorRedirectUriAllowed(value: string): boolean {
  if ((CLAUDE_CONNECTOR_CALLBACK_URLS as readonly string[]).includes(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) return false;
  // A named public host, so the sign-in page can say where access goes.
  if (url.protocol === "https:") return url.hostname.includes(".") && !/^[\d.]+$|^\[/u.test(url.hostname);
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  );
}

/** The host a sign-in sends its code to, shown to the owner before approving. */
export function connectorRedirectHost(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      ? `${url.hostname} on the computer that opened the sign-in page`
      : url.host;
  } catch {
    return "an unknown address";
  }
}

export const ConnectorSignInSchema = z
  .object({
    code: z.string().min(1),
    clientName: z.string().min(1).max(64),
    redirectHost: z.string().min(1).max(256),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type ConnectorSignIn = z.infer<typeof ConnectorSignInSchema>;

export const ConnectorSignInsResponseSchema = z
  .object({
    /** The URL to add in Claude, when this Mac's doorway is signed in. */
    connectorUrl: z.string().url().max(2_048).optional(),
    signIns: z.array(ConnectorSignInSchema).max(32),
  })
  .strict();
export type ConnectorSignInsResponse = z.infer<typeof ConnectorSignInsResponseSchema>;

export const ConnectorSignInDecisionRequestSchema = z.object({ code: ConnectorSignInCodeSchema }).strict();
export type ConnectorSignInDecisionRequest = z.infer<typeof ConnectorSignInDecisionRequestSchema>;

export const ConnectorSignInDecisionResponseSchema = z
  .object({
    code: z.string().min(1),
    decision: z.enum(["approved", "denied"]),
    clientName: z.string().min(1).max(64),
  })
  .strict();
export type ConnectorSignInDecisionResponse = z.infer<typeof ConnectorSignInDecisionResponseSchema>;

/** Public connector routes and where this Mac serves them. GET/POST only, like the doorway. */
export function connectorRouteTarget(method: string, path: string): "control" | "relay" | undefined {
  const pathname = path.split("?", 1)[0]!;
  if (pathname === CONNECTOR_MCP_PATH) return method === "POST" || method === "GET" ? "relay" : undefined;
  // Discovery documents are read without a body; a query is never part of them.
  // The relay describes its own resource; the service is the authorization server.
  if (
    pathname === CONNECTOR_PROTECTED_RESOURCE_PATH ||
    pathname === `${CONNECTOR_PROTECTED_RESOURCE_PATH}${CONNECTOR_MCP_PATH}`
  )
    return method === "GET" && pathname === path ? "relay" : undefined;
  if (pathname === CONNECTOR_AUTHORIZATION_SERVER_PATH)
    return method === "GET" && pathname === path ? "control" : undefined;
  // The only connector route that carries a query: OAuth puts the request there.
  if (pathname === CONNECTOR_AUTHORIZE_PATH) return method === "GET" ? "control" : undefined;
  if (
    pathname === path &&
    [CONNECTOR_REGISTER_PATH, CONNECTOR_AUTHORIZE_STATUS_PATH, CONNECTOR_TOKEN_PATH].includes(pathname)
  )
    return method === "POST" ? "control" : undefined;
  return undefined;
}

/** A connector route the doorway passes in plaintext, with its own authentication. */
export function isConnectorRoute(method: string, path: string): boolean {
  return connectorRouteTarget(method, path) !== undefined;
}

/**
 * What a connector device may ask the relay, whatever its grants: read the
 * fleet and its panes, and message an agent's own persona thread. A send or a
 * read of one thread is held to persona threads by the relay, which looks the
 * thread up before dispatching; Clankie's own lead thread is never reachable.
 */
export function connectorOperationAllowed(request: OperatorConversationServiceRequest): boolean {
  switch (request.op) {
    case "fleet":
    case "terminal_catalog":
    case "terminal_tail":
    case "terminal_read":
    case "get":
    case "send":
    case "send_receipt":
      return true;
    case "create":
      return request.scope.kind === "persona";
    default:
      return false;
  }
}

/** Ops whose conversation the relay must confirm is a persona thread. */
export function connectorConversationOf(request: OperatorConversationServiceRequest): string | undefined {
  if (request.op === "get") return request.conversationId;
  if (request.op === "send" || request.op === "send_receipt") return request.turn.conversationId;
  return undefined;
}
