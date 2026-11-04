import { listLeadWakes, readLeadWake, type CredentialStore } from "@clankie/credential-broker";
import type { HireNotify, WorkerReportKind } from "@clankie/protocol";
import type { LeadWakeResult } from "@clankie/protocol/connector";

// Waking a connected lead (ADR 0336). A lead that runs elsewhere, such as Grok Bot,
// takes jobs at a webhook it made; the owner stored its address and key in the
// credential broker with `clankie connector wake set NAME`. This sends one job there:
// the text and who sent it, nothing else. The address, the key and the webhook's reply
// body never come back out. The lead answers the way connected leads already do, on
// the notes board. Worker report wakes (ADR 0343) carry only service-owned facts and
// the report's done/blocked/update kind (#317); worker text stays in the durable inbox.
// A blocked report wakes the lead at once, outside the batch window. A failed wake is a
// warning and shows on the hire (#735); the inbox keeps the report either way. Update
// outcomes (ADR 0355) go the same way: service-owned facts, never error text. A
// relay start_agent that answered pending wakes its notify lead once it settles (#725),
// so the lead stops polling the startId.

const TIMEOUT_MS = 15_000;
/** Said to the lead with every job, so it knows where an answer is read. */
const REPLY_HINT =
  "Answer with post_note on Clankie's connector; the sender reads the notes board with read_notes.";

interface WorkerWakeEvent {
  readonly agent: string;
  readonly ref: string;
  readonly event: "report" | "settled";
  /** The worker's own done/blocked/update label (#317); a fixed enum, never worker text. */
  readonly kind?: WorkerReportKind;
  readonly at: string;
}

/** How a start_agent that answered pending settled (#725): service facts only, never the brief. */
export interface StartFinishedEvent {
  readonly startId: string;
  readonly ref: string;
  readonly outcome: "started" | "refused";
  /** The new agent's id once it has a pane. */
  readonly agent?: string;
  /** The service's own refusal sentence, as start_agent answers it. */
  readonly reason?: string;
  readonly at: string;
}

const START_REASON_MAX = 300;

type LeadWakeKind = "lead_wake" | "worker_report" | "start_finished" | "board_note" | "update_outcome";

/**
 * Who a wake is from. The service decides it from the caller's credential (#349). An
 * app's own sign-in name is display only and never stands for the owner or Clankie.
 */
export type LeadWakeSender =
  | { readonly kind: "owner" }
  | { readonly kind: "clankie" }
  | { readonly kind: "app"; readonly deviceId: string; readonly name: string };

/** The sender as a lead reads it; an app is always named as an app. */
function senderLabel(sender: LeadWakeSender): string {
  if (sender.kind === "owner") return "the owner";
  if (sender.kind === "clankie") return "clankie";
  return `the app ${JSON.stringify(sender.name)}`;
}

export interface LeadWakes {
  /** The leads with a stored webhook, by name. */
  leads(): Promise<string[]>;
  /** Whether wakes can reach this lead now: its webhook, then its latest wake this boot (#735). */
  state(lead: string): Promise<HireNotify["state"]>;
  /**
   * Tells leads how an update ended: the named lead, and every stored lead while apps
   * lead (ADR 0355). `none` when nobody was to be told, `failed` when nobody took it.
   */
  updateOutcome(input: {
    readonly text: string;
    readonly lead?: string;
    readonly appsLead: boolean;
  }): Promise<"sent" | "none" | "failed">;
  workerReport(lead: string, event: WorkerWakeEvent): void;
  /** Sent at once, outside the report batch window: the lead is waiting on this hire. */
  startFinished(lead: string, event: StartFinishedEvent): void;
  close(): void;
  send(input: {
    readonly lead: string;
    readonly from: LeadWakeSender;
    readonly text: string;
    readonly kind?: LeadWakeKind;
  }): Promise<LeadWakeResult>;
}

export function createLeadWakes(options: {
  readonly store: CredentialStore;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => Date;
  readonly timeoutMs?: number;
  readonly coalesceMs?: number;
  readonly log?: (fields: Record<string, unknown>, message: string) => void;
  readonly warn?: (fields: Record<string, unknown>, message: string) => void;
}): LeadWakes {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const windows = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: WorkerWakeEvent[] }>();
  const coalesceMs = options.coalesceMs ?? 120_000;
  /** Stored leads only: `not_set` is read live, so unknown names can't grow this. */
  const latest = new Map<string, LeadWakeResult["outcome"]>();
  function postReports(lead: string, events: readonly WorkerWakeEvent[]) {
    void wakes
      .send({
        lead,
        from: { kind: "clankie" },
        kind: "worker_report",
        // Blocked reports lead the job, so the lead answers a waiting worker first (#317).
        text: [...events]
          .sort((a, b) => Number(b.kind === "blocked") - Number(a.kind === "blocked"))
          .map(
            ({ agent, ref, event, kind, at }) =>
              `agent=${agent} ref=${ref} event=${event}${kind === undefined ? "" : ` kind=${kind}`} time=${at}\n` +
              `${kind === "blocked" ? "BLOCKED: this worker is waiting on your answer. " : ""}Read with read_reports {"agent":${JSON.stringify(agent)}}.`,
          )
          .join("\n"),
      })
      .then((result) => {
        if (result.outcome !== "sent")
          options.warn?.(
            { lead, outcome: result.outcome },
            "Worker report wake failed; report remains in inbox",
          );
      })
      .catch(() => options.warn?.({ lead }, "Worker report wake failed; report remains in inbox"));
  }
  function startWindow(lead: string) {
    const pending: WorkerWakeEvent[] = [];
    const timer = setTimeout(() => {
      windows.delete(lead);
      if (pending.length) {
        startWindow(lead);
        postReports(lead, pending);
      }
    }, coalesceMs);
    timer.unref();
    windows.set(lead, { timer, pending });
  }
  async function deliver({
    lead,
    from: sender,
    text,
    kind = "lead_wake",
  }: Parameters<LeadWakes["send"]>[0]): Promise<LeadWakeResult> {
    const from = senderLabel(sender);
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
        headers: {
          authorization: webhook.authorization,
          "content-type": "application/json",
          ...(new URL(webhook.url).hostname === "api.anthropic.com"
            ? { "anthropic-version": "2026-10-21" }
            : {}),
        },
        body: JSON.stringify({
          source: "clankie",
          kind,
          lead,
          from,
          sender: sender.kind === "app" ? { kind: "app", deviceId: sender.deviceId } : { kind: sender.kind },
          text,
          sentAt: clock().toISOString(),
          ...(kind === "worker_report" || kind === "start_finished" || kind === "update_outcome"
            ? {}
            : { reply: REPLY_HINT }),
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
    // allow-swallowed-rejection -- the answer is already in hand; a body that won't cancel changes nothing
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
  }
  const wakes: LeadWakes = {
    leads: () => listLeadWakes(options.store),
    workerReport(lead, event) {
      // A blocked worker sits idle until its lead answers: never hold it for the batch window.
      if (event.kind === "blocked") {
        postReports(lead, [event]);
        return;
      }
      const state = windows.get(lead);
      if (state) {
        // One latest fact per agent/ref/event bounds duplicate watch observations.
        const previous = state.pending.findIndex(
          (item) => item.agent === event.agent && item.ref === event.ref && item.event === event.event,
        );
        if (previous >= 0) state.pending[previous] = event;
        else state.pending.push(event);
      } else {
        startWindow(lead);
        postReports(lead, [event]);
      }
    },
    startFinished(lead, { startId, ref, outcome, agent, reason, at }) {
      const read =
        agent === undefined
          ? `Read start_agent {"startId":${JSON.stringify(startId)}}.`
          : `Read read_agent {"agent":${JSON.stringify(agent)}}, or start_agent {"startId":${JSON.stringify(startId)}}.`;
      void wakes
        .send({
          lead,
          from: { kind: "clankie" },
          kind: "start_finished",
          text:
            `start=${startId} ref=${ref} outcome=${outcome}${agent === undefined ? "" : ` agent=${agent}`} time=${at}\n` +
            (reason === undefined
              ? ""
              : `reason=${JSON.stringify(reason.length > START_REASON_MAX ? `${reason.slice(0, START_REASON_MAX - 1)}…` : reason)}\n`) +
            read,
        })
        .then((result) => {
          if (result.outcome !== "sent")
            options.warn?.(
              { lead, outcome: result.outcome },
              "Start finished wake failed; its receipt still answers start_agent",
            );
        })
        .catch(() =>
          options.warn?.({ lead }, "Start finished wake failed; its receipt still answers start_agent"),
        );
    },
    close() {
      for (const state of windows.values()) clearTimeout(state.timer);
      windows.clear();
    },
    async state(lead) {
      let stored;
      try {
        stored = await listLeadWakes(options.store);
      } catch {
        return "unavailable";
      }
      if (!stored.includes(lead)) return "not_set";
      const outcome = latest.get(lead);
      // A webhook stored since its last `not_set` hasn't been tried.
      return outcome === undefined || outcome === "not_set" ? "set" : outcome;
    },
    async updateOutcome({ text, lead, appsLead }) {
      // allow-swallowed-rejection -- an unreadable store is a failed wake, reported below
      const stored = appsLead ? await listLeadWakes(options.store).catch(() => undefined) : [];
      const leads = new Set([...(lead === undefined ? [] : [lead]), ...(stored ?? [])]);
      if (leads.size === 0) return stored === undefined ? "failed" : "none";
      const results = await Promise.all(
        [...leads].map((name) =>
          wakes.send({ lead: name, from: { kind: "clankie" }, kind: "update_outcome", text }),
        ),
      );
      for (const result of results)
        if (result.outcome !== "sent")
          options.warn?.({ lead: result.lead, outcome: result.outcome }, "Update outcome wake failed");
      return results.some((result) => result.outcome === "sent") ? "sent" : "failed";
    },
    async send(input) {
      const result = await deliver(input);
      if (result.outcome !== "not_set") latest.set(input.lead, result.outcome);
      return result;
    },
  };
  return wakes;
}
