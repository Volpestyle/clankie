/**
 * His address on Clankie's own mail service (ADR 0242). A managed body reaches
 * it with its signed host credential; a self-hosted install with its Clankie
 * account. Either way no app password or mail server is involved, and the
 * service enforces the outbound limits, so a refusal here names the limit.
 */
import {
  HOSTED_MAIL_ACCOUNT_PATH,
  HOSTED_MAIL_BODY_PATH,
  HostedMailFolderSchema,
  HostedMailListResultSchema,
  HostedMailReadResultSchema,
  HostedMailSendResultSchema,
  HostedMailStatusResultSchema,
  type HostedMailRefusal,
  type HostedMailRequest,
} from "@clankie/protocol/hosted-mail";
import { hostedOrigin } from "@clankie/protocol/hosted-pairing";
import type { ClankieAccountTokenProvider } from "@clankie/credential-broker";

/** Where a self-hosted install's Clankie account lives unless remote access names another gateway. */
export const DEFAULT_CLANKIE_GATEWAY_URL = "https://api.clankie.bot";

/** One request to the mail service; resolves the decoded JSON answer or throws on transport failure. */
type HostedMailTransport = (request: HostedMailRequest) => Promise<unknown>;

export interface HostedMailbox {
  /** False when this install has neither a hosted body nor a signed-in Clankie account. */
  available(): Promise<boolean>;
  request: HostedMailTransport;
}

/** A managed body: the fleet's signed body route. */
export function bodyMailbox(
  post: (path: string, body: HostedMailRequest) => Promise<Response>,
): HostedMailbox {
  return {
    available: async () => true,
    request: async (request) => decode(await post(HOSTED_MAIL_BODY_PATH, request)),
  };
}

/** A self-hosted install: the same service, authorized by the owner's Clankie account. */
export function accountMailbox(input: {
  readonly gatewayUrl: () => Promise<string>;
  readonly signedIn: () => Promise<boolean>;
  readonly token: ClankieAccountTokenProvider;
  readonly fetch?: typeof fetch;
}): HostedMailbox {
  const fetcher = input.fetch ?? fetch;
  return {
    available: input.signedIn,
    async request(request) {
      const { token } = await input.token();
      return decode(
        await fetcher(`${hostedOrigin(await input.gatewayUrl())}${HOSTED_MAIL_ACCOUNT_PATH}`, {
          method: "POST",
          redirect: "error",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(20_000),
        }),
      );
    },
  };
}

async function decode(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => undefined);
  // The service answers refusals as JSON with a 4xx; anything else is the transport.
  if (body === undefined) throw new Error(`mail service unavailable (${String(response.status)})`);
  // A fleet error rather than a mail answer: who is asking, or whether mail is served at all.
  if (typeof body === "object" && body !== null && !("ok" in body) && "error" in body) {
    if (response.status === 401) return { ok: false, refusal: "sign_in_required" };
    if (response.status === 404) return { ok: false, refusal: "not_provisioned" };
    return { ok: false, refusal: "unavailable" };
  }
  return body;
}

export const hostedMailParsers = {
  status: HostedMailStatusResultSchema,
  list: HostedMailListResultSchema,
  search: HostedMailListResultSchema,
  read: HostedMailReadResultSchema,
  send: HostedMailSendResultSchema,
} as const;

export function hostedFolder(folder: string): "INBOX" | "Sent" | undefined {
  const parsed = HostedMailFolderSchema.safeParse(folder === "inbox" ? "INBOX" : folder);
  return parsed.success ? parsed.data : undefined;
}

/** The service's closed refusal, said the way the mail tools say every other refusal. */
export function describeHostedRefusal(refusal: HostedMailRefusal): {
  reason: "not_configured" | "sign_in_rejected" | "limit_reached" | "recipient_refused" | "provider_error";
  detail: string;
} {
  switch (refusal.refusal) {
    case "not_provisioned":
      return { reason: "not_configured", detail: "this Clankie account has no mailbox yet" };
    case "sign_in_required":
      return {
        reason: "sign_in_rejected",
        detail: "Clankie account sign-in is required for the mailbox — sign in again with clankie login",
      };
    case "limit_reached": {
      const limit = refusal.limit;
      if (limit === undefined) return { reason: "limit_reached", detail: "outbound mail limit reached" };
      const what =
        limit.name === "sends_per_hour"
          ? `hourly send limit (${String(limit.max)} messages an hour)`
          : limit.name === "sends_per_day"
            ? `daily send limit (${String(limit.max)} messages a day)`
            : `daily recipient limit (${String(limit.max)} different recipients a day)`;
      return {
        reason: "limit_reached",
        detail: `${what} reached; the next send can go after ${limit.retryAt}`,
      };
    }
    case "recipient_suppressed":
      return {
        reason: "recipient_refused",
        detail: "that address bounced or reported mail before, so the mail service will not send to it",
      };
    case "not_found":
      return { reason: "provider_error", detail: "no such message" };
    case "malformed":
      return { reason: "provider_error", detail: "the mail service refused the request as malformed" };
    case "unavailable":
      return { reason: "provider_error", detail: "the mail service is unavailable; try again later" };
  }
}
