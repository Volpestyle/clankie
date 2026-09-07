import { FLEET_SEAT_MCP_SERVER } from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  deliverFleetSeatMessage,
  fleetSeatClaudeStartArgs,
  fleetSeatMailbox,
  fleetSeatMcpAddSucceeded,
} from "../src/captain/fleet-seat.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";

describe("fleet seat mailbox", () => {
  it("starts a Claude Code hire with the development-channels flag and no --mcp-config", () => {
    expect(fleetSeatClaudeStartArgs()).toEqual([
      "--dangerously-load-development-channels",
      `server:${FLEET_SEAT_MCP_SERVER}`,
    ]);
  });

  it("treats a second user-scope add as success when the server already exists", () => {
    expect(
      fleetSeatMcpAddSucceeded({
        status: 0,
        stdout: "Added stdio MCP server clankie-seat with command: clankie mcp --seat  to user config",
        stderr: "",
      }),
    ).toBe(true);
    expect(
      fleetSeatMcpAddSucceeded({
        status: 1,
        stdout: "",
        stderr: "MCP server clankie-seat already exists in user config",
      }),
    ).toBe(true);
    expect(fleetSeatMcpAddSucceeded({ status: 1, stdout: "", stderr: "claude: command not found" })).toBe(
      false,
    );
  });

  it("a bound mailbox takes the message and leaves the pty alone", async () => {
    const mailboxes = new Map<string, SeatOutbox>();
    const mailbox = fleetSeatMailbox(mailboxes, "term-potato");
    const pty = vi.fn(() => Promise.resolve(true));
    const parked = mailbox.poll(5_000);
    const sending = deliverFleetSeatMessage(mailboxes, pty, "term-potato", "Please finish the tests", {
      conversationId: "conv-potato",
      source: "operator",
    });
    const [event] = await parked;
    expect(event).toMatchObject({
      kind: "message",
      conversationId: "conv-potato",
      source: "operator",
      content: "Please finish the tests",
    });
    // Take is acked on the next poll, not at dequeue.
    void mailbox.poll(0);
    await expect(sending).resolves.toBe(true);
    expect(pty).not.toHaveBeenCalled();
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
