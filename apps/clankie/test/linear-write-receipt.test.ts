import { expect, it } from "vitest";
import { compactLinearWrite } from "../src/linear-write-receipt.ts";

it("answers a Linear write with a receipt, not the record the writer just sent", () => {
  const description = "x".repeat(5_000);
  const saved = JSON.stringify({
    id: "VUH-1",
    uuid: "u",
    title: "T",
    url: "https://linear.app/x/issue/VUH-1",
    status: "Done",
    description,
    stateHistory: [{ state: "Backlog" }],
    attachments: [{ id: "a1", title: "shot", url: "https://uploads.linear.app/signed?signature=secret" }],
  });
  const receipt = JSON.parse(compactLinearWrite("save_issue", saved)) as Record<string, unknown>;
  expect(receipt).toMatchObject({
    id: "VUH-1",
    title: "T",
    status: "Done",
    attachments: [{ id: "a1", title: "shot" }],
  });
  expect(receipt.description).toContain("(5000 chars saved)");
  expect(JSON.stringify(receipt)).not.toContain("signature");
  expect(receipt.stateHistory).toBeUndefined();
  expect(
    compactLinearWrite(
      "save_comment",
      JSON.stringify({ id: "c", body: "short", author: { name: "Clankie" } }),
    ),
  ).toBe(JSON.stringify({ id: "c", body: "short", author: "Clankie" }));
});

it("leaves reads and non-JSON results alone", () => {
  const listed = JSON.stringify({ issues: [{ id: "VUH-1", description: "x".repeat(500) }] });
  expect(compactLinearWrite("list_issues", listed)).toBe(listed);
  expect(compactLinearWrite("get_issue", listed)).toBe(listed);
  expect(compactLinearWrite("save_issue", "not json")).toBe("not json");
});
