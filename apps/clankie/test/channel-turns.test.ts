import { describe, expect, it } from "vitest";
import type { OperatorChannelMember } from "@clankie/protocol";
import {
  channelRoundNotice,
  channelTurnReply,
  nextChannelTurn,
  renderChannelTurnPrompt,
  CHANNEL_TURN_PROMPT_MAX,
} from "../src/captain/channel-turns.ts";

const member = (personaId: string, position: number): OperatorChannelMember => ({
  personaId,
  position,
  joinedAt: "2026-08-30T00:00:00.000Z",
});

const MEMBERS = [member("atlas", 0), member("dev", 1), member("greenhouse", 2)];

describe("nextChannelTurn", () => {
  it("ignores the order members were listed in, honouring position", () => {
    const shuffled = [member("greenhouse", 2), member("atlas", 0), member("dev", 1)];
    expect(nextChannelTurn({ members: shuffled, taken: [] })?.personaId).toBe("atlas");
  });

  it("is deterministic when two members share a position", () => {
    const tied = [member("dev", 0), member("atlas", 0)];
    expect(nextChannelTurn({ members: tied, taken: [] })?.personaId).toBe("atlas");
  });
});

describe("renderChannelTurnPrompt", () => {
  const render = (entries: readonly { personaId?: string; text: string }[]) =>
    renderChannelTurnPrompt({
      title: "atlas slowness",
      member: MEMBERS[1]!,
      members: MEMBERS,
      entries,
      nameOf: (personaId) => personaId,
    });

  it("shows the transcript as it stands, so a member can see its point already made", () => {
    const prompt = render([
      { text: "why is the atlas slow?" },
      { personaId: "atlas", text: "it re-decodes per mount" },
    ]);
    expect(prompt).toContain("you are dev");
    expect(prompt).toContain("members: atlas, dev, greenhouse");
    expect(prompt).toContain("operator: why is the atlas slow?");
    expect(prompt).toContain("atlas: it re-decodes per mount");
    expect(prompt).toContain("PASS");
  });

  it("stays one line, because herdr writes the prompt straight to the pty", () => {
    const prompt = render([{ text: "line one\nline two\r\nline three" }]);
    expect(prompt).not.toMatch(/[\n\r]/u);
    expect(prompt).toContain("line one line two line three");
  });

  it("keeps the newest of an overlong transcript, which is the part being answered", () => {
    const prompt = render([
      { text: "x".repeat(CHANNEL_TURN_PROMPT_MAX) },
      { personaId: "atlas", text: "the freshest thing anyone said" },
    ]);
    expect(prompt.length).toBeLessThanOrEqual(CHANNEL_TURN_PROMPT_MAX + 1);
    expect(prompt).toContain("the freshest thing anyone said");
  });
});

describe("channelTurnReply", () => {
  it("keeps a pass silent and speech intact", () => {
    expect(channelTurnReply("PASS")).toBeUndefined();
    expect(channelTurnReply("  pass\n")).toBeUndefined();
    expect(channelTurnReply("")).toBeUndefined();
    expect(channelTurnReply(undefined)).toBeUndefined();
    expect(channelTurnReply("  the decode path is wrong  ")).toBe("the decode path is wrong");
  });

  it("drops a leading PASS line and publishes the words after it", () => {
    // Seen in Discord verbatim, sentinel and all, on 2026-08-30.
    expect(channelTurnReply("PASS\n\nActually — one correction is worth making.")).toBe(
      "Actually — one correction is worth making.",
    );
    expect(channelTurnReply("pass\nthe decode path is wrong")).toBe("the decode path is wrong");
  });

  it("still treats a pass-shaped sentence as the point it is making", () => {
    expect(channelTurnReply("PASS — but check the decode path")).toBe("PASS — but check the decode path");
  });

  it("stays silent when nothing follows the pass", () => {
    expect(channelTurnReply("PASS\n\n   ")).toBeUndefined();
  });
});

describe("channelRoundNotice", () => {
  it("says nothing when the room answered", () => {
    expect(channelRoundNotice({ spoke: 1, unreachable: ["atlas"], members: 3 })).toBeUndefined();
  });

  it("leaves a room that simply passed as quiet as it was designed to be", () => {
    expect(channelRoundNotice({ spoke: 0, unreachable: [], members: 3 })).toBeUndefined();
  });

  it("names an empty room, because that silence is a fault", () => {
    const notice = channelRoundNotice({ spoke: 0, unreachable: ["atlas", "grove"], members: 2 });
    expect(notice).toContain("No one here has a live seat");
    expect(notice).toContain("atlas and grove");
  });

  it("separates the unreachable from the merely quiet", () => {
    const notice = channelRoundNotice({ spoke: 0, unreachable: ["atlas"], members: 3 });
    expect(notice).toContain("atlas could not be reached");
    expect(notice).toContain("everyone else passed");
  });

  it("bounds the roster it prints", () => {
    const notice = channelRoundNotice({
      spoke: 0,
      unreachable: ["a", "b", "c", "d", "e", "f"],
      members: 6,
    });
    expect(notice).toContain("a, b, c, d and 2 more");
  });
});
