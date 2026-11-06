import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  CREDENTIAL_ANSWER_PATH,
  CREDENTIAL_DECLINE_PATH,
  CREDENTIAL_REQUESTS_PATH,
  CredentialAnswerSchema,
  CredentialRequestIdSchema,
  type CredentialRequestList,
} from "@clankie/protocol/credential-requests";
import type { CredentialRequests } from "./credential-requests.ts";

interface OwnerWitness {
  readonly current: () => boolean;
  /** Complete synchronous authentication witness; without it the answer is refused. */
  readonly assertCurrent?: () => void;
}

/**
 * The owner's side of sign-in requests (#245): list them, answer one with its
 * values, or decline it. The answer body is the only place a value crosses
 * HTTP; it goes straight to the broker and no response, error or log echoes
 * it. Owner authority, as worker asks.
 */
export function createCredentialRequestRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  requests: CredentialRequests | undefined,
  /**
   * The owner's authority as a synchronous witness (operator credential fence or
   * device registry), taken before the answer body is read. The broker checks it
   * again right before typing, so revoking the owner credential meanwhile stops
   * the fill.
   */
  ownerAuthority: (request: Request) => Promise<OwnerWitness | undefined>,
): Hono {
  const app = new Hono();
  const gate: MiddlewareHandler = async (context, next) => {
    context.header("cache-control", "no-store");
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    if (!requests) return context.json({ error: "credential_requests_unavailable" }, 503);
    await next();
  };
  app.use(CREDENTIAL_REQUESTS_PATH, gate);
  app.use(CREDENTIAL_ANSWER_PATH, gate);
  app.use(CREDENTIAL_DECLINE_PATH, gate);
  app.get(CREDENTIAL_REQUESTS_PATH, (context) => {
    const all = context.req.query("state") === "all";
    const body: CredentialRequestList = {
      schemaVersion: 1,
      requests: requests!.list().filter((request) => all || request.state === "open"),
    };
    return context.json(body);
  });
  // The owner is witnessed before any of the body is read (bodyLimit reads it), so a
  // revocation while the body is pending counts.
  const witness: MiddlewareHandler<{ Variables: { stillOwner: () => boolean } }> = async (context, next) => {
    const owner = await ownerAuthority(context.req.raw);
    const assertCurrent = owner?.assertCurrent;
    if (!owner || !assertCurrent) return context.json({ error: "forbidden" }, 403);
    context.set("stillOwner", () => {
      try {
        assertCurrent();
        return owner.current();
      } catch {
        return false;
      }
    });
    await next();
  };
  app.post(CREDENTIAL_ANSWER_PATH, witness, bodyLimit({ maxSize: 16_384 }), async (context) => {
    const requestId = CredentialRequestIdSchema.safeParse(context.req.param("requestId"));
    // allow-swallowed-rejection -- an unparseable body is refused below as invalid_request.
    const answer = CredentialAnswerSchema.safeParse(await context.req.json().catch(() => undefined));
    // A parse error's message can quote the input, so only its fact is returned.
    if (!requestId.success || !answer.success) return context.json({ error: "invalid_request" }, 400);
    return context.json(await requests!.answer(requestId.data, answer.data, context.get("stillOwner")));
  });
  app.post(CREDENTIAL_DECLINE_PATH, async (context) => {
    const requestId = CredentialRequestIdSchema.safeParse(context.req.param("requestId"));
    if (!requestId.success) return context.json({ error: "invalid_request" }, 400);
    return context.json(await requests!.decline(requestId.data));
  });
  return app;
}
