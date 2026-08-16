import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { laneKey } from "../src/captain/lane-log.ts";

/** A finished reply, enough of one for pi to flush the session to disk. */
function reply(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

const bash: ToolCall = {
  type: "toolCall",
  id: "call-1",
  name: "bash",
  arguments: { cmd: "herdr pane list" },
};

describe("one-shot discord turn trail", () => {
  it("names the room's trail after the same key the lane log uses", () => {
    expect(laneKey("discord_presence", "866430493889134672:900")).toBe(
      "discord_presence~866430493889134672%3A900",
    );
  });

  it("keeps a tree per turn, with the tools that turn ran", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "clankie-turn-trail-"));
    const dir = join(stateDir, "turns", laneKey("discord_presence", "guild:channel"));

    // Two turns in the same room: same directory, separate trees, and neither
    // continues the other — the one-shot contract, now written down.
    const first = SessionManager.create(stateDir, dir);
    const second = SessionManager.create(stateDir, dir);
    expect(first.getSessionId()).not.toBe(second.getSessionId());

    first.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 });
    first.appendMessage(reply([bash]));
    first.appendMessage({
      role: "toolResult",
      toolCallId: bash.id,
      toolName: bash.name,
      content: [{ type: "text", text: "dev1 dev2" }],
      isError: false,
      timestamp: 0,
    });
    second.appendMessage({ role: "user", content: [{ type: "text", text: "hi again" }], timestamp: 0 });
    second.appendMessage(reply([{ type: "text", text: "hey" }]));

    // The second turn starts empty: nothing carried forward from the first.
    expect(second.buildSessionContext().messages).toHaveLength(2);

    const files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(2);

    const trees = await Promise.all(files.map((name) => readFile(join(dir, name), "utf8")));
    const tools = trees.join("\n").includes('"name":"bash"');
    expect(tools).toBe(true);
  });
});
