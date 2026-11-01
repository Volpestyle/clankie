import { listLeadWakes, readLeadWake, type CredentialStore } from "@clankie/credential-broker";
import type { LeadWakeResult } from "@clankie/protocol/connector";

// Waking a connected lead (ADR 0336). A lead that runs elsewhere, such as Grok Bot,
// takes jobs at a webhook it made; the owner stored its address and key in the
// credential broker with `clankie connector wake set NAME`. This sends one job there:
// the text and who sent it, nothing else. The address, the key and the webhook's reply
// body never come back out. The lead answers the way connected leads already do, on
// the notes board.

const TIMEOUT_MS = 15_000;
/** Said to the lead with every job, so it knows where an answer is read. */
const REPLY_HINT =
  "Answer with post_note on Clankie's connector; the sender reads the notes board with read_notes.";

export interface LeadWakes {
  send(input: {
    readonly lead: string;
    readonly from: string;
    readonly text: string;
  }): Promise<LeadWakeResult>;
}

export function createLeadWakes(options: {
  readonly store: CredentialStore;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  readonly log?: (fields: Record<string, unknown>, message: string) => void;
}): LeadWakes {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());
  return {
    async send({ lead, from, text }) {
      let webhook;
      try {
        webhook = await readLeadWake(options.store, lead);
      } catch {
        return {
          outcome: "unavailable",
          lead,
          message: "Clankie couldn't read the credential store just now.",
        };
      }
      if (webhook === undefined) {
        // allow-swallowed-rejection -- the names are only a hint beside the refusal
        const leads = await listLeadWakes(options.store).catch(() => [] as string[]);
        return {
          outcome: "not_set",
          lead,
          leads: leads.slice(0, 64),
          message:
            leads.length === 0
              ? `No lead has a wake webhook yet. The owner stores one at the Mac with: clankie connector wake set ${lead}`
              : `${lead} has no wake webhook. Leads that do: ${leads.join(", ")}.`,
        };
      }
      const signal = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetchImpl(webhook.url, {
          method: "POST",
          // A webhook that sends the job elsewhere is not followed: the owner named this one.
          redirect: "manual",
          signal,
          headers: { authorization: webhook.authorization, "content-type": "application/json" },
          body: JSON.stringify({
            source: "clankie",
            kind: "lead_wake",
            lead,
            from,
            text,
            sentAt: clock().toISOString(),
            reply: REPLY_HINT,
          }),
        });
      } catch {
        options.log?.({ lead, from }, "Lead wake did not get an answer");
        return {
          outcome: "uncertain",
          lead,
          message: `${lead}'s webhook didn't answer in time. The job may or may not have reached it; check the notes board before sending it again.`,
        };
      }
      // Only the status is read; the body is the lead service's, not anything to pass on.
      void response.body?.cancel().catch(() => undefined);
      options.log?.({ lead, from, status: response.status }, "Lead wake sent");
      if (response.status >= 200 && response.status < 300)
        return {
          outcome: "sent",
          lead,
          status: response.status,
          message: `${lead} has the job. Its answer comes on the notes board; read it with read_notes.`,
        };
      if (response.status < 100)
        return {
          outcome: "refused",
          lead,
          message: `${lead}'s webhook sent the job somewhere else, so it was not taken.`,
        };
      return {
        outcome: "refused",
        lead,
        status: response.status,
        message:
          response.status === 401 || response.status === 403
            ? `${lead}'s webhook turned the key away (${response.status}). The owner stores it again at the Mac with: clankie connector wake set ${lead}`
            : response.status < 400
              ? `${lead}'s webhook sent the job somewhere else (${response.status}), so it was not taken.`
              : `${lead}'s webhook answered ${response.status}, so the job was not taken.`,
      };
    },
  };
}
