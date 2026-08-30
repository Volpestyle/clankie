import { describe, expect, it } from "vitest";
import type { OperatorChannelMember } from "@clankie/protocol";
import {
  channelRoundComplete,
  channelRoundCost,
  channelTurnPrompt,
  isChannelTurnPass,
  nextChannelTurn,
  renderChannelTurnPrompt,
  CHANNEL_TURN_PROMPT_MAX,
  type ChannelTurnRecord,
} from "../src/captain/channel-turns.ts";

const member = (seatId: string, position: number): OperatorChannelMember => ({
  seatId,
  position,
  joinedAt: "2026-08-30T00:00:00.000Z",
});

const MEMBERS = [member("atlas", 0), member("dev", 1), member("greenhouse", 2)];

describe("nextChannelTurn", () => {
  it("offers turns in member order so each can see the one before", () => {
    const taken: ChannelTurnRecord[] = [];
    expect(nextChannelTurn({ members: MEMBERS, taken })?.seatId).toBe("atlas");
    taken.push({ seatId: "atlas", outcome: "spoke" });
    expect(nextChannelTurn({ members: MEMBERS, taken })?.seatId).toBe("dev");
    taken.push({ seatId: "dev", outcome: "passed" });
    expect(nextChannelTurn({ members: MEMBERS, taken })?.seatId).toBe("greenhouse");
  });

  it("ignores the order members were listed in, honouring position", () => {
    const shuffled = [member("greenhouse", 2), member("atlas", 0), member("dev", 1)];
    expect(nextChannelTurn({ members: shuffled, taken: [] })?.seatId).toBe("atlas");
  });

  it("keeps going after someone answers, so a second member can add on", () => {
    const taken: ChannelTurnRecord[] = [{ seatId: "atlas", outcome: "spoke" }];
    expect(nextChannelTurn({ members: MEMBERS, taken })?.seatId).toBe("dev");
  });

  it("never offers a member the turn to answer its own message", () => {
    const next = nextChannelTurn({ members: MEMBERS, taken: [], lastSpeakerSeatId: "atlas" });
    expect(next?.seatId).toBe("dev");
  });

  it("bounds the round at one turn each, so agents cannot loop forever", () => {
    // Without this, two members that each find the other worth replying to
    // would trade messages until something ran out of money.
    const taken: ChannelTurnRecord[] = MEMBERS.map((m) => ({ seatId: m.seatId, outcome: "spoke" as const }));
    expect(nextChannelTurn({ members: MEMBERS, taken })).toBeUndefined();
    expect(channelRoundComplete({ members: MEMBERS, taken })).toBe(true);
  });

  it("is deterministic when two members share a position", () => {
    const tied = [member("dev", 0), member("atlas", 0)];
    expect(nextChannelTurn({ members: tied, taken: [] })?.seatId).toBe("atlas");
  });
});

describe("channelTurnPrompt", () => {
  it("tells a member who already answered, and whether it is first", () => {
    const first = channelTurnPrompt({ members: MEMBERS, taken: [] }, MEMBERS[0]!);
    expect(first).toMatchObject({ seatId: "atlas", spokeBefore: [], firstResponder: true });

    const later = channelTurnPrompt(
      {
        members: MEMBERS,
        taken: [
          { seatId: "atlas", outcome: "spoke" },
          { seatId: "dev", outcome: "passed" },
        ],
      },
      MEMBERS[2]!,
    );
    // A member that passed is not presented as having answered.
    expect(later).toMatchObject({ spokeBefore: ["atlas"], firstResponder: false });
  });
});

describe("channelRoundCost", () => {
  it("charges for every member offered a turn, speaking or not", () => {
    expect(channelRoundCost({ members: MEMBERS, taken: [] })).toBe(3);
    expect(channelRoundCost({ members: MEMBERS, taken: [], lastSpeakerSeatId: "atlas" })).toBe(2);
  });
});

describe("renderChannelTurnPrompt", () => {
  const render = (entries: readonly { seatId?: string; text: string }[]) =>
    renderChannelTurnPrompt({ title: "atlas slowness", member: MEMBERS[1]!, members: MEMBERS, entries });

  it("shows the transcript as it stands, so a member can see its point already made", () => {
    const prompt = render([
      { text: "why is the atlas slow?" },
      { seatId: "atlas", text: "it re-decodes per mount" },
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
      { seatId: "atlas", text: "the freshest thing anyone said" },
    ]);
    expect(prompt.length).toBeLessThanOrEqual(CHANNEL_TURN_PROMPT_MAX + 1);
    expect(prompt).toContain("the freshest thing anyone said");
  });
});

describe("isChannelTurnPass", () => {
  it("recognises a pass however the member cased or padded it", () => {
    expect(isChannelTurnPass("PASS")).toBe(true);
    expect(isChannelTurnPass("  pass\n")).toBe(true);
  });

  it("treats anything a member actually said as speech, pass-shaped or not", () => {
    expect(isChannelTurnPass("PASS — but check the decode path")).toBe(false);
    expect(isChannelTurnPass("")).toBe(false);
  });
});
