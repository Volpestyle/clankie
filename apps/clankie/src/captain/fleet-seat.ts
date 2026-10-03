/**
 * A fleet seat's mailbox (ADR 0161): a DM or room turn rides a `SeatOutbox` as
 * a channel event while a `clankie mcp --seat` bridge is polling. An unavailable
 * or uncertain channel is reported without typing into the owner's pane.
 */
import { SeatOutbox } from "./seat-outbox.ts";

export interface FleetSeatMessageContext {
  readonly conversationId: string;
  readonly source: string;
}

export type FleetSeatDelivery =
  | {
      readonly outcome: "delivered";
      readonly detail?: string;
      readonly messageId?: string;
      readonly state?: "queued" | "started" | "steered";
    }
  | { readonly outcome: "unconfirmed"; readonly detail: string; readonly messageId?: string }
  | { readonly outcome: "undelivered"; readonly detail: string }
  | { readonly outcome: "offline"; readonly detail: string };

/**
 * The extra argv a hired Codex pane gets. A Codex that joins the shared
 * app-server daemon runs its hooks in the daemon's process, not the pane's, so
 * herdr never learns its session (VUH-1398). A seat runs its own server.
 */
export function fleetSeatCodexStartArgs(): readonly string[] {
  return ["--no-daemon"];
}

/**
 * Whether a harness reports its session only once a turn starts, so its brief
 * has to be that first turn for the hire to have an identity. Codex fires
 * `SessionStart` from its turn loop, not at launch.
 */
export function fleetSeatBriefStartsSession(harness: string): boolean {
  return harness === "codex";
}

/**
 * The argv a chosen model becomes on each harness's own CLI (ADR 0185).
 * Undefined means the harness has no wired model flag — a typed failure at
 * hire time, never a silently dropped choice.
 */
export function fleetSeatModelArgs(harness: string, model: string): readonly string[] | undefined {
  switch (harness) {
    case "pi":
    case "claude":
    case "codex":
      return ["--model", model];
    default:
      return undefined;
  }
}

/**
 * The argv a chosen reasoning effort becomes on each harness's own CLI (ADR
 * 0185): pi's `--thinking`, claude's `--effort`, codex's config override (it
 * has no launch flag; the quoted value is what its TOML-style `-c` parses).
 * Undefined means no wired effort flag — a typed failure, as with model.
 */
export function fleetSeatEffortArgs(harness: string, effort: string): readonly string[] | undefined {
  switch (harness) {
    case "pi":
      return ["--thinking", effort];
    case "claude":
      return ["--effort", effort];
    case "codex":
      return ["-c", `model_reasoning_effort="${effort}"`];
    default:
      return undefined;
  }
}

/**
 * The argv a Chrome hire becomes (ADR 0199). Claude's Chrome integration is
 * per session unless its owner turned it on by default; Codex reaches Chrome
 * through its own plugins and config, so it needs nothing. Undefined is a
 * harness with no Chrome integration — a typed failure, never a hire that
 * silently lands without the browser it was hired for.
 */
export function fleetSeatChromeArgs(harness: string): readonly string[] | undefined {
  switch (harness) {
    case "claude":
      return ["--chrome"];
    case "codex":
      return [];
    default:
      return undefined;
  }
}

/** Create the seat's outbox on first poll (or any other first use). */
export function fleetSeatMailbox(mailboxes: Map<string, SeatOutbox>, seatId: string): SeatOutbox {
  const existing = mailboxes.get(seatId);
  if (existing !== undefined) return existing;
  const created = new SeatOutbox();
  mailboxes.set(seatId, created);
  return created;
}

/**
 * Hand a DM or room turn to a bound mailbox and retain its receipt outcome.
 * A missing poller never permits terminal input.
 */
export async function deliverFleetSeatMessage(
  mailboxes: ReadonlyMap<string, SeatOutbox>,
  seatId: string,
  message: string,
  context: FleetSeatMessageContext,
): Promise<FleetSeatDelivery> {
  const mailbox = mailboxes.get(seatId);
  if (mailbox?.bound() === true) {
    const delivery = await mailbox.deliver({
      kind: "message",
      conversationId: context.conversationId,
      source: context.source,
      content: message,
      wantsReply: false,
    });
    if (delivery.outcome === "delivered" || delivery.outcome === "replied") return { outcome: "delivered" };
    if (delivery.outcome === "unconfirmed") return delivery;
    return { outcome: "undelivered", detail: `Seat mailbox delivery was ${delivery.outcome}.` };
  }
  return { outcome: "undelivered", detail: "No seat mailbox is polling; no terminal input was sent." };
}
