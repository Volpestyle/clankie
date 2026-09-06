/**
 * A fleet seat's mailbox (ADR 0161): a DM or room turn rides a `SeatOutbox` as
 * a channel event while a `clankie mcp --seat` bridge is polling, and falls
 * back to typing into the pane only when it is not.
 */
import { FLEET_SEAT_MCP_SERVER } from "@clankie/protocol";
import { SeatOutbox } from "./seat-outbox.ts";

export interface FleetSeatMessageContext {
  readonly conversationId: string;
  readonly source: string;
}

/**
 * The extra argv a hired Claude Code pane gets after `herdr agent start … --`.
 * `server:` binds a server already in the persisted harness config, not one
 * passed as `--mcp-config`. Other harnesses get nothing.
 */
export function fleetSeatClaudeStartArgs(): readonly string[] {
  return ["--dangerously-load-development-channels", `server:${FLEET_SEAT_MCP_SERVER}`];
}

/** `claude mcp get` as the hire path sees it: non-zero means the server is missing. */
export interface ClaudeMcpGetResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Register `clankie-seat` at user scope only when `claude mcp get` says it is missing. */
export function fleetSeatMcpNeedsRegister(result: ClaudeMcpGetResult): boolean {
  return result.status !== 0;
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
 * Hand a DM or room turn to a bound mailbox; type it into the pane when the
 * seat is not polling (or the delivery did not land as `delivered`).
 */
export async function deliverFleetSeatMessage(
  mailboxes: ReadonlyMap<string, SeatOutbox>,
  sendToPty: (seatId: string, text: string) => Promise<boolean>,
  seatId: string,
  message: string,
  context: FleetSeatMessageContext,
): Promise<boolean> {
  const mailbox = mailboxes.get(seatId);
  if (mailbox?.bound() === true) {
    const delivery = await mailbox.deliver({
      kind: "message",
      conversationId: context.conversationId,
      source: context.source,
      content: message,
      wantsReply: false,
    });
    if (delivery.outcome === "delivered") return true;
  }
  return sendToPty(seatId, message);
}
