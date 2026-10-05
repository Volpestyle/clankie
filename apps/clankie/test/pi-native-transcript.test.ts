import { expect, test } from "vitest";
import { parseHerdrSeatTranscript } from "@clankie/agent-transcript";

test("native Pi custom-message briefs use original IDs/active ancestry and hide receipt metadata", () => {
  const rows = [
    { type: "session", id: "session" },
    { type: "message", id: "old", parentId: null, message: { role: "user", content: "original" } },
    {
      type: "custom_message",
      id: "abandoned",
      parentId: "old",
      customType: "clankie-worker-message",
      content: "abandoned branch",
      display: true,
    },
    {
      type: "custom_message",
      id: "brief",
      parentId: "old",
      customType: "clankie-worker-message",
      content: "visible brief",
      display: true,
      details: { requestId: "private-receipt-id" },
    },
    {
      type: "custom_message",
      id: "hidden",
      parentId: "brief",
      customType: "background",
      content: "hidden content",
      display: false,
    },
    {
      type: "message",
      id: "answer",
      parentId: "hidden",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    },
  ];
  const result = parseHerdrSeatTranscript("pi", rows.map((row) => JSON.stringify(row)).join("\n"));
  expect(result.map((item) => item.id)).toEqual(["pi:old", "pi:brief", "pi:answer"]);
  expect(JSON.stringify(result)).toContain("visible brief");
  expect(JSON.stringify(result)).not.toMatch(/private-receipt|hidden content|abandoned branch/u);
});
