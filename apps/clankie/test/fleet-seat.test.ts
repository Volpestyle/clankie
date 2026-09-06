import { FLEET_SEAT_MCP_SERVER } from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  deliverFleetSeatMessage,
  fleetSeatClaudeStartArgs,
  fleetSeatMailbox,
} from "../src/captain/fleet-seat.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

describe("fleet seat mailbox", () => {
  it("builds the Claude Code channel argv as one JSON element plus the flag", () => {
    expect(fleetSeatClaudeStartArgs()).toEqual([
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          [FLEET_SEAT_MCP_SERVER]: { command: "clankie", args: ["mcp", "--seat"] },
        },
      }),
      "--dangerously-load-development-channels",
      `server:${FLEET_SEAT_MCP_SERVER}`,
    ]);
    expect(fleetSeatClaudeStartArgs()[1]).toBe(
      '{"mcpServers":{"clankie-seat":{"command":"clankie","args":["mcp","--seat"]}}}',
    );
  });

  it("a bound mailbox takes the message and leaves the pty alone", async () => {
    const mailboxes = new Map<string, SeatOutbox>();
    const mailbox = fleetSeatMailbox(mailboxes, "term-potato");
    const pty = vi.fn(() => Promise.resolve(true));
    const parked = mailbox.poll(5_000);
    await expect(
      deliverFleetSeatMessage(mailboxes, pty, "term-potato", "Please finish the tests", {
        conversationId: "conv-potato",
        source: "operator",
      }),
    ).resolves.toBe(true);
    expect(pty).not.toHaveBeenCalled();
    const [event] = await parked;
    expect(event).toMatchObject({
      kind: "message",
      conversationId: "conv-potato",
      source: "operator",
      content: "Please finish the tests",
    });
  });

  it("an unbound mailbox falls through to the pty sender", async () => {
    const mailboxes = new Map<string, SeatOutbox>();
    const pty = vi.fn(() => Promise.resolve(true));
    await expect(
      deliverFleetSeatMessage(mailboxes, pty, "term-potato", "hello from the room", {
        conversationId: "conv-room",
        source: "room",
      }),
    ).resolves.toBe(true);
    expect(pty).toHaveBeenCalledWith("term-potato", "hello from the room");
  });
});
