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

/** `claude mcp add -s user` as the hire path sees it. */
export interface ClaudeMcpResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A second `claude mcp add -s user` exits 1 with "already exists in user
 * config" on stderr; that is success, not a failed hire.
 */
export function fleetSeatMcpAddSucceeded(result: ClaudeMcpResult): boolean {
  if (result.status === 0) return true;
  return /already exists in user config/iu.test(`${result.stdout}\n${result.stderr}`);
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
