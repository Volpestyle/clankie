import type { DiscordCaptainActionInput } from "@clankie/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordToolProgressReporter, toolProgressCategory } from "../src/captain/discord-tool-progress.ts";

afterEach(() => vi.useRealTimers());

describe("DiscordToolProgressReporter", () => {
  it("delays one content-free card, aggregates calls, and leaves a terminal audit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00.000Z"));
    const calls: DiscordCaptainActionInput[] = [];
    const reporter = new DiscordToolProgressReporter(context, {
      execute: async (input) => {
        calls.push(input);
        return { ok: true, message: "ok", messageId: "card-1" };
      },
    });

    reporter.toolStarted("call-1", "browser_read_secret_page");
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0]).toMatchObject({
      action: "tool_progress",
      phase: "running",
      categories: ["browsing"],
      toolCalls: 1,
      activeToolCalls: 1,
    });
    expect(JSON.stringify(calls[0])).not.toContain("secret_page");

    reporter.toolEnded("call-1", true);
    reporter.toolStarted("call-2", "linear_get_issue");
    reporter.toolEnded("call-2", false);
    await reporter.complete();
    expect(calls.at(-1)).toMatchObject({
      action: "tool_progress",
      progressMessageId: "card-1",
      phase: "completed",
      categories: ["browsing", "using_connected_services"],
      toolCalls: 2,
      activeToolCalls: 0,
      failedToolCalls: 1,
    });
  });

  it("keeps fast and Discord-only tool turns invisible", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(async () => ({ ok: true, message: "ok", messageId: "card-1" }));
    const reporter = new DiscordToolProgressReporter(context, { execute });
    reporter.toolStarted("call-1", "browser_read");
    reporter.toolEnded("call-1", false);
    reporter.toolStarted("call-2", "discord_react");
    reporter.toolEnded("call-2", false);
    await reporter.complete();
    await vi.runAllTimersAsync();
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies local and media work without exposing tool details", () => {
    expect(toolProgressCategory("bash")).toBe("working_locally");
    expect(toolProgressCategory("generate_image")).toBe("creating_media");
    expect(toolProgressCategory("unknown_private_tool")).toBe("using_tools");
  });
});

const context = {
  turnId: "turn-1",
  actorId: "user-1",
  guildId: "guild-1",
  channelId: "channel-1",
  messageId: "message-1",
};
