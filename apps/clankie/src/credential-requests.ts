import { randomBytes } from "node:crypto";
import type {
  CredentialAnswer,
  CredentialAnswerResult,
  CredentialOutcome,
  CredentialRequest,
  CredentialRequestInput,
} from "@clankie/protocol/credential-requests";
import type { CredentialBrowser, CredentialSeal } from "./browser-host.ts";

/** An open request no one answers settles as failed after this long. */
const OPEN_MS = 10 * 60_000;
/** Settled requests stay readable by their worker for this long. */
const KEEP_MS = 60 * 60_000;

interface Entry {
  readonly request: CredentialRequest & { state: CredentialRequest["state"] };
  readonly principalId: string;
  readonly conversation: string;
  readonly fields: CredentialRequestInput["fields"];
  seal?: CredentialSeal | undefined;
  timer?: NodeJS.Timeout | undefined;
  /** Set when the request is withdrawn, replaced or expires while its fill is under way. */
  cancelled?: string | undefined;
}

/** What a worker reads back: pending, or one of the four outcomes. Never a value. */
export type CredentialStatus =
  | { requestId: string; outcome: "pending" }
  | { requestId: string; outcome: CredentialOutcome; reason?: string }
  | { outcome: "not_found" };

export interface CredentialRequests {
  open(principalId: string, requester: string, input: CredentialRequestInput): Promise<CredentialStatus>;
  status(principalId: string, requestId: string): CredentialStatus;
  /** The worker closes its own open request; the tab comes back untouched. */
  withdraw(principalId: string, requestId: string): Promise<CredentialStatus>;
  list(): CredentialRequest[];
  /**
   * Fill with the owner's values. `owner` is the answering owner's authority,
   * read synchronously right before the broker types: false stops the fill.
   */
  answer(requestId: string, answer: CredentialAnswer, owner: () => boolean): Promise<CredentialAnswerResult>;
  decline(requestId: string): Promise<CredentialAnswerResult>;
}

/**
 * The credential broker's request book (#245, ADR 0342). It holds requests in
 * memory only: a restart drops them, and their tabs go with the browser. Values
 * pass straight from `answer` to the browser seal and are never stored, logged
 * or returned.
 */
export function createCredentialRequests(deps: {
  browser: CredentialBrowser | undefined;
  logger: { info(context: Record<string, unknown>, message: string): void };
  now?: () => number;
  openMs?: number;
}): CredentialRequests {
  const entries = new Map<string, Entry>();
  const now = deps.now ?? Date.now;
  const prune = () => {
    for (const [id, entry] of entries)
      if (entry.request.state === "settled" && now() - Date.parse(entry.request.createdAt) > KEEP_MS)
        entries.delete(id);
  };
  const view = (entry: Entry): CredentialRequest => ({ ...entry.request, fields: [...entry.request.fields] });
  const statusOf = (entry: Entry): CredentialStatus =>
    entry.request.state === "settled"
      ? {
          requestId: entry.request.requestId,
          outcome: entry.request.outcome!,
          ...(entry.request.reason ? { reason: entry.request.reason } : {}),
        }
      : { requestId: entry.request.requestId, outcome: "pending" };
  function settle(entry: Entry, outcome: CredentialOutcome, reason?: string) {
    clearTimeout(entry.timer);
    entry.seal = undefined;
    entry.request.state = "settled";
    entry.request.outcome = outcome;
    if (reason) entry.request.reason = reason;
    // The audit line: who asked for which origin, and how it ended. Never a value.
    deps.logger.info(
      {
        event: "credential.request.settled",
        requestId: entry.request.requestId,
        origin: entry.request.origin,
        requester: entry.request.requester,
        outcome,
        ...(reason ? { reason } : {}),
      },
      "credential request settled",
    );
  }
  /** Close an open request without a value: its tab comes back as it was. */
  async function closeOpen(entry: Entry, outcome: CredentialOutcome, reason?: string) {
    // A fill under way stops at its final check and settles itself.
    if (entry.request.state === "filling") entry.cancelled ??= reason ?? outcome;
    if (entry.request.state !== "open") return;
    const seal = entry.seal;
    settle(entry, outcome, reason);
    await seal?.release();
  }
  return {
    async open(principalId, requester, input) {
      prune();
      // A newer request from the same worker for the same browser replaces the old one.
      for (const entry of entries.values())
        if (
          entry.principalId === principalId &&
          entry.conversation === input.conversation &&
          entry.request.state === "open"
        )
          await closeOpen(entry, "failed", "replaced");
      const entry: Entry = {
        principalId,
        conversation: input.conversation,
        fields: input.fields,
        request: {
          requestId: `cr_${randomBytes(16).toString("hex")}`,
          origin: input.origin,
          requester,
          fields: input.fields.map((field) => field.kind),
          state: "open",
          createdAt: new Date(now()).toISOString(),
        },
      };
      entries.set(entry.request.requestId, entry);
      deps.logger.info(
        {
          event: "credential.request.opened",
          requestId: entry.request.requestId,
          origin: input.origin,
          requester,
          fields: entry.request.fields,
        },
        "credential request opened",
      );
      const sealed = deps.browser
        ? await deps.browser.sealForCredential(input.conversation, input.origin)
        : { refused: "browser_unavailable" };
      if ("refused" in sealed) settle(entry, "failed", sealed.refused);
      else {
        entry.seal = sealed;
        entry.timer = setTimeout(() => void closeOpen(entry, "failed", "expired"), deps.openMs ?? OPEN_MS);
        entry.timer.unref();
      }
      return statusOf(entry);
    },
    status(principalId, requestId) {
      const entry = entries.get(requestId);
      return entry?.principalId === principalId ? statusOf(entry) : { outcome: "not_found" };
    },
    async withdraw(principalId, requestId) {
      const entry = entries.get(requestId);
      if (entry?.principalId !== principalId) return { outcome: "not_found" };
      await closeOpen(entry, "failed", "withdrawn");
      return statusOf(entry);
    },
    list() {
      prune();
      return [...entries.values()].map(view);
    },
    async answer(requestId, answer, owner) {
      const entry = entries.get(requestId);
      if (!entry) return { outcome: "refused", reason: "not_found" };
      if (entry.request.state !== "open" || !entry.seal) return { outcome: "refused", reason: "closed" };
      const values: Record<string, string> = {};
      for (const field of entry.fields) {
        const value = answer.values[field.kind];
        if (value === undefined) return { outcome: "refused", reason: "missing_value" };
        values[field.kind] = value;
      }
      if (Object.keys(answer.values).length !== entry.fields.length)
        return { outcome: "refused", reason: "unexpected_value" };
      const seal = entry.seal;
      entry.seal = undefined;
      entry.request.state = "filling";
      clearTimeout(entry.timer);
      // The final check, run synchronously by the broker right before it types: the
      // owner who answered still holds owner authority, and this request is still
      // the open one for its seal.
      const confirm = () =>
        entries.get(requestId) !== entry || entry.request.state !== "filling"
          ? "closed"
          : (entry.cancelled ?? (owner() ? undefined : "owner_unavailable"));
      const filled = await seal.fill(entry.fields, values, confirm);
      if (filled.outcome === "filled") settle(entry, "filled");
      else settle(entry, "failed", filled.reason);
      return { outcome: "settled", request: view(entry) };
    },
    async decline(requestId) {
      const entry = entries.get(requestId);
      if (!entry) return { outcome: "refused", reason: "not_found" };
      if (entry.request.state !== "open") return { outcome: "refused", reason: "closed" };
      await closeOpen(entry, "declined");
      return { outcome: "settled", request: view(entry) };
    },
  };
}
